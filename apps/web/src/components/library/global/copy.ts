/**
 * Enum del contrato → clave de copy. Los `Record` son **exhaustivos** a
 * propósito (mismo criterio que `FAILURE_COPY_KEYS` en `lib/api/errors.ts`): el
 * día que el contrato sume un tipo, una emoción o un motivo, esto deja de
 * compilar y alguien decide qué lee el usuario.
 */
import type {
  LibraryAspectRatio,
  LibraryAssetKind,
  LibraryAssetStatus,
  LibraryChromaType,
  LibraryEmotion,
  LibraryEnergy,
  LibraryFailureCode,
  LibraryFraming,
  LibraryLicenseType,
  LibraryMemeType,
  LibraryUnimportableReason,
} from "@fastgram/contracts";
import type { CopyKey } from "@/lib/i18n/t";
import type { LibraryFileRejection, LicenseField } from "./api";

export const KIND_COPY: Readonly<Record<LibraryAssetKind, CopyKey>> = {
  green_screen_video: "globalLibrary.kind.green_screen_video",
  background_video: "globalLibrary.kind.background_video",
  background_image: "globalLibrary.kind.background_image",
  image: "globalLibrary.kind.image",
  audio: "globalLibrary.kind.audio",
};

export const STATUS_COPY: Readonly<Record<LibraryAssetStatus, CopyKey>> = {
  processing: "globalLibrary.status.processing",
  ready: "globalLibrary.status.ready",
  failed: "globalLibrary.status.failed",
  hidden: "globalLibrary.status.hidden",
};

export const MEME_TYPE_COPY: Readonly<Record<LibraryMemeType, CopyKey>> = {
  reaction: "globalLibrary.memeType.reaction",
  punchline: "globalLibrary.memeType.punchline",
  transition: "globalLibrary.memeType.transition",
  when_x_happens: "globalLibrary.memeType.when_x_happens",
  overlay_effect: "globalLibrary.memeType.overlay_effect",
  background: "globalLibrary.memeType.background",
  b_roll: "globalLibrary.memeType.b_roll",
  sound_effect: "globalLibrary.memeType.sound_effect",
  music: "globalLibrary.memeType.music",
  other: "globalLibrary.memeType.other",
};

export const EMOTION_COPY: Readonly<Record<LibraryEmotion, CopyKey>> = {
  joy: "globalLibrary.emotion.joy",
  laughter: "globalLibrary.emotion.laughter",
  surprise: "globalLibrary.emotion.surprise",
  shock: "globalLibrary.emotion.shock",
  excitement: "globalLibrary.emotion.excitement",
  pride: "globalLibrary.emotion.pride",
  love: "globalLibrary.emotion.love",
  calm: "globalLibrary.emotion.calm",
  neutral: "globalLibrary.emotion.neutral",
  boredom: "globalLibrary.emotion.boredom",
  confusion: "globalLibrary.emotion.confusion",
  embarrassment: "globalLibrary.emotion.embarrassment",
  sarcasm: "globalLibrary.emotion.sarcasm",
  frustration: "globalLibrary.emotion.frustration",
  anger: "globalLibrary.emotion.anger",
  sadness: "globalLibrary.emotion.sadness",
  fear: "globalLibrary.emotion.fear",
  disgust: "globalLibrary.emotion.disgust",
};

export const FRAMING_COPY: Readonly<Record<LibraryFraming, CopyKey>> = {
  full_body: "globalLibrary.framing.full_body",
  half_body: "globalLibrary.framing.half_body",
  face: "globalLibrary.framing.face",
  object: "globalLibrary.framing.object",
  scene: "globalLibrary.framing.scene",
  none: "globalLibrary.framing.none",
};

export const ENERGY_COPY: Readonly<Record<LibraryEnergy, CopyKey>> = {
  low: "globalLibrary.energy.low",
  medium: "globalLibrary.energy.medium",
  high: "globalLibrary.energy.high",
};

export const CHROMA_COPY: Readonly<Record<LibraryChromaType, CopyKey>> = {
  green: "globalLibrary.chroma.green",
  blue: "globalLibrary.chroma.blue",
  alpha: "globalLibrary.chroma.alpha",
  none: "globalLibrary.chroma.none",
};

export const ASPECT_COPY: Readonly<Record<LibraryAspectRatio, CopyKey>> = {
  "9:16": "globalLibrary.aspect.9_16",
  "16:9": "globalLibrary.aspect.16_9",
  "1:1": "globalLibrary.aspect.1_1",
  "4:5": "globalLibrary.aspect.4_5",
  other: "globalLibrary.aspect.other",
};

export const LICENSE_COPY: Readonly<Record<LibraryLicenseType, CopyKey>> = {
  cc0: "globalLibrary.license.cc0",
  "cc-by": "globalLibrary.license.cc-by",
  pexels: "globalLibrary.license.pexels",
  pixabay: "globalLibrary.license.pixabay",
  own: "globalLibrary.license.own",
  generated: "globalLibrary.license.generated",
};

export const FAILURE_COPY: Readonly<Record<LibraryFailureCode, CopyKey>> = {
  download_failed: "globalLibrary.failure.download_failed",
  too_large: "globalLibrary.failure.too_large",
  too_long: "globalLibrary.failure.too_long",
  unsupported_media: "globalLibrary.failure.unsupported_media",
  normalization_failed: "globalLibrary.failure.normalization_failed",
  invalid_metadata: "globalLibrary.failure.invalid_metadata",
  nsfw_rejected: "globalLibrary.failure.nsfw_rejected",
  source_rate_limited: "globalLibrary.failure.source_rate_limited",
};

export const UNIMPORTABLE_COPY: Readonly<
  Record<LibraryUnimportableReason | "not_found", CopyKey>
> = {
  license_not_accepted: "globalLibrary.unimportable.license_not_accepted",
  license_unverifiable: "globalLibrary.unimportable.license_unverifiable",
  restricted: "globalLibrary.unimportable.restricted",
  too_long: "globalLibrary.unimportable.too_long",
  too_large: "globalLibrary.unimportable.too_large",
  unsupported_media: "globalLibrary.unimportable.unsupported_media",
  not_found: "globalLibrary.unimportable.not_found",
};

export const LICENSE_FIELD_COPY: Readonly<Record<LicenseField, CopyKey>> = {
  type: "globalLibrary.upload.license.type",
  version: "globalLibrary.upload.license.version",
  author: "globalLibrary.upload.license.author",
  attribution: "globalLibrary.upload.license.attribution",
  sourceUrl: "globalLibrary.upload.license.sourceUrl",
  licenseUrl: "globalLibrary.upload.license.licenseUrl",
};

export const FILE_REJECTION_COPY: Readonly<Record<LibraryFileRejection, CopyKey>> = {
  empty: "globalLibrary.upload.file.empty",
  too_large: "globalLibrary.upload.file.tooLarge",
  unsupported_type: "globalLibrary.upload.file.unsupported",
};
