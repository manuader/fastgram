/**
 * Los códigos del piloto viven en tres paquetes que no se ven entre sí
 * (`core` decide, `db` guarda, `contracts` publica). Este test es lo que impide
 * que diverjan en silencio: un motivo nuevo en `core` que el contrato no
 * conoce saldría filtrado del resumen sin que nadie lo note.
 */
import {
  AUTOPILOT_HOLD_REASONS as CONTRACT_HOLD,
  AUTOPILOT_REJECT_REASONS as CONTRACT_REJECT,
  AUTOPILOT_RUN_OUTCOMES as CONTRACT_OUTCOMES,
  autopilotPolicySchema,
} from "@fastgram/contracts";
import { AUTOPILOT_HOLD_REASONS, PRECHECK_REJECT_REASONS } from "@fastgram/core";
import { AUTOPILOT_RUN_OUTCOMES } from "@fastgram/db";
import { describe, expect, it } from "vitest";

import { autopilotPolicy } from "./autopilot.js";

describe("códigos del piloto: core, db y contrato", () => {
  it("todo motivo de rechazo de core está en el contrato", () => {
    for (const reason of PRECHECK_REJECT_REASONS) {
      expect(CONTRACT_REJECT as readonly string[]).toContain(reason);
    }
  });

  it("los motivos de espera y los resultados de corrida son los mismos", () => {
    expect([...CONTRACT_HOLD]).toEqual([...AUTOPILOT_HOLD_REASONS]);
    expect([...CONTRACT_OUTCOMES].sort()).toEqual([...AUTOPILOT_RUN_OUTCOMES].sort());
  });

  it("la política que sirve la API cumple su propio contrato", () => {
    expect(autopilotPolicySchema.safeParse(autopilotPolicy()).success).toBe(true);
  });
});
