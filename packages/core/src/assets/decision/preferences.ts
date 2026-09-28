/**
 * Las preferencias aprendidas en el decisor de assets — sprint 9 (T),
 * `PU-S9-015`, `D-22`.
 *
 * El decisor de O puntúa cada candidato con el juicio (encaje con la idea, con
 * la marca, remate) y la relevancia textual, en `[0, 1]`. Acá se le suma el
 * gusto del dueño: los rasgos del candidato (`clip.kind=laugh`,
 * `bg.tone=dark`, `clip.source=library`…) pasan por `scoreCandidate` de Q y
 * el total se **multiplica** por lo que sale.
 *
 * ## Por qué acotado, y cuánto (decisión que el PRD no cubre)
 *
 * `scoreCandidate` devuelve un multiplicador en `[1/16, 16]`: está pensado
 * para **pesos de sorteo** (el mix del refill), donde ×4 es «cuatro veces más
 * probable». Acá multiplica un **puntaje** del juicio, y un ×4 haría ganar a
 * un clip que no tiene nada que ver con la idea sólo porque es del tipo que al
 * dueño le gusta. Lo que el dueño pidió (la idea) manda; el gusto desempata.
 *
 * Por eso se **comprime** el rango entero a `[1/1,5 ; 1,5]` con una potencia
 * (`m ** γ`, `γ = ln 1,5 / ln 16 ≈ 0,146`): conserva el orden de los
 * multiplicadores de Q (dos rasgos que gustan pesan más que uno) y nunca pasa
 * de ±50 %. Con un rasgo en 0,75 (seis aceptaciones sin rechazo) da ×1,16;
 * con dos, ×1,36. Medido contra lo que O midió de Laya: con una idea en
 * castellano los totales de 24 clips quedaron en ~0,45–0,70, así que +16 %
 * mueve un candidato ~0,1 —rompe un casi-empate— pero no salta a uno que el
 * juicio puso claramente arriba.
 *
 * ## La exploración
 *
 * Con probabilidad `settings.exploration` la decisión ignora el gusto (todos
 * ×1), igual que el refill. La tirada la hace quien tiene el `Rng` (el
 * worker) y llega acá como `explored`: esto es puro.
 */
import {
  PREF_MEDIA_SOURCES,
  PREF_MUSIC_SOURCES,
  extractPreferenceFeatures,
  type PrefMediaSource,
  type PrefMusicSource,
  type PreferenceSubject,
} from "../../preferences/features.js";
import {
  PREFERENCE_MULTIPLIER_BOUNDS,
  scoreCandidate,
  type LearnedPreferences,
} from "../../preferences/model.js";
import type { AssetRole } from "./formats.js";
import type { AssetCandidate, AssetKind } from "./types.js";

/** El techo del multiplicador en el decisor. Ver la cabecera. */
export const ASSET_PREFERENCE_MAX = 1.5;

/** `γ` de la compresión: `16 ** γ = 1,5`. */
const GAMMA = Math.log(ASSET_PREFERENCE_MAX) / Math.log(PREFERENCE_MULTIPLIER_BOUNDS.max);

/** Lo que el decisor necesita saber del gusto del dueño para una decisión. */
export interface AssetPreferenceInput {
  readonly prefs: LearnedPreferences;
  /** `true` = salió la tirada de exploración: todos ×1. */
  readonly explored: boolean;
}

const MEDIA_TYPE: Readonly<Record<AssetKind, "image" | "video" | null>> = {
  meme_clip: "video",
  video_clip: "video",
  background_video: "video",
  background_image: "image",
  image: "image",
  audio: null,
  character: null,
};

const mediaSourceOf = (v: string | null): PrefMediaSource | null =>
  v !== null && (PREF_MEDIA_SOURCES as readonly string[]).includes(v)
    ? (v as PrefMediaSource)
    : null;
const musicSourceOf = (v: string | null): PrefMusicSource | null =>
  v !== null && (PREF_MUSIC_SOURCES as readonly string[]).includes(v)
    ? (v as PrefMusicSource)
    : null;

/** Los rasgos de preferencia de un candidato, según el rol que ocupa. */
export function assetPreferenceFeatures(
  candidate: AssetCandidate,
  role: AssetRole,
): string[] {
  const source =
    candidate.source === "library" ? "library" : (candidate.mediaSource ?? null);
  const mediaType = MEDIA_TYPE[candidate.kind];
  // Sin `format`: es el mismo para todos los candidatos de una decisión y no
  // separa a nadie (el formato ya lo sesgó el refill).
  let subject: PreferenceSubject = { format: "" };
  switch (role) {
    case "meme":
    case "video":
      if (mediaType !== null) {
        subject = {
          format: "",
          clip: {
            mediaType,
            source: mediaSourceOf(source),
            tags: candidate.tags ?? [],
          },
        };
      }
      break;
    case "background":
    case "image":
      if (mediaType !== null) {
        subject = {
          format: "",
          background: {
            mediaType,
            source: mediaSourceOf(source),
            tags: candidate.tags ?? [],
          },
        };
      }
      break;
    case "music":
      subject = {
        format: "",
        music: {
          // El id de una pista es de **una** marca: sólo si es de la marca.
          trackId: candidate.source === "brand" ? candidate.id : null,
          source: musicSourceOf(source),
        },
      };
      break;
    case "character":
      subject = { format: "", influencerId: candidate.id };
      break;
  }
  // `extractPreferenceFeatures` descarta todo valor fuera del vocabulario
  // cerrado (un `source` desconocido, un id que no es uuid): nunca inventa.
  return extractPreferenceFeatures(subject);
}

/** Un multiplicador de Q (`[1/16, 16]`) comprimido a `[1/1,5 ; 1,5]`. */
export function compressPreferenceMultiplier(multiplier: number): number {
  if (!(multiplier > 0) || !Number.isFinite(multiplier)) return 1;
  return multiplier ** GAMMA;
}

/**
 * id → multiplicador acotado de cada candidato. Vacío (todos ×1) sin
 * preferencias, con la exploración o con las preferencias apagadas.
 */
export function assetPreferenceMultipliers(
  candidates: readonly AssetCandidate[],
  role: AssetRole,
  input: AssetPreferenceInput | null | undefined,
): ReadonlyMap<string, number> {
  const out = new Map<string, number>();
  if (
    input === null ||
    input === undefined ||
    input.explored ||
    !input.prefs.settings.enabled ||
    input.prefs.features.size === 0
  ) {
    return out;
  }
  for (const c of candidates) {
    const { multiplier } = scoreCandidate(assetPreferenceFeatures(c, role), input.prefs);
    const m = compressPreferenceMultiplier(multiplier);
    if (m !== 1) out.set(c.id, m);
  }
  return out;
}
