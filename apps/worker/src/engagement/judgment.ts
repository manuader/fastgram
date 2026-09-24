/**
 * El `Judgment` de Engagement — `JV-2` (`DP-002`) y `JV-5` (`DP-003`).
 *
 * Mismo origen que el del piloto (`autopilot/judgment.ts`): el LLM de la
 * tarea `judgment` del registro de modelos (hereda el de `text`), resuelto en
 * cada job, envuelto en `RecordingJudgment` para que cada lote deje su fila en
 * `judgment_records` (`DATA-033`). El sujeto es el lead o la respuesta.
 */
import { LlmJudgmentAdapter, RecordingJudgment } from "@fastgram/adapters";
import { createJudgmentSink, type Database } from "@fastgram/db";
import type { Judgment } from "@fastgram/ports";

import type { BuildLogger } from "../content/build-handler.js";
import type { LlmSource } from "../llm/registry-llm.js";

export type EngagementJudgmentProvider = (subject: {
  readonly companyId: string;
  readonly subjectType: "lead" | "engagement_reply";
  readonly subjectId: string;
}) => Promise<Judgment | null>;

export function createEngagementJudgment(deps: {
  readonly llmSource: LlmSource;
  readonly db: Database;
  readonly appRole: string | undefined;
  readonly logger: BuildLogger;
}): EngagementJudgmentProvider {
  const sink = createJudgmentSink(
    deps.db,
    deps.appRole === undefined ? {} : { role: deps.appRole },
  );
  return async (subject) => {
    // `P1-JUDGE-004`: modelo propio de Engagement si lo tiene; si no, `judgment`.
    const found = await deps.llmSource.current("judgment.engagement");
    if (found === null) return null;
    return new RecordingJudgment(
      new LlmJudgmentAdapter(found.llm, { model: found.config.model }),
      sink,
      subject,
      {
        onError: (error) => {
          deps.logger.warn(
            {
              ...subject,
              reason: error instanceof Error ? error.message : String(error),
            },
            "no se pudo guardar el juicio en judgment_records (la decisión sigue)",
          );
        },
      },
    );
  };
}
