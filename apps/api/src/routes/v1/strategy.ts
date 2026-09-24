/**
 * Estrategia de publicación por marca — `PU-BRAND-002` · `D-07`, `D-08`, `D-09`
 * (`docs/PLAN-USO-PERSONAL.md` §2 paso 2 y §5).
 *
 *   GET /strategy   la de la marca de la request (header `X-Fastgram-Workspace`)
 *   PUT /strategy   la reemplaza entera
 *
 * ## Sin fila, la por defecto
 *
 * Una marca recién creada no guardó nada y el auto-slot tiene que funcionar
 * igual. `GET` devuelve {@link defaultStrategy} con `isDefault: true`, y el
 * primer `PUT` crea la fila. Los defaults viven acá y no en `DEFAULT`s de
 * columna para que cambiarlos no sea una migración.
 *
 * ## Decisiones que el PRD no cubre (ver el reporte)
 *
 * - **Qué redes vienen prendidas**: Instagram y TikTok, una pieza por día cada
 *   una — las dos primeras de `D-09`. El resto viene apagado.
 * - **Ventanas por defecto**: 09:00, 13:00 y 19:00 todos los días. Son horas
 *   "de oficina" genéricas, no un dato de engagement de nadie.
 * - **Idioma por defecto**: `en`, el de la UI. La marca lo cambia al configurarla.
 * - **La zona horaria es la de la marca** (`companies.timezone`): cambiarla en
 *   la estrategia cambia la de la marca, porque es una sola.
 */
import {
  ANTI_BOT_DAILY_CAP_DEFAULT,
  STRATEGY_BRAND_GAP_MINUTES_DEFAULT,
  STRATEGY_JITTER_MINUTES_DEFAULT,
  STRATEGY_NETWORKS,
  formatMixSchema,
  networkStrategySchema,
  postingWindowsSchema,
  updateStrategyRequestSchema,
  type NetworkStrategy,
  type PostingWindows,
  type Strategy,
} from "@fastgram/contracts";
import {
  brandStrategyRepository,
  type BrandStrategyRow,
  type Executor,
} from "@fastgram/db";
import type { SlotStrategy } from "@fastgram/core";
import { z } from "zod";

import { data } from "./shared.js";
import type { ZodApp } from "../../server/types.js";

const DEFAULT_ON: ReadonlySet<string> = new Set(["instagram", "tiktok"]);
const DEFAULT_TIMES = ["09:00", "13:00", "19:00"] as const;

export const DEFAULT_NETWORKS: readonly NetworkStrategy[] = STRATEGY_NETWORKS.map(
  (network) => ({
    network,
    enabled: DEFAULT_ON.has(network),
    perDay: 1,
    dailyCap: ANTI_BOT_DAILY_CAP_DEFAULT,
  }),
);

export const DEFAULT_WINDOWS: PostingWindows = {
  sun: [...DEFAULT_TIMES],
  mon: [...DEFAULT_TIMES],
  tue: [...DEFAULT_TIMES],
  wed: [...DEFAULT_TIMES],
  thu: [...DEFAULT_TIMES],
  fri: [...DEFAULT_TIMES],
  sat: [...DEFAULT_TIMES],
};

export function defaultStrategy(timezone: string): Strategy {
  return {
    networks: [...DEFAULT_NETWORKS],
    windows: DEFAULT_WINDOWS,
    timezone,
    language: "en",
    autonomy: "manual",
    jitterMinutes: STRATEGY_JITTER_MINUTES_DEFAULT,
    brandGapMinutes: STRATEGY_BRAND_GAP_MINUTES_DEFAULT,
    formatMix: {},
    isDefault: true,
    updatedAt: null,
  };
}

/**
 * La fila → el recurso. Los `jsonb` se vuelven a validar contra el contrato: si
 * una fila vieja o escrita a mano no lo cumple, esa parte cae al default en vez
 * de viajar rota hasta la web (o hasta el auto-slot, que la tomaría en serio).
 */
export function toStrategy(row: BrandStrategyRow, timezone: string): Strategy {
  const networks = z.array(networkStrategySchema).safeParse(row.networks);
  const windows = postingWindowsSchema.safeParse(row.windows);
  const formatMix = formatMixSchema.safeParse(row.formatMix);
  return {
    networks: networks.success ? networks.data : [...DEFAULT_NETWORKS],
    windows: windows.success ? windows.data : DEFAULT_WINDOWS,
    timezone,
    language: row.language,
    autonomy: row.autonomy,
    jitterMinutes: row.jitterMinutes,
    brandGapMinutes: row.brandGapMinutes,
    formatMix: formatMix.success ? formatMix.data : {},
    isDefault: false,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** La estrategia de la marca del scope, guardada o por defecto. */
export async function loadStrategy(exec: Executor, companyId: string): Promise<Strategy> {
  const scope = { companyId };
  // En serie: son dos consultas sobre la misma transacción.
  const row = await brandStrategyRepository.find(exec, scope);
  const timezone = await brandStrategyRepository.timezone(exec, scope);
  // La company del scope existe siempre (la resolvió `auth/scope.ts`); si no se
  // ve, es RLS mal puesto y no un dato: UTC es lo menos sorprendente.
  const zone = timezone ?? "UTC";
  return row === null ? defaultStrategy(zone) : toStrategy(row, zone);
}

/** Lo que `core` necesita para buscar horarios. */
export function toSlotStrategy(strategy: Strategy): SlotStrategy {
  return {
    networks: strategy.networks,
    windows: strategy.windows,
    timezone: strategy.timezone,
    jitterMinutes: strategy.jitterMinutes,
    brandGapMinutes: strategy.brandGapMinutes,
  };
}

export function registerStrategyRoutes(app: ZodApp): void {
  // ── GET /strategy ──
  app.get("/strategy", async (request) => {
    const strategy = await request.tx((tx) => loadStrategy(tx, request.auth.companyId));
    return data(strategy);
  });

  // ── PUT /strategy ──
  app.put(
    "/strategy",
    { schema: { body: updateStrategyRequestSchema } },
    async (request) => {
      const body = request.body;
      const scope = { companyId: request.auth.companyId };

      const strategy = await request.tx(async (tx) => {
        // Las ventanas se guardan ordenadas y sin repetidas: es la forma en que el
        // auto-slot las lee, y así la UI relee lo mismo que va a pasar.
        const windows = Object.fromEntries(
          Object.entries(body.windows).map(([day, times]) => [
            day,
            [...new Set(times)].sort(),
          ]),
        ) as PostingWindows;

        const row = await brandStrategyRepository.save(tx, scope, {
          networks: body.networks,
          windows,
          formatMix: body.formatMix,
          language: body.language,
          autonomy: body.autonomy,
          jitterMinutes: body.jitterMinutes,
          brandGapMinutes: body.brandGapMinutes,
        });
        await brandStrategyRepository.setTimezone(tx, scope, body.timezone);
        return toStrategy(row, body.timezone);
      });
      return data(strategy);
    },
  );
}
