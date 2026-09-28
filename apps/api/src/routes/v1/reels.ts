/**
 * Reels (sprint 9, `PU-S9-010`, `D-20`):
 *
 *  - `GET  /content/:id/reel`   — el spec vigente, para el editor por capas.
 *  - `PUT  /content/:id/reel`   — reemplaza el spec y reconstruye (minor edit de
 *                                  `FR-051`: misma concurrencia optimista, mismas
 *                                  guardas que `PATCH /content/:id`).
 *  - `POST /reels/preview`      — la composición HTML (la misma que renderiza el
 *                                  motor) para el iframe del editor.
 *  - `POST /reels/from-prompt`  — «Create from prompt» con formato reel: plan
 *                                  idea→spec de `core` con assets de la marca.
 *
 * El spec editado va a `studioState.reel`; `buildPayload` no se reescribe (la
 * regla de siempre: el worker aplica la edición encima del original).
 *
 * ## El render desde la API
 *
 * La preview es síncrona (el editor la espera), así que la API habla con
 * `services/render` directo. `server/types.ts` y `main.ts` no son de esta tarea:
 * como `brand-llm.ts` y `models.ts`, esta ruta lee su entorno por su cuenta
 * (`RENDER_SERVICE_URL`, `RENDER_MEDIA_GRANT_SECRET`, los mismos del worker) y
 * responde `503 reel_preview_unavailable` sin ellos.
 */
import { z } from "zod";
import {
  brandAudioKeyPrefix,
  editableReelSchema,
  idempotencyHeaderSchema,
  reelBuildPayloadSchema,
  reelFromPromptRequestSchema,
  reelMediaUrls,
  reelPreviewRequestSchema,
  reelSpecSchema,
  updateReelRequestSchema,
  type ReelSpec,
} from "@fastgram/contracts";
import {
  brandAudioRepository,
  brandStrategyRepository,
  contentBuildStore,
  contentRepository,
  searchMedia,
  type Transaction,
} from "@fastgram/db";
import {
  planReel,
  reelLanguageOf,
  reelSpecFromPlan,
  type ReelPlanAssets,
  type ReelTemplate,
} from "@fastgram/core";
import { HttpMediaRenderer } from "@fastgram/adapters";
import type { MediaAuthorization, ReelRenderer, Storage } from "@fastgram/ports";
import { createHash } from "node:crypto";

import { rateLimit } from "../../plugins/rate-limit.js";
import { canonicalObjectUrl } from "../../support/upload-reservations.js";
import { toContent } from "../../support/serializers.js";
import { capturePreferenceEdit } from "../../services/preferences.js";
import { consumeContentSave, quotaPolicyFor } from "../../support/quota.js";
import { crossTenant, data, idempotencyKeyOf, withIdempotency } from "./shared.js";
import type { ZodApp } from "../../server/types.js";
import {
  ContentRejection,
  assertEditable,
  bumpAndRebuild,
  enqueueBuild,
  foreignPayloadAssets,
  queueUnavailable,
  sendRejection,
  type LiveContentRow,
} from "./content.js";

const contentParams = z.object({ id: z.string().min(1) });

/** Clave de `contents.studioState` con el spec editado (la lee el worker). */
export const REEL_STUDIO_STATE_KEY = "reel";

/** El spec vigente: el editado si hay y valida, si no el original. */
export function currentReelSpec(
  row: Pick<LiveContentRow, "buildPayload" | "studioState">,
): ReelSpec | null {
  const original = reelBuildPayloadSchema.safeParse(row.buildPayload);
  if (!original.success) return null;
  const state = row.studioState;
  const edited =
    typeof state === "object" && state !== null
      ? (state as Record<string, unknown>)[REEL_STUDIO_STATE_KEY]
      : undefined;
  if (edited !== undefined && edited !== null) {
    const parsed = reelSpecSchema.safeParse(edited);
    if (parsed.success) return parsed.data;
  }
  return original.data.reel;
}

function withReelSpec(studioState: unknown, spec: ReelSpec): Record<string, unknown> {
  const base =
    typeof studioState === "object" && studioState !== null && !Array.isArray(studioState)
      ? (studioState as Record<string, unknown>)
      : {};
  return { ...base, [REEL_STUDIO_STATE_KEY]: spec };
}

/**
 * La misma autorización que el worker le firma al render
 * (`apps/worker/src/content/media-authorization.ts`): prefijos del workspace
 * más la biblioteca de audio de la marca, y la lista exacta de URLs.
 */
async function reelAuthorization(
  storage: Storage,
  companyId: string,
  urls: readonly string[],
): Promise<MediaAuthorization> {
  const mediaPrefixes = await Promise.all(
    [
      `media/${companyId}/`,
      `influencers/${companyId}/`,
      `content/custom-video/${companyId}/`,
    ].map((key) => canonicalObjectUrl(storage, key)),
  );
  const audio = await canonicalObjectUrl(storage, `${brandAudioKeyPrefix(companyId)}/`);
  return { companyId, mediaPrefixes, sharedPrefixes: [audio], urls: [...urls] };
}

/** Env de la preview. Exportada para el test; en la ruta se lee `process.env`. */
export function reelRendererFromEnv(
  env: Record<string, string | undefined>,
): ReelRenderer | null {
  const baseUrl = env["RENDER_SERVICE_URL"]?.trim() ?? "";
  const secret = env["RENDER_MEDIA_GRANT_SECRET"]?.trim() ?? "";
  if (baseUrl === "" || secret === "") return null;
  // `engineVersion` sólo entra al fingerprint de los cuatro formatos base; la
  // preview no lo usa, pero el constructor no acepta vacío (y hace bien).
  return new HttpMediaRenderer({
    baseUrl,
    engineVersion: "reel-preview",
    grantSecret: secret,
  });
}

function rejectForeign(foreign: readonly string[]): never {
  throw new ContentRejection(
    400,
    "bad_request",
    "Pick media from your Media Bank and audio from your library.",
    { invalidAssets: foreign },
  );
}

/** Elección determinística: mismo prompt, mismos assets (y mismo render cacheado). */
function pickIndex(seed: string, n: number): number {
  const h = createHash("sha256").update(seed).digest();
  return h.readUInt32BE(0) % n;
}

/**
 * Los assets del «Create from prompt» con formato reel: un fondo de la marca,
 * un clip de croma (`green-screen-video`) y una pista de música con `auto_use`.
 * Sin fondo, el plan usa un degradé del tema; sin clip, la plantilla de lista.
 * El decisor de assets (agente O) y el planificador semanal los van a elegir
 * mejor en la segunda tanda; esto es el mínimo que deja el camino andando.
 */
async function pickReelAssets(
  tx: Transaction,
  companyId: string,
  seed: string,
): Promise<ReelPlanAssets> {
  const origins = ["manual_upload", "brand_kit", "imported"] as const;
  const ready = <T extends { status: string }>(rows: readonly T[]) =>
    rows.filter((r) => r.status === "ready");
  const byCategory = async (mediaType: "image" | "video", category: string | undefined) =>
    ready(
      (
        await searchMedia(
          tx,
          { companyId },
          {
            limit: 20,
            mediaType,
            origins: [...origins],
            ...(category === undefined ? {} : { category }),
          },
        )
      ).items,
    );
  let backgrounds = await byCategory("image", "green-screen-background");
  if (backgrounds.length === 0) backgrounds = await byCategory("image", undefined);
  const clips = await byCategory("video", "green-screen-video");
  const tracks = await brandAudioRepository.listAutoUse(tx, { companyId });

  const bg =
    backgrounds.length === 0
      ? null
      : backgrounds[pickIndex(`${seed}:bg`, backgrounds.length)];
  const clip = clips.length === 0 ? null : clips[pickIndex(`${seed}:clip`, clips.length)];
  const track =
    tracks.length === 0 ? null : tracks[pickIndex(`${seed}:music`, tracks.length)];
  return {
    backgrounds:
      bg === null || bg === undefined ? [] : [{ url: bg.r2Url, kind: "image" }],
    clip:
      clip === null || clip === undefined
        ? null
        : {
            url: clip.r2Url,
            // Un recorte con alfa (`PU-MEME-002`) llega como webm/mov; el resto,
            // verde. Heurística por extensión: la fila no guarda el códec.
            chroma: /\.(webm|mov)(\?|$)/i.test(clip.r2Url) ? "alpha" : "green",
            durationSec: clip.videoDurationSec ?? null,
            hasSpeech: null,
          },
    music: track === null || track === undefined ? null : { url: track.url },
  };
}

export function registerReelRoutes(app: ZodApp): void {
  const { limiter, clock, idempotency, storage, queue } = app.deps;

  // ── GET /content/:id/reel ──
  app.get(
    "/content/:id/reel",
    { schema: { params: contentParams } },
    async (request, reply) => {
      const { id } = request.params;
      const companyId = request.auth.companyId;
      const row = await request.tx((tx) =>
        contentRepository.findById(tx, { companyId }, id),
      );
      if (row === null) throw crossTenant("content", id, companyId);
      const spec = row.type === "reel" ? currentReelSpec(row) : null;
      if (spec === null) {
        return reply.status(422).send({
          error: { code: "content_not_editable", message: "This piece isn't a reel." },
        });
      }
      return data(editableReelSchema.parse({ revision: row.revision, reel: spec }));
    },
  );

  // ── PUT /content/:id/reel ──
  app.put(
    "/content/:id/reel",
    {
      schema: {
        params: contentParams,
        body: updateReelRequestSchema,
        headers: idempotencyHeaderSchema,
      },
      preHandler: [
        rateLimit(limiter, "restPerWorkspace"),
        rateLimit(limiter, "contentBuilds"),
      ],
    },
    async (request, reply) => {
      if (queue === undefined) return queueUnavailable(reply);
      const { id } = request.params;
      const body = request.body;
      const companyId = request.auth.companyId;
      try {
        return await withIdempotency(
          idempotency,
          request,
          reply,
          {
            key: idempotencyKeyOf(request.headers),
            route: "PUT /content/:id/reel",
            body,
            successStatus: 200,
          },
          () =>
            request.tx(async (tx) => {
              const row = await contentBuildStore.lockContent(tx, { companyId }, id);
              if (row === null)
                throw new ContentRejection(404, "not_found", "content not found");
              if (row.type !== "reel" || currentReelSpec(row) === null) {
                throw new ContentRejection(
                  422,
                  "content_not_editable",
                  "This piece isn't a reel.",
                );
              }
              // `boxCount` = 1: un reel siempre es editable por capas; el resto
              // de las guardas (revisión, estado, posts vinculados) es igual.
              await assertEditable(tx, companyId, row, 1, body.revision);
              const foreign = await foreignPayloadAssets(tx, storage, companyId, {
                reel: body.reel,
              });
              if (foreign.length > 0) rejectForeign(foreign);
              await contentRepository.update(tx, { companyId }, row.id, {
                studioState: withReelSpec(row.studioState, body.reel),
              });
              await capturePreferenceEdit(
                tx,
                { companyId, contentId: row.id, nowMs: clock.nowMs() },
                request.log,
              );
              return bumpAndRebuild(
                tx,
                queue,
                companyId,
                row,
                { kind: "minor", atMs: clock.nowMs() },
                { reason: "edit" },
              );
            }),
        );
      } catch (e) {
        const rejected = sendRejection(reply, e);
        if (rejected !== null) return rejected;
        throw e;
      }
    },
  );

  // ── POST /reels/preview ──
  app.post(
    "/reels/preview",
    {
      schema: { body: reelPreviewRequestSchema },
      preHandler: [rateLimit(limiter, "restPerWorkspace")],
    },
    async (request, reply) => {
      const companyId = request.auth.companyId;
      const renderer = reelRendererFromEnv(process.env);
      if (renderer === null) {
        return reply.status(503).send({
          error: {
            code: "reel_preview_unavailable",
            message: "The render service isn't configured for previews.",
          },
        });
      }
      try {
        const spec = request.body.reel;
        const auth = await request.tx(async (tx) => {
          const foreign = await foreignPayloadAssets(tx, storage, companyId, {
            reel: spec,
          });
          if (foreign.length > 0) rejectForeign(foreign);
          return reelAuthorization(storage, companyId, reelMediaUrls(spec));
        });
        const preview = await renderer.previewReel(
          spec as unknown as Readonly<Record<string, unknown>>,
          auth,
        );
        return data(preview);
      } catch (e) {
        const rejected = sendRejection(reply, e);
        if (rejected !== null) return rejected;
        throw e;
      }
    },
  );

  // ── POST /reels/from-prompt ──
  app.post(
    "/reels/from-prompt",
    {
      schema: { body: reelFromPromptRequestSchema, headers: idempotencyHeaderSchema },
      preHandler: [
        rateLimit(limiter, "restPerWorkspace"),
        rateLimit(limiter, "contentBuilds"),
      ],
    },
    async (request, reply) => {
      if (queue === undefined) return queueUnavailable(reply);
      const body = request.body;
      const companyId = request.auth.companyId;
      try {
        return await withIdempotency(
          idempotency,
          request,
          reply,
          {
            key: idempotencyKeyOf(request.headers),
            route: "POST /reels/from-prompt",
            body,
            successStatus: 201,
          },
          () =>
            request.tx(async (tx) => {
              const assets = await pickReelAssets(tx, companyId, body.prompt);
              const strategy = await brandStrategyRepository.find(tx, { companyId });
              let spec: ReelSpec;
              try {
                const planned = reelSpecFromPlan(
                  planReel({
                    prompt: body.prompt,
                    template: body.template as ReelTemplate | undefined,
                    assets,
                    language: reelLanguageOf(strategy?.language ?? null),
                  }),
                );
                spec = reelSpecSchema.parse(planned);
              } catch {
                throw new ContentRejection(
                  400,
                  "bad_request",
                  "Couldn't plan a reel from that prompt. Try a short sentence to hook viewers.",
                );
              }
              const payload = { reel: spec };
              const foreign = await foreignPayloadAssets(tx, storage, companyId, payload);
              if (foreign.length > 0) rejectForeign(foreign);
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
                  type: "reel",
                  status: "BUILDING",
                  buildPayload: payload,
                  generatedText: [spec.layers]
                    .flat()
                    .flatMap((l) => (l.kind === "text" ? [l.text] : []))
                    .join("\n\n")
                    .slice(0, 2000),
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
              });
              return toContent(row);
            }),
        );
      } catch (e) {
        const rejected = sendRejection(reply, e);
        if (rejected !== null) return rejected;
        throw e;
      }
    },
  );
}
