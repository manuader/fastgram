/**
 * `POST /content/studio` — «Create New» del Content Studio (`F-071`…`F-083`,
 * `P2-STUDIO-002/003/007/008`).
 *
 * ## Por qué una ruta y no `POST /content`
 *
 * `POST /content` recibe el payload de `FR-070` **desnudo** (geometría en
 * píxeles, URLs). El Studio elige media del Media Bank, escribe textos y un
 * estilo; si el cliente armara la geometría, habría una segunda copia de las
 * reglas de layout que Blitz ya tiene (`composeBlitzBuildPayload`) y las dos
 * divergirían. Acá el servidor resuelve los ids a URLs vivas de la marca, arma
 * el payload con la **misma** función que Blitz y sigue exactamente el camino
 * de `POST /content`: cobra el save, crea `BUILDING` y encola el build en la
 * misma transacción.
 *
 * ## «Generate with AI»
 *
 * Con `ai`, el job lleva `prompt` (+ `mentionBusiness`) y el worker reescribe
 * el texto con el modelo de la tarea `text` **antes** de renderizar
 * (`build-handler.ts`, rama `create` con prompt). El texto que manda el cliente
 * queda como estructura (un slide por texto). No se llama al LLM desde acá: el
 * proxy de la web corta a los 10 s y un modelo local tarda más.
 *
 * ## Decisiones que el PRD no cubre
 *
 * - Un asset que no está `ready`, está borrado, es de otro tipo o de otra
 *   marca es `400` con `details.mediaIds` (no `404`: el recurso de la ruta es
 *   la pieza nueva, y un id ajeno no se distingue de uno inexistente).
 * - Sin audio: la música se elige en el editor (agente B).
 * - Sprint 9 (S): sin `textStylePresetId`, el estilo de caption sale del
 *   design system activo (el mismo que Blitz estampa en sus sugerencias); la
 *   familia y el logo los estampa el primer build (`core/content/brand-look`),
 *   igual que en toda pieza nueva. Con preset, manda el preset.
 */
import {
  contentBuildPayloadSchema,
  studioContentRequestSchema,
  TEXT_STYLE_PRESET_IDS,
  idempotencyHeaderSchema,
  type StudioContentRequest,
} from "@fastgram/contracts";
import {
  SUGGESTION_BUILD_PLAN_VERSION,
  composeBlitzBuildPayload,
  designSystemCaptionStyle,
  readDesignSystemTokens,
  type CaptionStyle,
  type MediaRef,
  type MediaSelection,
} from "@fastgram/core";
import {
  contentRepository,
  designSystemRepository,
  mediaRepository,
  type Transaction,
} from "@fastgram/db";

import { ApiRejection } from "../../http/errors.js";
import { rateLimit } from "../../plugins/rate-limit.js";
import { toContent } from "../../support/serializers.js";
import { consumeContentSave, quotaPolicyFor } from "../../support/quota.js";
import { enqueueBuild, queueUnavailable } from "./content.js";
import { idempotencyKeyOf, withIdempotency } from "./shared.js";
import type { ZodApp } from "../../server/types.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Slot = { readonly id: string; readonly kind: "image" | "video" };

/** Qué slots pide cada formato, y de qué tipo. Falta uno → `400`. */
export function slotsOf(body: StudioContentRequest): Slot[] | string {
  const m = body.media;
  const need = (id: string | undefined, kind: Slot["kind"], name: string) =>
    id === undefined ? `missing media.${name}` : { id, kind };
  const parts: (Slot | string)[] = [];
  switch (body.format) {
    case "slideshow":
      if (m.slides === undefined || m.slides.length === 0) return "missing media.slides";
      if (body.texts.length !== m.slides.length)
        return "slideshow needs one text per slide";
      parts.push(...m.slides.map((id) => ({ id, kind: "image" as const })));
      break;
    case "wall-of-text":
      parts.push(need(m.video, "video", "video"));
      break;
    case "green-screen":
      parts.push(need(m.image, "image", "image"), need(m.video, "video", "video"));
      break;
    case "video-hook":
      parts.push(
        need(m.hookVideo, "video", "hookVideo"),
        need(m.demoVideo, "video", "demoVideo"),
      );
      break;
  }
  if (body.format !== "slideshow" && body.texts.length !== 1)
    return `${body.format} takes exactly one text`;
  const bad = parts.find((p): p is string => typeof p === "string");
  return bad ?? (parts as Slot[]);
}

/** Resuelve los ids a `MediaRef` vivos y listos de la marca, o lista los que no. */
async function resolveMedia(
  tx: Transaction,
  companyId: string,
  slots: readonly Slot[],
): Promise<{ ok: true; refs: Map<string, MediaRef> } | { ok: false; bad: string[] }> {
  const ids = [...new Set(slots.map((s) => s.id))];
  const candidates = ids.filter((id) => UUID.test(id));
  const found = await mediaRepository.list(
    tx,
    { companyId },
    { limit: Math.max(1, candidates.length), filter: { mediaId: { in: candidates } } },
  );
  const rows = new Map(found.items.map((row) => [row.mediaId, row]));
  const bad = slots
    .filter((slot) => {
      const row = rows.get(slot.id);
      return row === undefined || row.status !== "ready" || row.mediaType !== slot.kind;
    })
    .map((slot) => slot.id);
  if (bad.length > 0) return { ok: false, bad: [...new Set(bad)] };
  const refs = new Map<string, MediaRef>();
  for (const [id, row] of rows) refs.set(id, { mediaId: id, url: row.r2Url });
  return { ok: true, refs };
}

function selectionOf(
  body: StudioContentRequest,
  refs: Map<string, MediaRef>,
): MediaSelection {
  const at = (id: string | undefined): MediaRef => {
    const ref = id === undefined ? undefined : refs.get(id);
    // Inalcanzable: `slotsOf` y `resolveMedia` ya lo verificaron.
    if (ref === undefined) throw new Error("studio: media sin resolver");
    return ref;
  };
  const m = body.media;
  switch (body.format) {
    case "slideshow":
      return { format: "slideshow", slides: (m.slides ?? []).map((id) => at(id)) };
    case "wall-of-text":
      return { format: "wall-of-text", video: at(m.video) };
    case "green-screen":
      return { format: "green-screen", image: at(m.image), video: at(m.video) };
    case "video-hook":
      return {
        format: "video-hook",
        hookVideo: at(m.hookVideo),
        demoVideo: at(m.demoVideo),
      };
  }
}

/** El estilo de caption del design system activo, o `null` sin él. */
async function designSystemStyleOf(
  tx: Transaction,
  companyId: string,
): Promise<CaptionStyle | null> {
  const row = await designSystemRepository.findActive(tx, { companyId });
  const tokens = row === null ? null : readDesignSystemTokens(row.tokens);
  return tokens === null ? null : designSystemCaptionStyle(tokens);
}

export function registerContentStudioRoutes(app: ZodApp): void {
  const { limiter, clock, idempotency, queue } = app.deps;

  app.post(
    "/content/studio",
    {
      schema: { body: studioContentRequestSchema, headers: idempotencyHeaderSchema },
      preHandler: [
        rateLimit(limiter, "restPerWorkspace"),
        rateLimit(limiter, "contentBuilds"),
      ],
    },
    async (request, reply) => {
      if (queue === undefined) return queueUnavailable(reply);
      const body = request.body;
      const companyId = request.auth.companyId;

      if (
        body.textStylePresetId !== undefined &&
        !TEXT_STYLE_PRESET_IDS.includes(body.textStylePresetId)
      ) {
        throw new ApiRejection(400, "bad_request", "Unknown text style.", {
          allowed: [...TEXT_STYLE_PRESET_IDS],
        });
      }
      const slots = slotsOf(body);
      if (typeof slots === "string") throw new ApiRejection(400, "bad_request", slots);
      if (body.ai === undefined && body.texts.every((t) => t.trim() === "")) {
        throw new ApiRejection(400, "bad_request", "Write the text or let AI write it.");
      }

      return withIdempotency(
        idempotency,
        request,
        reply,
        {
          key: idempotencyKeyOf(request.headers),
          route: "POST /content/studio",
          body,
          successStatus: 201,
        },
        () =>
          request.tx(async (tx) => {
            const resolved = await resolveMedia(tx, companyId, slots);
            if (!resolved.ok) {
              // Dentro de la idempotencia: el `throw` libera la key.
              throw new ApiRejection(
                400,
                "bad_request",
                "Some of the selected media can't be used. Pick ready media of the right type.",
                { mediaIds: resolved.bad },
              );
            }
            // Con IA y un texto vacío, el brief es el borrador: el worker necesita
            // una caja con texto para reescribir (`regenerationBoxesOf`).
            const texts = body.texts.map((t) =>
              t.trim() === "" && body.ai !== undefined ? body.ai.prompt : t,
            );
            const brandStyle =
              body.textStylePresetId === undefined
                ? await designSystemStyleOf(tx, companyId)
                : null;
            const payload = contentBuildPayloadSchema.parse(
              composeBlitzBuildPayload(
                {
                  version: SUGGESTION_BUILD_PLAN_VERSION,
                  media: selectionOf(body, resolved.refs),
                  texts,
                  ...(brandStyle === null ? {} : { textStyle: brandStyle }),
                },
                {
                  aspectRatio: body.aspectRatio,
                  textStylePresetId: body.textStylePresetId ?? null,
                },
              ),
            );

            const save = await consumeContentSave(
              tx,
              { companyId },
              clock,
              quotaPolicyFor(app.deps.mode),
            );
            const row = await contentRepository.create(
              tx,
              { companyId },
              {
                type: body.format,
                status: "BUILDING",
                buildPayload: payload,
                saveBucket: save.bucket,
                savePeriod: save.period,
              },
            );
            await enqueueBuild(queue, tx, {
              companyId,
              contentId: row.id,
              contentType: row.type,
              revision: row.revision,
              reason: "create",
              ...(body.ai === undefined
                ? {}
                : {
                    prompt: body.ai.prompt,
                    ...(body.ai.mentionBusiness === undefined
                      ? {}
                      : { mentionBusiness: body.ai.mentionBusiness }),
                  }),
            });
            return toContent(row);
          }),
      );
    },
  );
}
