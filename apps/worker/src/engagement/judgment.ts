/**
 * El `Judgment` de Engagement — `JV-2` (`DP-002`) y `JV-5` (`DP-003`).
 *
 * Mismo origen que el del piloto (`autopilot/judgment.ts`): el LLM de la
 * tarea `judgment` del registro de modelos (hereda el de `text`), resuelto en
 * cada job, envuelto en `RecordingJudgment` para que cada lote deje su fila en
 * `judgment_records` (`DATA-033`). El sujeto es el lead o la respuesta.
 */
import type { Database } from "@fastgram/db";
import type { Judgment } from "@fastgram/ports";

import type { BuildLogger } from "../content/build-handler.js";
import { judgmentSourceFor } from "../judgment/judgment-source.js";
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
  // Sprint 9 (O, D-18): LLM o SystemOne según el registro (`judgment-source.ts`).
  const source = judgmentSourceFor(deps);
  // `P1-JUDGE-004`: modelo propio de Engagement si lo tiene; si no, `judgment`.
  return async (subject) =>
    (await source.resolve("judgment.engagement", subject))?.judgment ?? null;
}
