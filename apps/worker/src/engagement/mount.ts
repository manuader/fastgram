/**
 * Cableado de Engagement para `main.ts`: credenciales de la app de Reddit y
 * cifrado locales (`$FASTGRAM_HOME`), el juicio y el LLM del registro de
 * modelos (resueltos en cada job) y la cola.
 *
 * Se monta **siempre**: sin app, sin cuenta o sin modelos, cada job termina
 * con un motivo estable (`no_app`, `not_connected`, `no_judgment`, `no_llm`)
 * en vez de acumularse sin consumidor (trampa 30).
 */
import {
  FileRedditAppStore,
  createLocalOAuthKit,
  redditAppPath,
} from "@fastgram/adapters";
import { JOB_QUEUES } from "@fastgram/core";
import type { Database } from "@fastgram/db";
import type { Clock, JobHandler, Queue } from "@fastgram/ports";

import type { BuildLogger } from "../content/build-handler.js";
import type { LlmSource } from "../llm/registry-llm.js";
import { createEngagementHandlers } from "./handlers.js";
import { createEngagementJudgment } from "./judgment.js";
import { createRedditAccess } from "./reddit.js";

export function mountEngagement(deps: {
  readonly db: Database;
  readonly appRole: string | undefined;
  readonly logger: BuildLogger;
  readonly clock: Clock;
  readonly queue: Queue;
  readonly llmSource: LlmSource;
  readonly env: Readonly<Record<string, string | undefined>>;
}): Readonly<Record<string, JobHandler<unknown>>> {
  const kit = createLocalOAuthKit(deps.env);
  const h = createEngagementHandlers({
    db: deps.db,
    appRole: deps.appRole,
    logger: deps.logger,
    clock: deps.clock,
    queue: deps.queue,
    llmSource: deps.llmSource,
    judgment: createEngagementJudgment({
      llmSource: deps.llmSource,
      db: deps.db,
      appRole: deps.appRole,
      logger: deps.logger,
    }),
    reddit: createRedditAccess({
      db: deps.db,
      appRole: deps.appRole,
      appStore: new FileRedditAppStore({ path: redditAppPath(deps.env) }),
      cipher: kit.cipher,
      clock: deps.clock,
    }),
  });
  return {
    [JOB_QUEUES.redditLeadDiscovery]: h.discovery,
    [JOB_QUEUES.redditThreadMonitoring]: h.monitoring,
    [JOB_QUEUES.banRiskComputation]: h.banRisk,
  };
}
