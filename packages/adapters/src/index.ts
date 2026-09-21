export { systemClock, FixedClock } from "./clock/index.js";
export { systemRng, SeededRng } from "./rng/index.js";

export { MemoryStorage } from "./storage/memory-storage.js";
export { S3Storage, type S3StorageConfig } from "./storage/s3-storage.js";

export {
  StubJudgmentAdapter,
  type ScriptedAnswer,
  type StubJudgmentOptions,
} from "./judgment/stub-judgment.js";
export {
  LlmJudgmentAdapter,
  type LlmJudgmentOptions,
  type RawJudgmentResponse,
} from "./judgment/llm-judgment.js";

export {
  OpenAiCompatibleLlm,
  type FetchLike,
  type OpenAiCompatibleLlmConfig,
} from "./llm/openai-compatible.js";
export { UNTRUSTED_PREAMBLE } from "./llm/untrusted.js";

export {
  createPgBossQueue,
  drizzleTransactionToExecutor,
  PgBossQueue,
  type CreatePgBossQueueOptions,
  type PgBossJobRow,
  type PgBossLike,
  type PgBossQueueConfig,
  type QueueSqlExecutor,
} from "./queue/index.js";

export {
  loopbackPublisher,
  VisionOcr,
  type OcrBytesPublisher,
  type VisionOcrConfig,
} from "./ocr/vision-ocr.js";

export {
  MemoryIdentity,
  type MemoryIdentityOptions,
  type MemoryIdentitySeedUser,
} from "./identity/memory-identity.js";

/**
 * Implementaciones de referencia en memoria de los cinco puertos que no tenían
 * ninguna. Existen para que sus 37 aserciones de contrato corran, y para que
 * `apps/api` y `apps/worker` tengan contra qué testear sin red.
 *
 * **Ninguna describe a un proveedor real**: no hay precios, endpoints,
 * límites, modelos ni latencias. Donde un puerto pide un número, sale de lo
 * que pasó quien llama o de una constante sintética marcada como tal.
 */
export {
  encodeMemorySpeech,
  MemoryAsr,
  type MemoryAsrOptions,
  type MemorySpeech,
  type MemorySpeechSegment,
} from "./asr/memory-asr.js";

export {
  MemoryMediaRenderer,
  type MemoryMediaRendererOptions,
  type MemoryMediaSource,
} from "./media-renderer/memory-media-renderer.js";

export {
  MemoryPayments,
  type MemoryPaymentsOptions,
  type MemoryWebhookPayload,
} from "./payments/memory-payments.js";

export {
  MemorySocialPublisher,
  type MemoryPostMetrics,
  type MemorySocialPublisherOptions,
} from "./social-publisher/memory-social-publisher.js";

export {
  MemorySocialReader,
  type MemorySocialProfile,
  type MemorySocialReaderOptions,
} from "./social-reader/memory-social-reader.js";
