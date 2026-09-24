/**
 * La estrategia de una marca, leída por el worker — `PU-AUTO-001/002`.
 *
 * La API tiene su propio `loadStrategy` (`apps/api/src/routes/v1/strategy.ts`)
 * con defaults para la marca que nunca guardó. El piloto **no** usa defaults:
 * sólo corre sobre marcas que guardaron una estrategia (el barrido las
 * elige por eso), y una fila que no valida contra el contrato no se
 * "arregla" con el default —que prende Instagram y TikTok— sino que se
 * reporta (`invalid_strategy`). Aprobar y agendar sobre una estrategia que el
 * dueño no escribió sería decidir por él.
 */
import {
  networkStrategySchema,
  postingWindowsSchema,
  type NetworkStrategy,
} from "@fastgram/contracts";
import type { SlotStrategy } from "@fastgram/core";
import type { BrandStrategyRow } from "@fastgram/db";
import { z } from "zod";

export interface AutopilotStrategy {
  readonly autonomy: "manual" | "autopilot";
  readonly language: string;
  readonly networks: readonly NetworkStrategy[];
  readonly slot: SlotStrategy;
}

export function parseAutopilotStrategy(
  row: BrandStrategyRow,
  timezone: string,
): AutopilotStrategy | null {
  const networks = z.array(networkStrategySchema).safeParse(row.networks);
  const windows = postingWindowsSchema.safeParse(row.windows);
  if (!networks.success || !windows.success) return null;
  return {
    autonomy: row.autonomy,
    language: row.language,
    networks: networks.data,
    slot: {
      networks: networks.data,
      windows: windows.data,
      timezone,
      jitterMinutes: row.jitterMinutes,
      brandGapMinutes: row.brandGapMinutes,
    },
  };
}
