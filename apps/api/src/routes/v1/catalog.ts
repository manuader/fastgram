/**
 * Recursos de sólo lectura — `GET /connections`, `GET /warmed-accounts`,
 * `GET /tiktok/sounds`.
 *
 * Fuente: PRD §9.3, DATA-016, FR-130, F-159, §9.10.
 *
 * ## Qué falta acá y por qué
 *
 * `GET /audio` **no está implementado**, y el motivo no es la escritura: `audio_tracks`
 * es un catálogo **global** (DATA-012, literal del PRD: *"Global, no por workspace"*),
 * así que no tiene `companyId` y por lo tanto **no tiene repositorio** — los 28 son
 * company-scoped por construcción. Hace falta un repositorio de catálogo, sin scope y
 * declarado como tal.
 */
import {
  WARMED_ACCOUNTS_MAX_VISIBLE,
  listTiktokSoundsQuerySchema,
} from "@fastgram/contracts";
import {
  connectionRepository,
  replacementDecisionRepository,
  warmedAccountRepository,
  warmedSlotBalanceRepository,
} from "@fastgram/db";

import { toConnection } from "../../support/serializers.js";
import { crossTenant, data } from "./shared.js";
import type { ZodApp } from "../../server/types.js";

export function registerCatalogRoutes(app: ZodApp): void {
  // ── GET /connections ──
  // El PRD no le define query de paginación y el contrato tampoco: se devuelven
  // todas. Un workspace tiene una conexión por plataforma, no mil.
  app.get("/connections", async (request) => {
    const companyId = request.auth.companyId;
    const result = await request.tx((tx) =>
      connectionRepository.list(tx, { companyId }, { limit: 100 }),
    );
    // `accessToken` y `refreshToken` están cifrados y **nunca se exponen**
    // (DATA-016). `toConnection` no los mapea, así que no hay forma de filtrarlos.
    return data(result.items.map(toConnection));
  });

  // ── GET /warmed-accounts ──
  // PRD:1695 — *"Máximo 100 cuentas visibles, **sin cursor de paginación**"*. Es el
  // único listado de la v1 que no pagina, y su respuesta lleva tres campos extra que
  // el contrato fija.
  app.get("/warmed-accounts", async (request) => {
    const companyId = request.auth.companyId;

    return request.tx(async (tx) => {
      const accounts = await warmedAccountRepository.list(
        tx,
        { companyId },
        { limit: WARMED_ACCOUNTS_MAX_VISIBLE },
      );
      const decisions = await replacementDecisionRepository.list(
        tx,
        { companyId },
        { limit: 100 },
      );
      // `warmedSlotBalances` es 1:1 con la company: su PK **es** el `companyId`.
      const balance = await warmedSlotBalanceRepository.findById(
        tx,
        { companyId },
        companyId,
      );

      // PRD:1695 — el `minLeadTimeMs` global es "el más conservador", es decir el
      // **mayor** de todos: es el único valor con el que un cliente que lo aplique a
      // todas las cuentas no programa nada demasiado pronto para alguna.
      const minLeadTimeMs = accounts.items.reduce(
        (max, a) => (a.minLeadTimeMs > max ? a.minLeadTimeMs : max),
        0,
      );

      return {
        data: accounts.items.map((a) => ({
          warmedAccountId: a.warmedAccountId,
          accountType: "warmed" as const,
          platform: a.platform,
          username: a.username,
          displayName: a.displayName ?? "",
          ...(a.profilePictureUrl === null
            ? {}
            : { profilePictureUrl: a.profilePictureUrl }),
          status: a.status,
          postable: a.postable,
          postingAvailability: a.postingAvailability,
          minLeadTimeMs: a.minLeadTimeMs,
          country: a.country,
          ...(a.niche === null ? {} : { niche: a.niche }),
          keywords: a.keywords,
          ...(a.approvedAt === null ? {} : { approvedAt: a.approvedAt.getTime() }),
          createdAt: a.createdAt.getTime(),
          updatedAt: a.updatedAt.getTime(),
        })),
        replacementDecisions: decisions.items.map((d) => ({
          warmedAccountId: d.warmedAccountId,
          options: (d.options ?? []) as string[],
          status: d.status,
        })),
        slotBalance: balance?.slotBalance ?? 0,
        minLeadTimeMs,
      };
    });
  });

  // ── GET /tiktok/sounds ──
  app.get(
    "/tiktok/sounds",
    { schema: { querystring: listTiktokSoundsQuerySchema } },
    async (request, reply) => {
      const { warmedAccountId } = request.query;
      const companyId = request.auth.companyId;

      // El scope se comprueba **primero y siempre**, aunque después vayamos a
      // devolver 503. Si el 503 saliera antes, este endpoint estaría diciendo
      // "existe" sobre el `warmedAccountId` de otro workspace por omisión.
      const account = await request.tx((tx) =>
        warmedAccountRepository.findById(tx, { companyId }, warmedAccountId),
      );
      if (account === null) {
        throw crossTenant("warmed account", warmedAccountId, companyId);
      }

      // El catálogo de sonidos comerciales viene de la API de TikTok (INT-001) y ese
      // adaptador no existe. No hay tabla local que consultar: devolver `{data: []}`
      // afirmaría "esta cuenta no tiene sonidos disponibles", que es una afirmación
      // distinta y falsa. `service_unavailable` es un código del PRD.
      return reply.status(503).send({
        error: {
          code: "service_unavailable",
          message: "The TikTok sound catalogue is temporarily unavailable.",
        },
      });
    },
  );
}
