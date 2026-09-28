/**
 * Arma el JSON de metadatos de un asset — sprint 9 (agente N).
 *
 * La regla del brief: **lo medible lo pone el código, no el modelo**.
 *
 * | Campo | De dónde sale |
 * |---|---|
 * | `durationSec`, `aspect` | ffprobe del archivo normalizado |
 * | `chroma` (tipo, `keyQuality`, color) | muestras del borde (`measureChromaKey`) o la tag de alfa |
 * | `hasSpeech`, `language` | **no se mide**: ver abajo |
 * | `description`, `memeType`, `emotions`, `useCases`, `characters`, `tags`, `framing`, `energy`, `nsfw` | el modelo de visión, acotado al vocabulario del contrato |
 * | `license` | la fila (verificada por la API contra la fuente, o declarada al subir) |
 *
 * ## Habla
 *
 * Detectar habla exige un ASR (whisper): no está en esta tanda. Lo que sí se
 * mide es si hay audio **audible** (`volumedetect`). Sin audio o en silencio,
 * `hasSpeech: false` es un hecho. Con audio que se oye, `hasSpeech` queda
 * `false` pero el asset sale `needsReview: true` para que el dueño lo confirme
 * en el formulario: mejor pedir una revisión que afirmar algo no medido.
 *
 * ## Sin modelo de visión
 *
 * Queda `ready` con lo medible, `description` vacía, `memeType` por tipo
 * (`background` para un fondo, `other` para el resto), tags sacados del
 * título y `needsReview: true`.
 */
import {
  LIBRARY_EMOTIONS,
  LIBRARY_ENERGY_LEVELS,
  LIBRARY_FRAMINGS,
  LIBRARY_MEME_TYPES,
  LIBRARY_METADATA_SCHEMA_VERSION,
  libraryAssetMetadataSchema,
  type LibraryAssetKind,
  type LibraryAssetMetadata,
  type LibraryLicense,
} from "@fastgram/contracts";
import {
  aspectRatioOf,
  type ChromaMeasurement,
  type LibraryTagProposal,
  type LibraryTaggingVocabulary,
} from "@fastgram/core";

import type { ProbedMedia } from "./media-tools.js";

export const LIBRARY_VOCABULARY: LibraryTaggingVocabulary = {
  memeTypes: LIBRARY_MEME_TYPES,
  emotions: LIBRARY_EMOTIONS,
  // `none` es para audio: no se le ofrece al modelo, que mira cuadros.
  framings: LIBRARY_FRAMINGS.filter((f) => f !== "none"),
  energies: LIBRARY_ENERGY_LEVELS,
};

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "video",
  "file",
  "from",
  "free",
  "copyright",
  "screen",
  "green",
  "webm",
  "ogv",
  "mp4",
  "hd",
  "4k",
  "8k",
  "720p",
  "1080p",
  "h264",
  "vp9",
  "del",
  "los",
  "las",
  "con",
]);

/** Tags a partir del título (texto de la fuente): palabras de ≥ 3 letras, sin ruido. */
export function tagsFromTitle(title: string): string[] {
  const out: string[] = [];
  for (const raw of title.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 3 || STOPWORDS.has(raw) || /^\d+$/.test(raw)) continue;
    if (!out.includes(raw)) out.push(raw.slice(0, 40));
    if (out.length >= 8) break;
  }
  return out;
}

/**
 * El tipo final. La pista del usuario manda si es compatible con lo que se
 * midió; un «green screen» sin croma medido no se puede sostener (el esquema
 * lo rechaza) y cae a `background_video`.
 */
export function decideKind(
  probed: ProbedMedia,
  chroma: ChromaMeasurement,
  hint: LibraryAssetKind | undefined,
): LibraryAssetKind {
  if (probed.mediaType === "audio") return "audio";
  const keyed = probed.hasAlpha || chroma.type !== "none";
  if (probed.mediaType === "video") {
    if (hint === "background_video") return "background_video";
    return keyed ? "green_screen_video" : "background_video";
  }
  if (hint === "image" || hint === "background_image") return hint;
  return "image";
}

export interface MetadataInput {
  readonly kind: LibraryAssetKind;
  readonly title: string;
  readonly probed: ProbedMedia;
  readonly chroma: ChromaMeasurement;
  readonly audible: boolean;
  readonly proposal: LibraryTagProposal | null;
  readonly license: LibraryLicense;
}

export function buildLibraryMetadata(input: MetadataInput): LibraryAssetMetadata {
  const { kind, probed, chroma, proposal } = input;
  const chromaType = probed.hasAlpha ? "alpha" : chroma.type;
  const defaultFraming =
    kind === "audio"
      ? "none"
      : kind === "background_video" || kind === "background_image"
        ? "scene"
        : "object";
  const defaultMeme =
    kind === "background_video" || kind === "background_image" ? "background" : "other";
  const framing =
    kind === "audio"
      ? "none"
      : ((proposal?.framing as LibraryAssetMetadata["framing"] | null | undefined) ??
        defaultFraming);
  const width = probed.width;
  const height = probed.height;
  return {
    schemaVersion: LIBRARY_METADATA_SCHEMA_VERSION,
    kind,
    description: proposal?.description ?? "",
    memeType:
      (proposal?.memeType as LibraryAssetMetadata["memeType"] | undefined) ?? defaultMeme,
    emotions: (proposal?.emotions ?? []) as LibraryAssetMetadata["emotions"],
    useCases: [...(proposal?.useCases ?? [])],
    characters: [...(proposal?.characters ?? [])],
    tags:
      proposal !== null && proposal.tags.length > 0
        ? [...proposal.tags]
        : tagsFromTitle(input.title),
    language: null,
    hasSpeech: false,
    durationSec:
      probed.durationSec === null ? null : Math.round(probed.durationSec * 100) / 100,
    aspect: {
      ratio: aspectRatioOf(width, height) as LibraryAssetMetadata["aspect"]["ratio"],
      width,
      height,
    },
    framing,
    chroma: {
      type: chromaType,
      // Con alfa, lo medido es el borde transparente (ver el handler).
      keyQuality: chroma.keyQuality,
      keyColor: chromaType === "alpha" ? null : chroma.keyColor,
    },
    nsfw: false,
    energy:
      (proposal?.energy as LibraryAssetMetadata["energy"] | null | undefined) ?? "medium",
    needsReview: proposal === null || input.audible,
    license: input.license,
  };
}

export type ValidatedMetadata =
  | { readonly ok: true; readonly metadata: LibraryAssetMetadata }
  | { readonly ok: false; readonly issues: readonly string[] };

/** Valida contra el contrato. Los issues son paths (nunca valores de terceros). */
export function validateLibraryMetadata(candidate: unknown): ValidatedMetadata {
  const parsed = libraryAssetMetadataSchema.safeParse(candidate);
  if (parsed.success) return { ok: true, metadata: parsed.data };
  return {
    ok: false,
    issues: parsed.error.issues.map((i) => i.path.join(".") || "(root)"),
  };
}
