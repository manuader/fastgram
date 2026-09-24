/**
 * Cambiar la media de una pieza ya creada — `FR-051` (panel `ASSETS`, `Swap`),
 * `FR-052` (`Select Video`), `FR-053` (`Select Audio`, `No audio`), `FR-071`
 * (`Swap image for slide N`) y el zoom/posición del video en green-screen.
 * `PU-EDIT-003`.
 *
 * ## El mismo criterio que las cajas
 *
 * `text-boxes-to-build-payload.ts` no persiste el payload editado: rehace el
 * texto **desde el original** en cada rebuild, para que dos ediciones seguidas
 * no se acumulen sobre un payload ya editado. La media sigue la misma regla.
 * `buildPayload` no se toca nunca; los swaps viven en `contents.studioState`
 * (`{ assets: AssetSwaps }`, columna que DATA-008 marca como nunca devuelta) y
 * se aplican encima del original en dos lugares:
 *
 *  - el worker, al armar el job de un rebuild (`toEditedRenderJob`);
 *  - la API, al devolver `GET /content/:id/editable` (`assets`), para que el
 *    editor dibuje la media que va a salir y no la de antes del swap.
 *
 * Los dos llaman a {@link applyAssetSwaps}: si hubiera dos implementaciones, el
 * preview y el render podrían mostrar fondos distintos sin que nada falle.
 *
 * ## Por qué se guardan elementos completos y no parches
 *
 * El `PATCH` acepta parches (`{url}` sólo, o sólo `draw*` para el zoom). Se
 * resuelven contra la media vigente **al aceptar la edición**
 * ({@link resolveAssetPatch}) y lo que se guarda es el elemento completo. Así
 * aplicar es reemplazar, sin fusiones que dependan del orden.
 *
 * ## Decisiones que el PRD no cubre (conservadoras)
 *
 *  - **Un slot que el formato no tiene** (`hook_video` en un wall-of-text,
 *    `audio` en un green-screen) se rechaza: agregarlo produciría un payload que
 *    el contrato de `FR-070` no acepta.
 *  - **Slide inexistente**: se rechaza. Ni `Add Slide` ni `Delete Slide` entran
 *    acá: cambiar la cantidad de slides es cambiar la estructura, y las cajas
 *    están atadas a su `slideIndex`.
 *  - **`audio: null`** es `No audio` (`FR-053.1`): el payload resultante omite
 *    el bloque entero, que es lo que el contrato ya permite.
 *  - **`studioState` ilegible**: {@link readAssetSwaps} devuelve `null` y quien
 *    llama decide. El worker cierra el rebuild como no renderizable (la versión
 *    anterior sigue usable); la API lo trata como sin swaps.
 *
 * Funciones puras; `core` no importa `contracts`, así que los tipos son
 * estructurales y el worker revalida el resultado con el contrato.
 */

/** Un elemento de media de `FR-070`: URL + rectángulo de dibujo en px de canvas. */
export interface MediaDraw {
  readonly url: string;
  readonly drawX: number;
  readonly drawY: number;
  readonly drawW: number;
  readonly drawH: number;
}

/** Parche sobre un elemento: lo que viene se pisa, lo que no viene se conserva. */
export interface MediaPatch {
  readonly url?: string | undefined;
  readonly drawX?: number | undefined;
  readonly drawY?: number | undefined;
  readonly drawW?: number | undefined;
  readonly drawH?: number | undefined;
}

export interface AudioRef {
  readonly url: string;
}

/** Los slots de media de una superficie, con los nombres del payload de `FR-070`. */
export type MediaSlot = "image" | "video" | "hook_video" | "demo_video";
export const MEDIA_SLOTS: readonly MediaSlot[] = [
  "image",
  "video",
  "hook_video",
  "demo_video",
];

/** Qué tipo de archivo pide cada slot. El de los slides es `image`. */
export const MEDIA_SLOT_KIND: Readonly<Record<MediaSlot, "image" | "video">> = {
  image: "image",
  video: "video",
  hook_video: "video",
  demo_video: "video",
};

/** Lo persistido en `studioState.assets`: elementos completos. */
export interface AssetSwaps {
  readonly slides?: readonly { readonly index: number; readonly image: MediaDraw }[];
  readonly image?: MediaDraw;
  readonly video?: MediaDraw;
  readonly hook_video?: MediaDraw;
  readonly demo_video?: MediaDraw;
  /** `null` = `No audio`. Ausente = sin cambio. */
  readonly audio?: AudioRef | null;
}

/** Lo que llega en `PATCH /content/:id` (`assets`). */
export interface AssetPatch {
  readonly slides?:
    readonly { readonly index: number; readonly image: MediaPatch }[] | undefined;
  readonly image?: MediaPatch | undefined;
  readonly video?: MediaPatch | undefined;
  readonly hook_video?: MediaPatch | undefined;
  readonly demo_video?: MediaPatch | undefined;
  readonly audio?: AudioRef | null | undefined;
}

/** La media vigente de una pieza, tal como la ve el editor. */
export interface ContentAssets {
  readonly slides?: readonly MediaDraw[];
  readonly image?: MediaDraw;
  readonly video?: MediaDraw;
  readonly hook_video?: MediaDraw;
  readonly demo_video?: MediaDraw;
  /** Sólo en los formatos de video (no slideshow). `null` = sin audio. */
  readonly audio?: AudioRef | null;
}

/**
 * Lo mínimo de un payload que este archivo lee. El resto de las claves viaja
 * intacto por spread.
 */
export type AssetBuildPayload =
  | {
      readonly num_images: number;
      readonly images: readonly { readonly image: MediaDraw }[];
    }
  | {
      readonly image?: MediaDraw | undefined;
      readonly video?: MediaDraw | undefined;
      readonly hook_video?: MediaDraw | undefined;
      readonly demo_video?: MediaDraw | undefined;
      readonly audio?: AudioRef | undefined;
      readonly text: unknown;
    };

export type AssetSwapError = "asset_slot_not_in_format" | "asset_slide_out_of_range";

export type AssetSwapResult<T> =
  | ({ readonly ok: true } & T)
  | { readonly ok: false; readonly code: AssetSwapError; readonly reason: string };

/**
 * Formatos que llevan pista de audio: los tres de video. `green-screen` se sumó
 * en el sprint 7 (su música se mezcla con el audio del clip en el render); el
 * slideshow se exporta como carrusel de imágenes y no tiene dónde llevarla.
 */
const hasAudioSlot = (payload: AssetBuildPayload): boolean => !("num_images" in payload);

const isSlideshow = (
  payload: AssetBuildPayload,
): payload is Extract<AssetBuildPayload, { num_images: number }> =>
  "num_images" in payload;

function slotsOf(payload: AssetBuildPayload): MediaSlot[] {
  if (isSlideshow(payload)) return [];
  return MEDIA_SLOTS.filter((slot) => payload[slot] !== undefined);
}

const pickDraw = (m: MediaDraw): MediaDraw => ({
  url: m.url,
  drawX: m.drawX,
  drawY: m.drawY,
  drawW: m.drawW,
  drawH: m.drawH,
});

/** La media de un payload, en la forma que devuelve `GET /content/:id/editable`. */
export function assetsOf(payload: AssetBuildPayload): ContentAssets {
  if (isSlideshow(payload)) {
    return { slides: payload.images.map((slide) => pickDraw(slide.image)) };
  }
  const out: Record<string, MediaDraw | AudioRef | null> = {};
  for (const slot of slotsOf(payload)) {
    const media = payload[slot];
    if (media !== undefined) out[slot] = pickDraw(media);
  }
  if (hasAudioSlot(payload)) {
    out["audio"] = payload.audio === undefined ? null : { url: payload.audio.url };
  }
  return out as ContentAssets;
}

function checkSwapsFit(
  payload: AssetBuildPayload,
  swaps: AssetSwaps | AssetPatch,
): AssetSwapResult<object> {
  if (isSlideshow(payload)) {
    for (const slot of MEDIA_SLOTS) {
      if (swaps[slot] !== undefined) {
        return {
          ok: false,
          code: "asset_slot_not_in_format",
          reason: `un slideshow no tiene ${slot}; se cambia la imagen de cada slide`,
        };
      }
    }
    if (swaps.audio !== undefined) {
      return {
        ok: false,
        code: "asset_slot_not_in_format",
        reason: "un slideshow no lleva pista de audio (FR-070)",
      };
    }
    for (const slide of swaps.slides ?? []) {
      if (
        !Number.isInteger(slide.index) ||
        slide.index < 0 ||
        slide.index >= payload.images.length
      ) {
        return {
          ok: false,
          code: "asset_slide_out_of_range",
          reason:
            `el slide ${String(slide.index)} no existe: la pieza tiene ` +
            `${String(payload.images.length)} slide(s)`,
        };
      }
    }
    return { ok: true };
  }

  if (swaps.slides !== undefined && swaps.slides.length > 0) {
    return {
      ok: false,
      code: "asset_slot_not_in_format",
      reason: "sólo un slideshow tiene slides",
    };
  }
  const present = new Set(slotsOf(payload));
  for (const slot of MEDIA_SLOTS) {
    if (swaps[slot] !== undefined && !present.has(slot)) {
      return {
        ok: false,
        code: "asset_slot_not_in_format",
        reason: `este formato no tiene ${slot} (FR-070)`,
      };
    }
  }
  if (swaps.audio !== undefined && !hasAudioSlot(payload)) {
    return {
      ok: false,
      code: "asset_slot_not_in_format",
      reason: "este formato no lleva pista de audio (FR-070)",
    };
  }
  return { ok: true };
}

/**
 * Aplica los swaps guardados sobre el `buildPayload` original.
 *
 * Con `swaps` vacío devuelve el payload tal cual (la misma referencia).
 */
export function applyAssetSwaps<P extends AssetBuildPayload>(
  payload: P,
  swaps: AssetSwaps,
): AssetSwapResult<{ readonly payload: P }> {
  const fit = checkSwapsFit(payload, swaps);
  if (!fit.ok) return fit;

  if (isSlideshow(payload)) {
    const bySlide = new Map((swaps.slides ?? []).map((s) => [s.index, s.image]));
    if (bySlide.size === 0) return { ok: true, payload };
    const images = payload.images.map((slide, index) => {
      const image = bySlide.get(index);
      return image === undefined ? slide : { ...slide, image: pickDraw(image) };
    });
    // Mismo `as` que `applyTextBoxesToBuildPayload`: reemplazar `images` por
    // uno de la misma forma devuelve `P`, y el worker lo revalida con el contrato.
    return { ok: true, payload: { ...payload, images } as P };
  }

  let changed = false;
  const next: Record<string, unknown> = { ...payload };
  for (const slot of MEDIA_SLOTS) {
    const media = swaps[slot];
    if (media !== undefined) {
      next[slot] = pickDraw(media);
      changed = true;
    }
  }
  if (swaps.audio !== undefined) {
    changed = true;
    if (swaps.audio === null) delete next["audio"];
    else next["audio"] = { url: swaps.audio.url };
  }
  return { ok: true, payload: changed ? (next as P) : payload };
}

/** Una URL que entra a la pieza con esta edición y hay que autorizar. */
export interface IncomingAsset {
  readonly url: string;
  readonly kind: "image" | "video" | "audio";
  /** `image`, `video`, …, `slides[3]` o `audio`. Para el mensaje de error. */
  readonly slot: string;
}

const mergeDraw = (current: MediaDraw, patch: MediaPatch): MediaDraw => ({
  url: patch.url ?? current.url,
  drawX: patch.drawX ?? current.drawX,
  drawY: patch.drawY ?? current.drawY,
  drawW: patch.drawW ?? current.drawW,
  drawH: patch.drawH ?? current.drawH,
});

/**
 * Resuelve el `assets` de un `PATCH` contra la media vigente y devuelve los
 * swaps a guardar (los anteriores más estos) y las URLs **nuevas**, que quien
 * llama tiene que validar contra el Media Bank del workspace o el catálogo de
 * audio (`FR-070`: *"una URL arbitraria se rechaza … antes de iniciar el
 * build"*).
 *
 * Una URL igual a la vigente no cuenta como nueva: re-mandar el fondo actual
 * con un zoom distinto no tiene por qué volver a pasar por el Media Bank, y el
 * fondo original de una pieza de Blitz puede venir de un pool que no es
 * `media`.
 */
export function resolveAssetPatch(
  original: AssetBuildPayload,
  stored: AssetSwaps,
  patch: AssetPatch,
): AssetSwapResult<{ readonly swaps: AssetSwaps; readonly incoming: IncomingAsset[] }> {
  const fit = checkSwapsFit(original, patch);
  if (!fit.ok) return fit;
  const applied = applyAssetSwaps(original, stored);
  if (!applied.ok) return applied;
  const current = assetsOf(applied.payload);
  const incoming: IncomingAsset[] = [];

  if (isSlideshow(original)) {
    const bySlide = new Map((stored.slides ?? []).map((s) => [s.index, s.image]));
    for (const slide of patch.slides ?? []) {
      const now = current.slides?.[slide.index];
      if (now === undefined) continue; // `checkSwapsFit` ya lo descartó
      const next = mergeDraw(now, slide.image);
      if (next.url !== now.url) {
        incoming.push({ url: next.url, kind: "image", slot: `slides[${slide.index}]` });
      }
      bySlide.set(slide.index, next);
    }
    const slides = [...bySlide.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, image]) => ({ index, image }));
    return {
      ok: true,
      swaps: slides.length === 0 ? {} : { slides },
      incoming,
    };
  }

  const swaps: Record<string, MediaDraw | AudioRef | null> = {};
  for (const slot of MEDIA_SLOTS) {
    const kept = stored[slot];
    if (kept !== undefined) swaps[slot] = kept;
    const media = patch[slot];
    const now = current[slot];
    if (media === undefined || now === undefined) continue;
    const next = mergeDraw(now, media);
    if (next.url !== now.url) {
      incoming.push({ url: next.url, kind: MEDIA_SLOT_KIND[slot], slot });
    }
    swaps[slot] = next;
  }
  if (stored.audio !== undefined) swaps["audio"] = stored.audio;
  if (patch.audio !== undefined) {
    if (patch.audio !== null && patch.audio.url !== current.audio?.url) {
      incoming.push({ url: patch.audio.url, kind: "audio", slot: "audio" });
    }
    swaps["audio"] = patch.audio === null ? null : { url: patch.audio.url };
  }
  return { ok: true, swaps: swaps as AssetSwaps, incoming };
}

// --- Lectura tolerante de `studioState` --------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function readDraw(v: unknown): MediaDraw | null {
  if (!isRecord(v)) return null;
  const { url, drawX, drawY, drawW, drawH } = v;
  if (typeof url !== "string") return null;
  for (const n of [drawX, drawY, drawW, drawH]) {
    if (typeof n !== "number" || !Number.isFinite(n)) return null;
  }
  return {
    url,
    drawX: drawX as number,
    drawY: drawY as number,
    drawW: drawW as number,
    drawH: drawH as number,
  };
}

/**
 * Los swaps guardados en `contents.studioState`. `jsonb` vuelve como
 * `unknown`: se lee con forma y no con `as`.
 *
 * `{}` si no hay nada guardado (el caso de toda pieza sin swaps); `null` si hay
 * algo y no se entiende.
 */
export function readAssetSwaps(studioState: unknown): AssetSwaps | null {
  if (studioState === null || studioState === undefined) return {};
  if (!isRecord(studioState)) return null;
  const raw = studioState["assets"];
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw)) return null;

  const out: Record<string, unknown> = {};
  for (const slot of MEDIA_SLOTS) {
    if (raw[slot] === undefined) continue;
    const draw = readDraw(raw[slot]);
    if (draw === null) return null;
    out[slot] = draw;
  }
  if (raw["audio"] !== undefined) {
    const audio = raw["audio"];
    if (audio === null) out["audio"] = null;
    else if (isRecord(audio) && typeof audio["url"] === "string") {
      out["audio"] = { url: audio["url"] };
    } else return null;
  }
  if (raw["slides"] !== undefined) {
    const slides = raw["slides"];
    if (!Array.isArray(slides)) return null;
    const parsed: { index: number; image: MediaDraw }[] = [];
    for (const s of slides as unknown[]) {
      if (!isRecord(s) || typeof s["index"] !== "number") return null;
      const image = readDraw(s["image"]);
      if (image === null) return null;
      parsed.push({ index: s["index"], image });
    }
    out["slides"] = parsed;
  }
  return out as AssetSwaps;
}

/** `studioState` con los swaps nuevos, conservando cualquier otra clave. */
export function withAssetSwaps(
  studioState: unknown,
  swaps: AssetSwaps,
): Record<string, unknown> {
  const base = isRecord(studioState) ? studioState : {};
  return { ...base, assets: swaps };
}

/** ¿Hay algo que aplicar? */
export function hasAssetSwaps(swaps: AssetSwaps): boolean {
  return (
    (swaps.slides?.length ?? 0) > 0 ||
    MEDIA_SLOTS.some((slot) => swaps[slot] !== undefined) ||
    swaps.audio !== undefined
  );
}
