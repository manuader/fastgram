/**
 * Montaje de `reel-planner` — sprint 9 (U), `PU-S9-014`. Se monta siempre: sin
 * marcas con `reel` en el mix de su estrategia, la corrida sólo crea un plan
 * vacío por semana (una fila) y termina.
 *
 * | Variable | Qué |
 * |---|---|
 * | `RENDER_SERVICE_URL`, `RENDER_MEDIA_GRANT_SECRET` | póster y luminancia (sin ellas, reels sin póster y el primer logo) |
 * | `RENDER_REEL_ASR_ENGINE`, `RENDER_REEL_ASR_MODEL` | las mismas del render: si no hay motor con modelo, los reels se planifican sin subtítulos |
 */
import type { Database } from "@fastgram/db";
import type { Clock, JobHandler, Llm, Queue, Rng, Storage } from "@fastgram/ports";

import type { BuildLogger } from "../content/build-handler.js";
import type { AssetJudge } from "../judgment/asset-decider.js";
import { createReelPlannerHandler } from "./planner.js";
import { reelRenderClientFromEnv } from "./render-client.js";

/**
 * ¿Tiene el render con qué transcribir? Misma lectura que `reels/config.ts`
 * del servicio (default `whisper`): whisper necesita `RENDER_REEL_ASR_MODEL`;
 * parakeet trae su modelo; `none` no transcribe.
 */
export function reelCaptionsAvailable(env: Readonly<Record<string, string | undefined>>): boolean {
  const engine = env["RENDER_REEL_ASR_ENGINE"]?.trim() || "whisper";
  if (engine === "parakeet") return true;
  if (engine === "whisper") return (env["RENDER_REEL_ASR_MODEL"]?.trim() ?? "") !== "";
  return false;
}

export function mountReelPlanner(deps: {
  readonly db: Database;
  readonly appRole?: string | undefined;
  readonly logger: BuildLogger;
  readonly clock: Clock;
  readonly rng: Rng;
  readonly queue: Queue;
  readonly storage: Storage;
  readonly textLlm: () => Promise<Llm | null>;
  readonly assetJudge?:
    | ((subject: { companyId: string; subjectType: string; subjectId?: string }) => Promise<AssetJudge | null>)
    | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
}): JobHandler<unknown> {
  return createReelPlannerHandler({
    db: deps.db,
    appRole: deps.appRole,
    logger: deps.logger,
    clock: deps.clock,
    rng: deps.rng,
    queue: deps.queue,
    storage: deps.storage,
    textLlm: deps.textLlm,
    assetJudge: deps.assetJudge,
    render: reelRenderClientFromEnv(deps.env),
    captionsAvailable: reelCaptionsAvailable(deps.env),
  });
}
