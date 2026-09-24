/**
 * El `Judgment` del piloto — `PU-AUTO-002`, `DP-007` (`JV-3`).
 *
 * ## De dónde sale
 *
 * `LlmJudgmentAdapter` sobre el LLM de la tarea `judgment` del registro de
 * modelos (`PU-MODEL-001`), que hereda el de `text` si no tiene entrada propia
 * (`resolveLlmConfig`). Se resuelve **en cada corrida**: un modelo nuevo en
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
import { LlmJudgmentAdapter, RecordingJudgment } from "@fastgram/adapters";
import {
  AUTOPILOT_PRECHECK_QUESTIONS,
  type PrecheckAnswers,
  type PrecheckOutcome,
} from "@fastgram/core";
import { createJudgmentSink, type Database } from "@fastgram/db";
import { isPortError, type Judgment, type JudgmentState } from "@fastgram/ports";

import type { BuildLogger } from "../content/build-handler.js";
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
  const sink = createJudgmentSink(
    deps.db,
    deps.appRole === undefined ? {} : { role: deps.appRole },
  );
  return async (subject) => {
    const found = await deps.llmSource.current("judgment");
    if (found === null) return null;
    const inner = new LlmJudgmentAdapter(found.llm, { model: found.config.model });
    return new RecordingJudgment(
      inner,
      sink,
      {
        companyId: subject.companyId,
        subjectType: "suggestion",
        subjectId: subject.suggestionId,
      },
      {
        onError: (error) => {
          deps.logger.warn(
            {
              companyId: subject.companyId,
              suggestionId: subject.suggestionId,
              reason: error instanceof Error ? error.message : String(error),
            },
            "no se pudo guardar el juicio en judgment_records (la decisión sigue)",
          );
        },
      },
    );
  };
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
