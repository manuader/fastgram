/**
 * Generación de imagen y video (`PU-MODEL-003`/`004`) y el estado local de AI
 * Studio (`PU-MODEL-005`, `PU-LATER-005`). Sólo lo que usan la API y el worker:
 * los helpers de HTTP quedan adentro.
 */
export type { GenFetch } from "./http.js";
export type { ImageModelEntry, ModelEntry, VideoModelEntry } from "./spec.js";
export * from "./factory.js";
export {
  AI_STUDIO_DIR_NAME,
  JsonFileCollection,
  JsonFileDocument,
  SPEND_FILE_NAME,
  aiStudioDir,
  spendLedgerPath,
  withFileLock,
  type DocumentUpdate,
} from "./json-files.js";
export { HIGGSFIELD_MODELS } from "../higgsfield/catalog.js";
export { HIGGSFIELD_BASE_URL, HiggsfieldClient } from "../higgsfield/client.js";
export { FAL_MODELS, FLUX_SIZES } from "../fal/catalog.js";
export { FAL_PLATFORM_BASE_URL, FAL_QUEUE_BASE_URL, FalClient } from "../fal/client.js";
// Sprint 8 (agente L): voz, talking avatar y character swap.
export {
  FAL_AVATAR_MODELS,
  FAL_ELEVEN_V3,
  FAL_MINIMAX_SPEECH_HD,
  FAL_MINIMAX_SPEECH_TURBO,
  FAL_OMNIHUMAN_V15,
  FAL_SPEECH_MODELS,
  FAL_SWAP_MODELS,
  FAL_WAN_ANIMATE_REPLACE,
  falVoiceModelIds,
} from "./fal-voice-catalog.js";
export {
  FalVoiceClient,
  SWAP_ASSUMED_FPS,
  parseVoiceResult,
  type FalVoiceClientConfig,
} from "./fal-voice.js";
export {
  COMFYUI_DEFAULT_BASE_URL,
  ComfyUiClient,
  type ComfyFetch,
  type ComfyUiClientConfig,
} from "../comfyui/client.js";
