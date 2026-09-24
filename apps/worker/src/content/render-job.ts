/**
 * De `contents.buildPayload` a un {@link RenderJob} — `FR-070`, IMPL §2.3.
 *
 * ## Qué problema resuelve
 *
 * `buildPayload` es una columna `jsonb`, así que vuelve de la base como
 * `unknown`. Lo escribió `POST /content` con la forma del **contrato público**
 * (`contentBuildPayloadSchema`), y lo que el puerto `MediaRenderer` pide es
 * casi la misma forma pero no exactamente: lleva `format`, que el contrato no
 * tiene porque el PRD no define una clave discriminante (*el body **es** el
 * payload*).
 *
 * Así que acá pasan dos cosas, y conviene que pasen juntas:
 *
 * 1. **Se valida.** Un `as` sobre un `jsonb` es una mentira que el compilador
 *    no puede desmentir; el payload lo escribió otro proceso, posiblemente con
 *    otra versión del código. Se revalida con el mismo schema que lo aceptó.
 * 2. **Se discrimina por forma**, igual que `contentTypeOf` en la ruta: con
 *    `.strict()` en cada rama las cuatro son disjuntas. El orden importa —
 *    `video-hook` tiene `hook_video` y `green-screen` tiene `image` **y**
 *    `video`— y es el mismo orden que usa la ruta al decidir el `type` de la
 *    fila.
 *
 * ## Y una tercera: se comprueba que coincidan
 *
 * La fila trae un `type` que la ruta dedujo al crearla, y el payload tiene su
 * propia forma. Si no coinciden, algo reescribió el payload sin tocar el tipo —
 * y construir según uno de los dos produce una pieza que no es la que el
 * usuario pidió, sin error. Se rechaza.
 *
 * ## Lo que este archivo NO hace
 *
 * - **No firma URLs.** El payload trae URLs canónicas del bucket propio
 *   (`DATA-010`); si el motor de render necesita una firmada, eso es asunto del
 *   adaptador de `MediaRenderer`, que es quien sabe si el motor puede leerlas.
 * - **No valida que la media sea del workspace.** `P2-RENDER-009` exige
 *   rechazarla *"antes de iniciar el build"*, o sea en `POST /content`, no acá:
 *   a esta altura la pieza ya está creada y el save ya se cobró.
 */

import {
  contentBuildPayloadSchema,
  type BuildText,
  type ContentBuildPayload,
  type MediaElement,
} from "@fastgram/contracts";
import {
  applyAssetSwaps,
  applyTextBoxesToBuildPayload,
  readAssetSwaps,
  type ContentTextBox,
  type TextFontFamilies,
} from "@fastgram/core";
import type { RenderImage, RenderJob, RenderText, RenderVideo } from "@fastgram/ports";

/** Los cuatro formatos que el motor sabe construir. `custom` no está: ver el handler. */
export type RenderableFormat = RenderJob["format"];

export type RenderJobResult =
  | { readonly ok: true; readonly job: RenderJob }
  | {
      readonly ok: false;
      /** Para el log. */
      readonly reason: string;
      /**
       * Código estable, el que puede terminar en `lastEdit.failureReason`.
       * `invalid_build_payload` si el payload persistido no cumple el contrato;
       * `edit_not_renderable` si son las cajas del editor las que no se pueden
       * llevar al payload (ver {@link toEditedRenderJob}).
       */
      readonly code: "invalid_build_payload" | "edit_not_renderable";
    };

/**
 * Qué formato describe un payload.
 *
 * Copia deliberada de `contentTypeOf` en `routes/v1/content.ts`: son dos
 * procesos y el payload no lleva discriminante, así que la deducción tiene que
 * estar de los dos lados. Lo que impide que se separen es la comprobación
 * cruzada contra `contents.type` que hace {@link toRenderJob} — si un lado
 * cambiara, la pieza se rechazaría en vez de construirse mal.
 */
export function formatOf(payload: ContentBuildPayload): RenderableFormat {
  if ("num_images" in payload) return "slideshow";
  if ("hook_video" in payload) return "video-hook";
  if ("image" in payload) return "green-screen";
  return "wall-of-text";
}

/**
 * `exactOptionalPropertyTypes` está encendido, así que `{fontWeight: undefined}`
 * **no** es asignable a `fontWeight?: number`. De ahí los spreads condicionales
 * en vez de copiar el objeto entero: un `...t` arrastraría las claves presentes
 * con valor `undefined` y no compilaría.
 *
 * `fontFamily` no aparece: el payload de build de `FR-070` no lo lleva, aunque
 * el puerto lo acepte y `P2-RENDER-008` tenga 12 familias. Queda reportado.
 */
function toRenderText(t: BuildText): RenderText {
  return {
    content: t.content,
    x: t.x,
    y: t.y,
    width: t.width,
    fontSize: t.fontSize,
    color: t.color,
    textAlign: t.textAlign,
    ...(t.fontWeight === undefined ? {} : { fontWeight: t.fontWeight }),
    ...(t.strokeWidth === undefined ? {} : { strokeWidth: t.strokeWidth }),
    ...(t.strokeColor === undefined ? {} : { strokeColor: t.strokeColor }),
    ...(t.backgroundColor === undefined ? {} : { backgroundColor: t.backgroundColor }),
  };
}

const toRenderImage = (m: MediaElement): RenderImage => ({
  url: m.url,
  drawX: m.drawX,
  drawY: m.drawY,
  drawW: m.drawW,
  drawH: m.drawH,
});

const toRenderVideo = (m: MediaElement): RenderVideo => toRenderImage(m);

/**
 * Valida el `buildPayload` persistido y lo convierte en un job del puerto.
 *
 * Devuelve un resultado en vez de lanzar porque el llamador no debe
 * **reintentar**: un payload que no parsea va a no parsear las tres veces, y
 * reintentarlo lo manda a la dead-letter disfrazado de fallo de
 * infraestructura. Es un fallo permanente de la pieza, y termina en `FAILED`
 * con su reembolso.
 */
export function toRenderJob(raw: unknown, contentType: string): RenderJobResult {
  const parsed = contentBuildPayloadSchema.safeParse(raw);
  if (!parsed.success) {
    // El mensaje de Zod trae la ruta del campo, que es lo único que sirve para
    // diagnosticar. No lleva valores del usuario: los `issues` de Zod dicen qué
    // se esperaba, no qué llegó.
    return {
      ok: false,
      code: "invalid_build_payload",
      reason: `buildPayload no cumple el contrato: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.code}`)
        .join("; ")}`,
    };
  }

  const payload = parsed.data;
  const format = formatOf(payload);
  if (format !== contentType) {
    return {
      ok: false,
      code: "invalid_build_payload",
      reason:
        `el buildPayload tiene forma de ${format} y la pieza dice ser ` +
        `${contentType}. Alguien reescribió uno de los dos sin el otro.`,
    };
  }

  if ("num_images" in payload) {
    return {
      ok: true,
      job: {
        format: "slideshow",
        num_images: payload.num_images,
        images: payload.images.map((slide) => ({
          canvas: {
            width: slide.canvas.width,
            height: slide.canvas.height,
            aspectRatio: slide.canvas.aspectRatio,
          },
          image: toRenderImage(slide.image),
          texts: slide.texts.map(toRenderText),
        })),
      },
    };
  }

  if ("hook_video" in payload) {
    return {
      ok: true,
      job: {
        format: "video-hook",
        canvas: payload.canvas,
        hook_video: toRenderVideo(payload.hook_video),
        demo_video: toRenderVideo(payload.demo_video),
        // `FR-053.1`: *No audio* omite el bloque entero, así que la ausencia es
        // un caso válido y no un payload incompleto.
        ...(payload.audio === undefined ? {} : { audio: { url: payload.audio.url } }),
        text: toRenderText(payload.text),
      },
    };
  }

  if ("image" in payload) {
    return {
      ok: true,
      job: {
        format: "green-screen",
        canvas: payload.canvas,
        image: toRenderImage(payload.image),
        video: toRenderVideo(payload.video),
        // Sprint 7: música de la marca, que el render mezcla con el clip.
        ...(payload.audio === undefined ? {} : { audio: { url: payload.audio.url } }),
        text: toRenderText(payload.text),
      },
    };
  }

  return {
    ok: true,
    job: {
      format: "wall-of-text",
      canvas: payload.canvas,
      video: toRenderVideo(payload.video),
      ...(payload.audio === undefined ? {} : { audio: { url: payload.audio.url } }),
      text: toRenderText(payload.text),
    },
  };
}

/**
 * El job de un **rebuild de edición**: el `buildPayload` original con las cajas
 * del editor aplicadas encima — `FR-051`, `PU-EDIT-002`.
 *
 * `PATCH /content/:id` escribe `content_text_boxes` y no toca `buildPayload`.
 * El mapeo de caja a texto de `FR-070` (centro + ancho en % → px de canvas)
 * vive en `core` (`applyTextBoxesToBuildPayload`); acá se hace lo que `core`
 * no puede:
 *
 *  1. **Se valida el payload original** con el contrato antes de editarlo.
 *  2. **Se revalida el editado** pasándolo por {@link toRenderJob}: si el mapeo
 *     produjera algo que el contrato no acepta, falla acá y no en el motor.
 *  3. **Se pone `fontFamily`**, que el payload de `FR-070` no tiene y el puerto
 *     sí. Sin esto, cambiar la tipografía en el inspector no cambiaría nada.
 *
 * El payload editado **no se persiste**: las cajas son el estado completo del
 * texto, y rehacerlo desde el original en cada edición hace que dos ediciones
 * seguidas no se acumulen sobre un payload ya editado.
 *
 * ## La media (`PU-EDIT-003`)
 *
 * Antes que las cajas se aplican los swaps de media del editor, guardados en
 * `contents.studioState` (`applyAssetSwaps` de `core`, la misma función con la
 * que `GET /content/:id/editable` le muestra la media al editor). El orden no
 * cambia el resultado —las cajas no leen la media— pero así el payload que se
 * revalida es el completo. Un `studioState` ilegible, o swaps que ya no calzan
 * con la pieza, cierran el rebuild con `edit_not_renderable`: renderizar sin
 * ellos declararía aplicado un swap que no salió.
 */
export function toEditedRenderJob(
  raw: unknown,
  contentType: string,
  boxes: readonly ContentTextBox[],
  studioState: unknown = null,
): RenderJobResult {
  const parsed = contentBuildPayloadSchema.safeParse(raw);
  if (!parsed.success) return toRenderJob(raw, contentType);

  const swaps = readAssetSwaps(studioState);
  if (swaps === null) {
    return {
      ok: false,
      code: "edit_not_renderable",
      reason: "studioState.assets no tiene la forma de los swaps de media",
    };
  }
  const swapped = applyAssetSwaps(parsed.data, swaps);
  if (!swapped.ok) {
    return {
      ok: false,
      code: "edit_not_renderable",
      reason: `${swapped.code}: ${swapped.reason}`,
    };
  }

  const edited = applyTextBoxesToBuildPayload(swapped.payload, boxes);
  if (!edited.ok) {
    return {
      ok: false,
      code: "edit_not_renderable",
      reason: `${edited.code}: ${edited.reason}`,
    };
  }

  const mapped = toRenderJob(edited.payload, contentType);
  if (!mapped.ok) return mapped;
  return { ok: true, job: withFontFamilies(mapped.job, edited.fontFamilies) };
}

function withFamily(text: RenderText, family: string | undefined): RenderText {
  return family === undefined ? text : { ...text, fontFamily: family };
}

/** `families[superficie][texto]`, con el mismo orden que el payload editado. */
function withFontFamilies(job: RenderJob, families: TextFontFamilies): RenderJob {
  if (job.format === "slideshow") {
    return {
      ...job,
      images: job.images.map((slide, i) => ({
        ...slide,
        texts: slide.texts.map((t, k) => withFamily(t, families[i]?.[k])),
      })),
    };
  }
  return { ...job, text: withFamily(job.text, families[0]?.[0]) };
}
