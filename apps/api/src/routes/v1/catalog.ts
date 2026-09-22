/**
 * Recursos de sólo lectura — `GET /connections`, `GET /warmed-accounts`,
 * `GET /tiktok/sounds`, `GET /audio`.
 *
 * Fuente: PRD §9.3, DATA-016, DATA-012, FR-053, FR-130, F-159, §9.10.
 *
 * ## `GET /audio` es la única ruta de la v1 que lee sin `companyId`
 *
 * No es un descuido: `audio_tracks` es un catálogo **global** (DATA-012, literal del
 * PRD: *"Global, no por workspace"*), no tiene la columna, no tiene política RLS por
 * compañía y su repositorio —`audioTrackRepository`, el único sin scope del sistema—
 * tampoco lleva `TenantScope` en la firma. Si alguna vez aparece otra llamada a datos
 * sin `companyId`, lo probable es que sea un bug y no una segunda excepción: la
 * cabecera de `repositories/catalog.ts` dice qué dos pruebas tiene que pasar.
 */
import {
  WARMED_ACCOUNTS_MAX_VISIBLE,
  listAudioQuerySchema,
  listTiktokSoundsQuerySchema,
} from "@fastgram/contracts";
import {
  audioTrackRepository,
  connectionRepository,
  replacementDecisionRepository,
  warmedAccountRepository,
  warmedSlotBalanceRepository,
} from "@fastgram/db";

import { toAudioTrack, toConnection } from "../../support/serializers.js";
import { crossTenant, data, page } from "./shared.js";
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

  // ── GET /audio ──
  // `for` es **obligatorio** y lo impone el contrato (`listAudioQuerySchema`), no esta
  // ruta. FR-053 observó dos catálogos con nombres de otra naturaleza —archivos
  // (`western.mp3`) en Wall of Text, descripciones (`beat drop`) en Video Hook— y el
  // PRD lo cierra con *"curado por tipo de contenido"*. Sin `for`, la respuesta sería
  // una mezcla que ninguna pantalla del producto muestra: el modal `Select Audio` se
  // abre siempre desde un formato concreto.
  app.get(
    "/audio",
    { schema: { querystring: listAudioQuerySchema } },
    async (request) => {
      const q = request.query;

      // Sin `TenantScope`: ver la cabecera. `request.tx` se usa igual porque es el único
      // camino soportado para hablar con la base desde una ruta, y porque deja la lectura
      // del catálogo en la misma transacción que cualquier otra del request.
      const result = await request.tx((tx) =>
        audioTrackRepository.list(tx, {
          library: q.for,
          limit: q.limit,
          ...(q.cursor === undefined ? {} : { cursor: q.cursor }),
        }),
      );
      return page(result, toAudioTrack);
    },
  );
}
