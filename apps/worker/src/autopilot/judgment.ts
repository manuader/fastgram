/**
 * El `Judgment` del piloto — `PU-AUTO-002`, `DP-007` (`JV-3`).
 *
 * ## De dónde sale
 *
 * El juicio de la tarea `judgment.autopilot` del registro de modelos (LLM o,
 * desde el sprint 9, un SystemOne: `judgment/judgment-source.ts`) (`PU-MODEL-001`, `P1-JUDGE-004`): sin entrada propia usa
 * la de `judgment`, que a su vez hereda la de `text` (`resolveLlmConfig`). Se resuelve **en cada corrida**: un modelo nuevo en
 * Settings → Models llega a la próxima, sin reiniciar.
 *
 * Envuelto en `RecordingJudgment` con el sink de `judgment_records`
 * (`DATA-033`): cada lote deja su fila con las respuestas, el hash del estado,
 * la latencia y los tokens. Un sink que falla **no** voltea la decisión (lo
 * dice el decorador), se loguea.
 *
 * ## El timeout duro
 *
 * El adaptador ya le pasa `timeoutMs` al `Llm`, pero la promesa de §25.3
 * (*"timeout duro"*) no puede depender de que cada adaptador de `Llm` lo
 * respete. {@link askPrecheck} además corre una carrera contra un reloj propio:
 * pasado el plazo, la pieza queda `held` aunque la llamada siga viva. La
 * respuesta tardía se descarta.
 */
import {
  AUTOPILOT_PRECHECK_QUESTIONS,
  type PrecheckAnswers,
  type PrecheckOutcome,
} from "@fastgram/core";
import type { Database } from "@fastgram/db";
import { isPortError, type Judgment, type JudgmentState } from "@fastgram/ports";

import type { BuildLogger } from "../content/build-handler.js";
import { judgmentSourceFor } from "../judgment/judgment-source.js";
import type { LlmSource } from "../llm/registry-llm.js";

/**
 * El juicio para una sugerencia, o `null` si no hay modelo para `judgment`.
 * El sujeto va en la construcción porque el puerto no lleva `companyId`
 * (ver `RecordingJudgment`).
 */
export type JudgmentProvider = (subject: {
  readonly companyId: string;
  readonly suggestionId: string;
}) => Promise<Judgment | null>;

export function createRegistryJudgment(deps: {
  readonly llmSource: LlmSource;
  readonly db: Database;
  readonly appRole: string | undefined;
  readonly logger: BuildLogger;
}): JudgmentProvider {
  // Sprint 9 (O, D-18): LLM o SystemOne según el registro, siempre con
  // `RecordingJudgment` (`judgment/judgment-source.ts`).
  const source = judgmentSourceFor(deps);
  return async (subject) =>
    // `P1-JUDGE-004`: el modelo del piloto, si tiene uno propio; si no, el de
    // `judgment` (que hereda el de `text`).
    (
      await source.resolve("judgment.autopilot", {
        companyId: subject.companyId,
        subjectType: "suggestion",
        subjectId: subject.suggestionId,
      })
    )?.judgment ?? null;
}

export interface PrecheckRun {
  readonly outcome: PrecheckOutcome;
  readonly latencyMs: number;
  readonly provenance: { readonly adapter: string; readonly model: string };
}

class HardTimeout extends Error {
  override readonly name = "HardTimeout";
}

/** Una llamada al juicio con timeout duro. Nunca lanza: todo fallo es un `PrecheckOutcome`. */
export async function askPrecheck(
  judgment: Judgment,
  state: JudgmentState,
  timeoutMs: number,
  nowMs: () => number = Date.now,
): Promise<PrecheckRun> {
  const started = nowMs();
  const provenance = judgment.provenance;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new HardTimeout());
    }, timeoutMs);
  });
  const call = judgment.ask({
    decisionPoint: "DP-007",
    state,
    questions: AUTOPILOT_PRECHECK_QUESTIONS,
    timeoutMs,
  });
  // La llamada puede terminar después del plazo: su rechazo no tiene que
  // quedar sin manejar.
  call.catch(() => undefined);
  try {
    const { answers } = await Promise.race([call, deadline]);
    return {
      outcome: { kind: "answered", answers: answers as PrecheckAnswers },
      latencyMs: nowMs() - started,
      provenance,
    };
  } catch (error: unknown) {
    const latencyMs = nowMs() - started;
    if (error instanceof HardTimeout) {
      return { outcome: { kind: "timeout" }, latencyMs, provenance };
    }
    if (isPortError(error)) {
      return {
        outcome:
          error.code === "timeout"
            ? { kind: "timeout" }
            : { kind: "unavailable", code: error.code },
        latencyMs,
        provenance,
      };
    }
    // Un bug nuestro o del adaptador: tampoco aprueba. Se reporta como
    // «no disponible» con un código fijo y el mensaje va al log de quien llama.
    return {
      outcome: { kind: "unavailable", code: "unexpected" },
      latencyMs,
      provenance,
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
