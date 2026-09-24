/**
 * Una corrida de un formato con voz o de un character swap — sprint 8
 * (agente L), `P4-FORMAT-002`, `P4-INFL-011`.
 *
 * ```
 *   con voz:  queued ─► voice ─► video ─► building ─► ready
 *   swap:     queued ─────────► video ─► building ─► ready
 *                └──────────┴────────┴──────────┴──► failed | nsfw
 * ```
 *
 * ## Dónde vive y por qué no es una generación de AI Studio
 *
 * Una generación de AI Studio (`GenerationRecord`) es **un** pedido de
 * imagen o video. Esto son dos pedidos encadenados (voz → avatar) con
 * entradas que no son un prompt (un retrato, un audio, un video). Vive al
 * lado, en `~/.fastgram/speaking-runs/<marca>/<id>.json`, y la procesa el
 * mismo worker de `ai-studio-generation` (el payload lleva `speakingRunId`:
 * dos consumidores en una cola se despachan por payload, trampa 63).
 *
 * ## Lo que se guarda para no pagar dos veces
 *
 * Como en AI Studio, ningún pedido aceptado se reenvía: el `request_id` y la
 * URL de estado de **cada** pedido se escriben antes de hacer polling. Una
 * reentrega retoma donde quedó. La voz ya copiada a storage no se vuelve a
 * pedir.
 *
 * ## El gasto: dos entradas en el libro
 *
 * `<id>:voice` y `<id>:video`. Se reservan juntas al empezar (las dos o
 * ninguna) y se cierran por separado: si el avatar falla después de una voz
 * buena, la voz queda cobrada y el avatar liberado. El libro sólo conoce
 * `kind: "image" | "video"` (`genai/budget.ts`): la voz se anota como
 * `video`, porque es parte del video.
 *
 * La pieza **usa el id de la corrida** (`contents.id = run.id`), igual que los
 * formatos de sprint 7: una reentrega la encuentra en vez de duplicarla.
 */
import { isGenerativeFormatId, type GenerativeFormatId } from "./catalog.js";

/** Carpeta de las corridas dentro de `FASTGRAM_HOME` (API escribe, worker lee). */
export const SPEAKING_RUNS_DIR_NAME = "speaking-runs";

export const SPEAKING_RUN_STAGES = [
  "queued",
  "voice",
  "video",
  "building",
  "ready",
  "failed",
  "nsfw",
] as const;
export type SpeakingRunStage = (typeof SPEAKING_RUN_STAGES)[number];

export const SPEAKING_RUN_ERROR_CODES = [
  "nsfw_rejected",
  "generation_failed",
  "provider_unavailable",
  "quota_exceeded",
  "rate_limited",
  "unauthorized",
  "bad_request",
  "not_found",
  "timeout",
  "provider_contract_violation",
  "not_configured",
  "download_failed",
  "budget_exceeded",
  /** La voz salió más larga de lo que el modelo de video acepta. */
  "voice_too_long",
  /** El retrato, el demo o el video de origen ya no están. */
  "input_missing",
  /** No se pudo crear la pieza o encolar su build. */
  "content_failed",
] as const;
export type SpeakingRunErrorCode = (typeof SPEAKING_RUN_ERROR_CODES)[number];

export type SpeakingRunKind = "speaking" | "swap";
/** Quién la pidió: la pantalla del formato o el detalle del modelo (`P4-INFL-011`). */
export type SpeakingRunSource = "studio" | "influencer";

export interface ProviderRequestRef {
  readonly requestId: string;
  readonly statusUrl: string;
  readonly responseUrl: string | null;
}

/** Una media de entrada en nuestro storage. */
export interface SpeakingInputMedia {
  /** `null` = no es del Media Bank (el retrato de un modelo de la biblioteca). */
  readonly mediaId: string | null;
  readonly url: string;
  /** La clave en storage, si se conoce; si no, el worker la saca de la URL. */
  readonly storageKey: string | null;
}

export interface SpeakingRunRecord {
  readonly version: 1;
  /** = id de la pieza. */
  readonly id: string;
  readonly companyId: string;
  readonly kind: SpeakingRunKind;
  readonly formatId: GenerativeFormatId;
  readonly source: SpeakingRunSource;
  /** El modelo de la biblioteca (contrato `GET /character-models`), si hubo. */
  readonly characterModelId: string | null;
  /** Sólo `speaking`. */
  readonly script: string | null;
  /** `""` = sin caption. */
  readonly caption: string;
  readonly languageCode: string | null;
  readonly durationSeconds: number | null;
  readonly voice: { readonly model: string; readonly voiceId: string } | null;
  readonly portrait: SpeakingInputMedia;
  /** El video tuyo que acompaña al avatar (`hook-demo`, `corner-over-demo`). */
  readonly demo: SpeakingInputMedia | null;
  /** Sólo `swap`: el video al que se le cambia el personaje. */
  readonly sourceVideo:
    (SpeakingInputMedia & { readonly durationSeconds: number }) | null;
  /** El modelo de video (OmniHuman o Wan) y su resolución. */
  readonly videoModel: string;
  readonly resolution: string;
  readonly avatarPrompt: string | null;
  readonly provider: string;
  readonly spendMonth: string;
  readonly estimate: {
    readonly voiceUsd: number;
    readonly videoUsd: number;
    readonly usd: number;
    readonly basis: string;
  };
  readonly stage: SpeakingRunStage;
  readonly voiceStep: {
    readonly request: ProviderRequestRef | null;
    readonly storageKey: string | null;
    readonly url: string | null;
    readonly seconds: number | null;
  };
  readonly videoStep: {
    readonly request: ProviderRequestRef | null;
    readonly mediaId: string | null;
    readonly billedSeconds: number | null;
  };
  readonly contentId: string | null;
  readonly error: {
    readonly code: SpeakingRunErrorCode;
    readonly message: string;
  } | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Las claves del libro de gasto de una corrida. */
export function speakingSpendIds(runId: string): { voice: string; video: string } {
  return { voice: `${runId}:voice`, video: `${runId}:video` };
}

export function isTerminalSpeakingStage(stage: SpeakingRunStage): boolean {
  return stage === "ready" || stage === "failed" || stage === "nsfw";
}

/* ------------------------------------------------------------------------ *
 * Parseo defensivo (el archivo es JSON en disco)
 * ------------------------------------------------------------------------ */

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string";
const strOrNull = (v: unknown): v is string | null => v === null || typeof v === "string";
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const numOrNull = (v: unknown): v is number | null => v === null || num(v);

function parseRequest(v: unknown): ProviderRequestRef | null | undefined {
  if (v === null) return null;
  if (!isObj(v) || !str(v["requestId"]) || !str(v["statusUrl"])) return undefined;
  if (!strOrNull(v["responseUrl"])) return undefined;
  return {
    requestId: v["requestId"],
    statusUrl: v["statusUrl"],
    responseUrl: v["responseUrl"],
  };
}

function parseMedia(v: unknown): SpeakingInputMedia | undefined {
  if (!isObj(v) || !str(v["url"]) || !strOrNull(v["mediaId"])) return undefined;
  if (!strOrNull(v["storageKey"])) return undefined;
  return { mediaId: v["mediaId"], url: v["url"], storageKey: v["storageKey"] };
}

export function parseSpeakingRunRecord(value: unknown): SpeakingRunRecord | null {
  if (!isObj(value) || value["version"] !== 1) return null;
  const v = value;
  const formatId = v["formatId"];
  const kind = v["kind"];
  const source = v["source"];
  const stage = v["stage"];
  if (
    !str(v["id"]) ||
    !str(v["companyId"]) ||
    !str(formatId) ||
    !isGenerativeFormatId(formatId) ||
    (kind !== "speaking" && kind !== "swap") ||
    (source !== "studio" && source !== "influencer") ||
    !str(stage) ||
    !(SPEAKING_RUN_STAGES as readonly string[]).includes(stage) ||
    !strOrNull(v["characterModelId"]) ||
    !strOrNull(v["script"]) ||
    !str(v["caption"]) ||
    !strOrNull(v["languageCode"]) ||
    !numOrNull(v["durationSeconds"]) ||
    !str(v["videoModel"]) ||
    !str(v["resolution"]) ||
    !strOrNull(v["avatarPrompt"]) ||
    !str(v["provider"]) ||
    !str(v["spendMonth"]) ||
    !strOrNull(v["contentId"]) ||
    !str(v["createdAt"]) ||
    !str(v["updatedAt"])
  ) {
    return null;
  }
  const voiceRaw = v["voice"];
  let voice: SpeakingRunRecord["voice"] = null;
  if (voiceRaw !== null) {
    if (!isObj(voiceRaw) || !str(voiceRaw["model"]) || !str(voiceRaw["voiceId"])) {
      return null;
    }
    voice = { model: voiceRaw["model"], voiceId: voiceRaw["voiceId"] };
  }
  const portrait = parseMedia(v["portrait"]);
  if (portrait === undefined) return null;
  const demo = v["demo"] === null ? null : parseMedia(v["demo"]);
  if (demo === undefined) return null;
  let sourceVideo: SpeakingRunRecord["sourceVideo"] = null;
  if (v["sourceVideo"] !== null) {
    const m = parseMedia(v["sourceVideo"]);
    const sv = v["sourceVideo"];
    if (m === undefined || !isObj(sv) || !num(sv["durationSeconds"])) return null;
    sourceVideo = { ...m, durationSeconds: sv["durationSeconds"] };
  }
  const est = v["estimate"];
  if (
    !isObj(est) ||
    !num(est["voiceUsd"]) ||
    !num(est["videoUsd"]) ||
    !num(est["usd"]) ||
    !str(est["basis"])
  ) {
    return null;
  }
  const vs = v["voiceStep"];
  const ds = v["videoStep"];
  if (!isObj(vs) || !isObj(ds)) return null;
  const voiceRequest = parseRequest(vs["request"]);
  const videoRequest = parseRequest(ds["request"]);
  if (
    voiceRequest === undefined ||
    videoRequest === undefined ||
    !strOrNull(vs["storageKey"]) ||
    !strOrNull(vs["url"]) ||
    !numOrNull(vs["seconds"]) ||
    !strOrNull(ds["mediaId"]) ||
    !numOrNull(ds["billedSeconds"])
  ) {
    return null;
  }
  let error: SpeakingRunRecord["error"] = null;
  if (v["error"] !== null) {
    const e = v["error"];
    if (
      !isObj(e) ||
      !str(e["message"]) ||
      !str(e["code"]) ||
      !(SPEAKING_RUN_ERROR_CODES as readonly string[]).includes(e["code"])
    ) {
      return null;
    }
    error = { code: e["code"] as SpeakingRunErrorCode, message: e["message"] };
  }
  return {
    version: 1,
    id: v["id"],
    companyId: v["companyId"],
    kind,
    formatId,
    source,
    characterModelId: v["characterModelId"],
    script: v["script"],
    caption: v["caption"],
    languageCode: v["languageCode"],
    durationSeconds: v["durationSeconds"],
    voice,
    portrait,
    demo,
    sourceVideo,
    videoModel: v["videoModel"],
    resolution: v["resolution"],
    avatarPrompt: v["avatarPrompt"],
    provider: v["provider"],
    spendMonth: v["spendMonth"],
    estimate: {
      voiceUsd: est["voiceUsd"],
      videoUsd: est["videoUsd"],
      usd: est["usd"],
      basis: est["basis"],
    },
    stage: stage as SpeakingRunStage,
    voiceStep: {
      request: voiceRequest,
      storageKey: vs["storageKey"],
      url: vs["url"],
      seconds: vs["seconds"],
    },
    videoStep: {
      request: videoRequest,
      mediaId: ds["mediaId"],
      billedSeconds: ds["billedSeconds"],
    },
    contentId: v["contentId"],
    error,
    createdAt: v["createdAt"],
    updatedAt: v["updatedAt"],
  };
}

/* ------------------------------------------------------------------------ *
 * Job
 * ------------------------------------------------------------------------ */

/**
 * Payload en la cola `ai-studio-generation`. Se distingue del de AI Studio
 * (`generationId`) por la clave: trampa 63.
 */
export interface SpeakingRunJob {
  readonly companyId: string;
  readonly speakingRunId: string;
}

export function isSpeakingRunJob(payload: unknown): payload is SpeakingRunJob {
  return (
    isObj(payload) &&
    str(payload["companyId"]) &&
    payload["companyId"] !== "" &&
    str(payload["speakingRunId"]) &&
    payload["speakingRunId"] !== ""
  );
}

export function speakingRunSingletonKey(job: SpeakingRunJob): string {
  return `speaking-run:${job.companyId}:${job.speakingRunId}`;
}
