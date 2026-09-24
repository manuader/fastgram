/**
 * Qué media concreta del Media Bank usa una sugerencia — `AI-002` (entrada
 * «Media Bank del workspace»), `FR-070` (payloads), `FR-100` (categorías),
 * `FR-083` (sets de un influencer).
 *
 * ## Por qué se elige al planificar y no al aceptar
 *
 * Aceptar **cobra** (`FR-050`: 1 save + 1 swipe). Si la media se eligiera al
 * aceptar y no hubiera, el cobro ya estaría hecho, o habría que inventar un
 * rechazo que el usuario no puede prever desde el deck. Eligiéndola acá, una
 * sugerencia que llega a la cola **ya sabe con qué se construye**, y un formato
 * sin media no se planifica (`FR-050`, edge case `422 content_unavailable_for_type`:
 * «tipo válido pero no producible ahora»).
 *
 * ## Qué categoría alimenta a qué rol — la tabla que el PRD no escribe junta
 *
 * `FR-100` da las categorías (imágenes: `slideshow-image`,
 * `green-screen-background`; videos: `background-video`, `hook-video`,
 * `green-screen-video`) y dice que son lo que hace a un asset **elegible para
 * los pools automáticos de Blitz**. No dice qué rol del payload llena cada una;
 * esto es la lectura, con su fuente:
 *
 *  - `slideshow`    → cada slide, una imagen `slideshow-image`.
 *  - `wall-of-text` → `video` = un `background-video`.
 *  - `green-screen` → `image` = un `green-screen-background` (fondo) y `video` =
 *                     un `green-screen-video` («foreground superponible», FR-100).
 *  - `video-hook`   → `demo_video` = un **`hook-video`**, y `hook_video` = un
 *                     **`background-video`**. Es la parte contraintuitiva, y sale
 *                     literal del PRD: §15.8 paso 4 dice «subir `demo video` del
 *                     producto al Media Bank con categoría `hook-video` (habilita
 *                     `video-hook`)», y `FR-083` describe los video sets como
 *                     «Background / hook video source for wall of text and video
 *                     hook». O sea: la categoría `hook-video` es el demo del
 *                     producto, y el clip de arriba sale de los de fondo.
 *
 * ## Lo que no existe y no se inventa
 *
 * **La librería compartida de Fastlane** (`FR-052` tab `Library`, `FR-071`
 * `Theme Images`, y la mitad «shared library» de `ownMediaPercentage`). En el
 * repo no hay una tabla, un bucket ni un endpoint que la contenga — lo dice
 * también `apps/worker/src/content/media-authorization.ts`. Así que **toda**
 * media sale del Media Bank del workspace, y cuando la tirada de
 * `ownMediaPercentage` pide la librería, la explicación lo dice (ver
 * `explainSuggestion`) en vez de fingir que la usó.
 *
 * **El audio**, por la misma razón: `FR-070` dice que sólo puede venir de la
 * librería compartida. Los payloads de Blitz salen **sin bloque `audio`**, que
 * `FR-053.1` define como válido (`No audio`).
 */
import type { ClipTags, Rng } from "@fastgram/ports";
import type { BlitzContentType } from "../content/content.js";
import { HARD_CAPS } from "../quota/plans.js";
import {
  rankByRelevance,
  topMatches,
  type Ranked,
  type RelevanceText,
} from "./relevance.js";

/** `FR-100` — las cinco categorías, con el nombre literal del PRD. */
export const BLITZ_MEDIA_CATEGORIES = {
  slideshowImage: "slideshow-image",
  greenScreenBackground: "green-screen-background",
  backgroundVideo: "background-video",
  hookVideo: "hook-video",
  greenScreenVideo: "green-screen-video",
} as const;

/** Un asset del Media Bank que puede entrar en una pieza: `ready` y no borrado. */
export interface PlanningMedia {
  readonly id: string;
  readonly mediaType: "image" | "video";
  /** La URL canónica guardada en `media.r2Url`. Es la que viaja al payload. */
  readonly url: string;
  readonly categories: readonly string[];
  /**
   * Sprint 7 (`JV-6`): lo que describe al asset para elegirlo por tema. El
   * título es el nombre de archivo (un import lo arma con el título del
   * sitio); las etiquetas, las de `PU-MEME-003` si el clip las tiene. Todo
   * opcional: sin ellas el asset compite igual, con puntaje 0.
   */
  readonly title?: string | null | undefined;
  readonly tags?: ClipTags | null | undefined;
  /** Lo encontró solo «crear desde prompt» (`meme-search.ts`). */
  readonly autoFound?: boolean | undefined;
}

/** El texto de relevancia de un asset: etiquetas del clip y título. */
export function mediaRelevanceText(m: PlanningMedia): RelevanceText {
  return {
    title: m.title?.replace(/\.[A-Za-z0-9]{2,4}$/u, "") ?? null,
    emotion: m.tags?.emotion ?? null,
    situation: m.tags?.situation ?? null,
    tags: m.tags?.tags ?? [],
  };
}

/** El pool ordenado por relevancia al tema (estable: sin tema, igual que entró). */
export function rankMedia(
  topic: string | null | undefined,
  pool: readonly PlanningMedia[],
): readonly Ranked<PlanningMedia>[] {
  return rankByRelevance(topic, pool, mediaRelevanceText);
}

/**
 * La media de los sets de **un** influencer — `FR-083`, `DATA-011`.
 *
 * `images` sale de sus sets `SLIDESHOW` («Image sources for
 * influencer-flavoured slideshows») y `videos` de sus sets `VIDEO`
 * («Background / hook video source for wall of text and video hook»). Los sets
 * `CURATED` no alimentan a Blitz: el PRD no les da rol.
 *
 * Acá **no** se exige categoría: pertenecer al set del personaje ya es la
 * elección explícita del usuario. La categoría es lo que hace elegible a un
 * asset para los pools **automáticos**, que son los del workspace.
 */
export interface InfluencerMediaPool {
  readonly images: readonly PlanningMedia[];
  readonly videos: readonly PlanningMedia[];
}

export interface MediaBank {
  readonly media: readonly PlanningMedia[];
  readonly influencerPools: ReadonlyMap<string, InfluencerMediaPool>;
}

/** Una media elegida: el id para verificarla al aceptar, la URL para el payload. */
export interface MediaRef {
  readonly mediaId: string;
  readonly url: string;
}

export type MediaSelection =
  | {
      readonly format: "slideshow";
      /**
       * Candidatas **en orden de slide**, sin repetir. Son hasta 20
       * (`HARD_CAPS.slidesPerSlideshow`); cuántas quedan lo decide la copy: un
       * slide por texto. Ver `finalizeBuildPlan`.
       */
      readonly slides: readonly MediaRef[];
    }
  | { readonly format: "wall-of-text"; readonly video: MediaRef }
  | {
      readonly format: "green-screen";
      readonly image: MediaRef;
      readonly video: MediaRef;
    }
  | {
      readonly format: "video-hook";
      readonly hookVideo: MediaRef;
      readonly demoVideo: MediaRef;
    };

const ref = (m: PlanningMedia): MediaRef => ({ mediaId: m.id, url: m.url });

function withCategory(
  bank: MediaBank,
  mediaType: PlanningMedia["mediaType"],
  category: string,
): PlanningMedia[] {
  return bank.media.filter(
    (m) => m.mediaType === mediaType && m.categories.includes(category),
  );
}

/** Los pools de cada rol para un formato, del workspace o del influencer. */
interface RolePools {
  readonly slides?: readonly PlanningMedia[];
  readonly video?: readonly PlanningMedia[];
  readonly image?: readonly PlanningMedia[];
  readonly hookVideo?: readonly PlanningMedia[];
  readonly demoVideo?: readonly PlanningMedia[];
}

function workspacePools(bank: MediaBank, format: BlitzContentType): RolePools {
  const c = BLITZ_MEDIA_CATEGORIES;
  switch (format) {
    case "slideshow":
      return { slides: withCategory(bank, "image", c.slideshowImage) };
    case "wall-of-text":
      return { video: withCategory(bank, "video", c.backgroundVideo) };
    case "green-screen":
      return {
        image: withCategory(bank, "image", c.greenScreenBackground),
        video: withCategory(bank, "video", c.greenScreenVideo),
      };
    case "video-hook":
      return {
        hookVideo: withCategory(bank, "video", c.backgroundVideo),
        demoVideo: withCategory(bank, "video", c.hookVideo),
      };
  }
}

/**
 * Los pools con influencer. El **demo** del `video-hook` sigue saliendo del
 * workspace: es el video del producto, no del personaje.
 * `green-screen` no tiene versión con influencer (`FR-055` regla 5).
 */
function influencerPools(
  bank: MediaBank,
  pool: InfluencerMediaPool,
  format: BlitzContentType,
): RolePools | null {
  switch (format) {
    case "slideshow":
      return { slides: pool.images };
    case "wall-of-text":
      return { video: pool.videos };
    case "video-hook":
      return {
        hookVideo: pool.videos,
        demoVideo: withCategory(bank, "video", BLITZ_MEDIA_CATEGORIES.hookVideo),
      };
    case "green-screen":
      return null;
  }
}

/**
 * ¿Alcanzan los pools? `video-hook` necesita dos videos **distintos**: el mismo
 * archivo arriba y abajo no es un hook con demo.
 */
function covers(pools: RolePools, format: BlitzContentType): boolean {
  const some = (p: readonly PlanningMedia[] | undefined): boolean =>
    p !== undefined && p.length > 0;
  switch (format) {
    case "slideshow":
      return some(pools.slides);
    case "wall-of-text":
      return some(pools.video);
    case "green-screen":
      return some(pools.image) && some(pools.video);
    case "video-hook": {
      if (!some(pools.demoVideo) || !some(pools.hookVideo)) return false;
      const demos = new Set((pools.demoVideo ?? []).map((m) => m.id));
      // Hace falta un par distinto: alcanza con que haya dos ids en la unión y
      // cada rol tenga alguno. El caso que falla es «un único video con las dos
      // categorías».
      return (pools.hookVideo ?? []).some((h) => !demos.has(h.id) || demos.size > 1);
    }
  }
}

/** Los formatos que el Media Bank del workspace puede construir hoy. */
export function formatsWithMedia(bank: MediaBank): readonly BlitzContentType[] {
  const all: readonly BlitzContentType[] = [
    "slideshow",
    "wall-of-text",
    "green-screen",
    "video-hook",
  ];
  return all.filter((f) => covers(workspacePools(bank, f), f));
}

/** ¿Los sets de este influencer alcanzan para el formato? */
export function influencerCoversFormat(
  bank: MediaBank,
  influencerId: string,
  format: BlitzContentType,
): boolean {
  const pool = bank.influencerPools.get(influencerId);
  if (pool === undefined) return false;
  const pools = influencerPools(bank, pool, format);
  return pools !== null && covers(pools, format);
}

/**
 * Sprint 7: con tema, se sortea **entre los que mejor le corresponden**; sin
 * tema o sin ninguno que matchee, entre todos, como antes. Consume una sola
 * tirada en los dos casos, así que un seed viejo sin tema da lo mismo.
 */
function pickRelevant(
  rng: Rng,
  pool: readonly PlanningMedia[],
  topic: string | null | undefined,
): PlanningMedia {
  const best =
    topic === null || topic === undefined ? [] : topMatches(rankMedia(topic, pool));
  return pickOne(rng, best.length > 0 ? best : pool);
}

function pickOne(rng: Rng, pool: readonly PlanningMedia[]): PlanningMedia {
  const chosen = pool[rng.nextInt(0, pool.length)];
  if (chosen === undefined) throw new Error("pickOne sobre un pool vacío");
  return chosen;
}

/** Fisher–Yates con el `Rng` inyectado: reproducible con un seed. */
function shuffled(rng: Rng, pool: readonly PlanningMedia[]): PlanningMedia[] {
  const out = [...pool];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = rng.nextInt(0, i + 1);
    const a = out[i] as PlanningMedia;
    out[i] = out[j] as PlanningMedia;
    out[j] = a;
  }
  return out;
}

/**
 * Elige la media concreta. `null` si los pools no alcanzan — quien llama tiene
 * que haber filtrado antes con {@link formatsWithMedia} o
 * {@link influencerCoversFormat}; `null` acá es la red, no el camino.
 *
 * Consume el `Rng` **después** de las seis decisiones de `AI-002`: agregar esta
 * tirada al final no cambia ninguna de las anteriores para un mismo seed.
 */
export function selectMedia(
  rng: Rng,
  bank: MediaBank,
  format: BlitzContentType,
  influencerId: string | null,
  /**
   * Sprint 7 (`JV-6`): el tema de la pieza (el prompt del usuario o el
   * ángulo). Los roles de un solo asset —el meme, el fondo, el clip de fondo—
   * se sortean entre los que mejor le corresponden. Los slides y el demo no:
   * los slides son un set, y el demo es el producto.
   */
  topic?: string | null,
): MediaSelection | null {
  const pools = poolsFor(bank, format, influencerId);
  if (pools === null || !covers(pools, format)) return null;

  switch (format) {
    case "slideshow":
      return {
        format,
        slides: shuffled(rng, pools.slides ?? [])
          .slice(0, HARD_CAPS.slidesPerSlideshow)
          .map(ref),
      };
    case "wall-of-text":
      return { format, video: ref(pickRelevant(rng, pools.video ?? [], topic)) };
    case "green-screen":
      return {
        format,
        image: ref(pickRelevant(rng, pools.image ?? [], topic)),
        video: ref(pickRelevant(rng, pools.video ?? [], topic)),
      };
    case "video-hook": {
      // El demo primero: es el que habilita el formato (§15.8) y el más escaso.
      const demos = pools.demoVideo ?? [];
      const hooksFor = (demoId: string) =>
        (pools.hookVideo ?? []).filter((h) => h.id !== demoId);
      const demosWithHook = demos.filter((d) => hooksFor(d.id).length > 0);
      const demo = pickOne(rng, demosWithHook);
      const hook = pickRelevant(rng, hooksFor(demo.id), topic);
      return { format, hookVideo: ref(hook), demoVideo: ref(demo) };
    }
  }
}

function poolsFor(
  bank: MediaBank,
  format: BlitzContentType,
  influencerId: string | null,
): RolePools | null {
  if (influencerId === null) return workspacePools(bank, format);
  const pool = bank.influencerPools.get(influencerId);
  return pool === undefined ? null : influencerPools(bank, pool, format);
}

/** Los roles de un solo asset que `JV-6` puede re-elegir. */
export type JudgeableRole = "video" | "image";

/**
 * Los candidatos de un rol, del más al menos relevante al tema, **sólo los
 * que tienen algo en común con él**. Es la lista que ve el juicio de `JV-6`:
 * un candidato con puntaje 0 no aporta nada que el ranking no sepa.
 */
export function relevantCandidates(
  bank: MediaBank,
  format: BlitzContentType,
  influencerId: string | null,
  role: JudgeableRole,
  topic: string | null | undefined,
  max: number,
): readonly PlanningMedia[] {
  const pools = poolsFor(bank, format, influencerId);
  const pool = role === "video" ? pools?.video : pools?.image;
  if (pool === undefined || topic === null || topic === undefined) return [];
  return rankMedia(topic, pool)
    .filter((r) => r.score > 0)
    .slice(0, max)
    .map((r) => r.item);
}

/** Reemplaza el asset de un rol en una selección de un formato que lo tiene. */
export function withRoleMedia(
  selection: MediaSelection,
  role: JudgeableRole,
  media: MediaRef,
): MediaSelection {
  switch (selection.format) {
    case "green-screen":
      return role === "video"
        ? { ...selection, video: media }
        : { ...selection, image: media };
    case "wall-of-text":
      return role === "video" ? { ...selection, video: media } : selection;
    default:
      return selection;
  }
}

/** Una `MediaRef` a partir de un asset del banco. */
export function mediaRefOf(m: PlanningMedia): MediaRef {
  return ref(m);
}

/** Los ids de media que una selección usa. Es lo que se verifica al aceptar. */
export function selectionMediaIds(selection: MediaSelection): readonly string[] {
  switch (selection.format) {
    case "slideshow":
      return selection.slides.map((s) => s.mediaId);
    case "wall-of-text":
      return [selection.video.mediaId];
    case "green-screen":
      return [selection.image.mediaId, selection.video.mediaId];
    case "video-hook":
      return [selection.hookVideo.mediaId, selection.demoVideo.mediaId];
  }
}

/** Una fila de `media_sets` con influencer, en la forma que necesita el banco. */
export interface InfluencerSetRow {
  readonly influencerId: string;
  readonly kind: "SLIDESHOW" | "VIDEO" | "CURATED";
  readonly mediaIds: readonly string[];
}

/**
 * Arma el banco a partir de las filas. Los ids de un set que no están en
 * `media` (borrados, `processing`, `failed`) se ignoran: el set es una lista de
 * ids y la media puede haber cambiado de estado después.
 */
export function buildMediaBank(
  media: readonly PlanningMedia[],
  sets: readonly InfluencerSetRow[],
): MediaBank {
  const byId = new Map(media.map((m) => [m.id, m]));
  const pools = new Map<string, { images: PlanningMedia[]; videos: PlanningMedia[] }>();
  for (const set of sets) {
    if (set.kind === "CURATED") continue;
    const pool = pools.get(set.influencerId) ?? { images: [], videos: [] };
    for (const id of set.mediaIds) {
      const m = byId.get(id);
      if (m === undefined) continue;
      if (set.kind === "SLIDESHOW" && m.mediaType === "image") {
        if (!pool.images.some((x) => x.id === m.id)) pool.images.push(m);
      }
      if (set.kind === "VIDEO" && m.mediaType === "video") {
        if (!pool.videos.some((x) => x.id === m.id)) pool.videos.push(m);
      }
    }
    pools.set(set.influencerId, pool);
  }
  return { media, influencerPools: pools };
}
