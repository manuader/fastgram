/**
 * Posts · `GET /posts`, `GET /posts/:id`, `POST /content/:id/schedule`,
 * `POST /posts/cancel`, `POST /posts/delete` (PRD:2283-2285).
 *
 * Fuente: FR-060 (PRD:1327-1400), DATA-020 (PRD:2122), NFR-012 (PRD:2962).
 */
import { z } from "zod";
import {
  accountTypeSchema,
  captionAdjustmentReasonSchema,
  instagramSlideshowFormatSchema,
  postPlatformSchema,
  postStatusSchema,
  postingModeSchema,
  privacyLevelSchema,
  tiktokSoundModeSchema,
} from "../primitives/enums";
import {
  connectionIdSchema,
  contentIdSchema,
  msEpochSchema,
  postIdSchema,
  tiktokSoundIdSchema,
  warmedAccountIdSchema,
} from "../primitives/ids";
import { cursorQuerySchema } from "../primitives/pagination";

// --- Números del PRD ---------------------------------------------------------

/** F-153 (PRD:621) / FR-060 (PRD:1351) — Instagram `Caption 0/2200`. */
export const INSTAGRAM_CAPTION_MAX = 2200;
/** F-153 (PRD:621) / INT-001 (PRD:2444) — TikTok `title` ≤ 90. */
export const TIKTOK_TITLE_MAX = 90;
/** F-153 (PRD:621) / INT-001 (PRD:2444) — TikTok `description` ≤ 4000. */
export const TIKTOK_DESCRIPTION_MAX = 4000;
/** NFR-012 (PRD:2962) / F-162 (PRD:630) — máx. 100 ids por lote. */
export const BATCH_POST_IDS_MAX = 100;
/** FR-060 (PRD:1394) — "Warmed-account posts can only be scheduled up to 30 days ahead." */
export const WARMED_MAX_SCHEDULE_DAYS_AHEAD = 30;
/** NFR-015 (PRD:2965) / FR-060 (PRD:1385) — watcher del carril lento de TikTok. */
export const TIKTOK_SLOW_LANE_RETRY_HOURS = 72;

// --- Recurso · DATA-020 ------------------------------------------------------

/**
 * `connectionId` y `warmedAccountId` son **mutuamente excluyentes**
 * (DATA-020 PRD:2128, FR-060 PRD:1374).
 */
const accountRef = z
  .object({
    connectionId: connectionIdSchema.optional(),
    warmedAccountId: warmedAccountIdSchema.optional(),
  })
  .refine((v) => !(v.connectionId !== undefined && v.warmedAccountId !== undefined), {
    message: "connectionId and warmedAccountId are mutually exclusive",
  });

export const postSchema = z
  .object({
    _id: postIdSchema,
    contentId: contentIdSchema,
    platform: postPlatformSchema,
    accountType: accountTypeSchema,
    connectionId: connectionIdSchema.optional(),
    warmedAccountId: warmedAccountIdSchema.optional(),
    connectionUsername: z.string().optional(),
    scheduledAtUtc: msEpochSchema,
    caption: z.string(),
    description: z.string(),
    publishedCaption: z.string().optional(),
    captionAdjustmentReason: captionAdjustmentReasonSchema.optional(),
    discloseAsAds: z.boolean().optional(),
    aiContentDisclaimer: z.boolean().optional(),
    instagramSlideshowFormat: instagramSlideshowFormatSchema.optional(),
    tiktokSoundMode: tiktokSoundModeSchema.optional(),
    tiktokSoundId: tiktokSoundIdSchema.optional(),
    postingMode: postingModeSchema.optional(),
    privacyLevel: privacyLevelSchema.optional(),
    status: postStatusSchema,
    cancellationPending: z.boolean().optional(),
    tiktokProcessingDelayed: z.boolean().optional(),
    /**
     * "neutrales respecto al proveedor" (DATA-020, PRD:2143). El PRD da un
     * ejemplo (`instagram_repeated_mention`) pero no una lista cerrada, así que
     * no se contrata como enum.
     */
    errorCode: z.string().optional(),
    errorMessage: z.string().optional(),
    postUrl: z.string().url().optional(),
    postedAt: msEpochSchema.optional(),
    views: z.number().int().nonnegative(),
    likes: z.number().int().nonnegative(),
    comments: z.number().int().nonnegative(),
  })
  .strict()
  .refine((p) => !(p.connectionId !== undefined && p.warmedAccountId !== undefined), {
    message: "connectionId and warmedAccountId are mutually exclusive",
  });
export type Post = z.infer<typeof postSchema>;

// --- Listado -----------------------------------------------------------------

/**
 * `GET /posts` · §12 (PRD:2720): `status` como lista separada por comas.
 * La lista que el PRD enumera para el filtro **no incluye** `CANCELLED`, que sí
 * es un estado válido del post (FR-060, PRD:1379). Se copia tal cual.
 */
export const postStatusFilterSchema = z.enum([
  "BUILDING",
  "CREATED",
  "SCHEDULED",
  "UPLOADING_TO_TIKTOK",
  "IN_USER_INBOX",
  "POSTED",
  "FAILED",
  "DELETED",
  "AWAITING_RECONNECT",
]);
export type PostStatusFilter = z.infer<typeof postStatusFilterSchema>;

export const listPostsQuerySchema = cursorQuerySchema
  .extend({
    status: z
      .string()
      .min(1)
      .transform((raw) => raw.split(","))
      .pipe(z.array(postStatusFilterSchema).min(1))
      .optional(),
  })
  .strict();
export type ListPostsQuery = z.infer<typeof listPostsQuerySchema>;

// --- Programación · FR-060 ---------------------------------------------------

const targetBase = {
  connectionId: connectionIdSchema.optional(),
  warmedAccountId: warmedAccountIdSchema.optional(),
  discloseAsAds: z.boolean().optional(),
  aiContentDisclaimer: z.boolean().optional(),
};

const mutuallyExclusiveAccount = <T extends z.ZodTypeAny>(schema: T) =>
  schema.refine(
    (v: unknown) => {
      const t = v as { connectionId?: unknown; warmedAccountId?: unknown };
      return !(t.connectionId !== undefined && t.warmedAccountId !== undefined);
    },
    { message: "connectionId and warmedAccountId are mutually exclusive" },
  );

/**
 * TikTok. `postingMode` es **sólo OAuth**: se rechaza junto con
 * `warmedAccountId` (FR-060, PRD:1375). `privacyLevel` es obligatorio con
 * `postingMode: "direct"` y no se permite sin él
 * (`privacy_level_not_allowed_without_direct_mode`, PRD:1390).
 */
export const tiktokScheduleTargetSchema = mutuallyExclusiveAccount(
  z
    .object({
      ...targetBase,
      platform: z.literal("tiktok"),
      title: z.string().max(TIKTOK_TITLE_MAX).optional(),
      description: z.string().max(TIKTOK_DESCRIPTION_MAX).optional(),
      postingMode: postingModeSchema.optional(),
      privacyLevel: privacyLevelSchema.optional(),
      tiktokSoundId: tiktokSoundIdSchema.optional(),
      tiktokSoundMode: tiktokSoundModeSchema.optional(),
    })
    .strict()
    .superRefine((t, ctx) => {
      if (t.postingMode !== undefined && t.warmedAccountId !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["postingMode"],
          message: "posting_mode_not_supported_for_platform: TikTok OAuth only",
        });
      }
      if (t.postingMode === "direct" && t.privacyLevel === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["privacyLevel"],
          message: "privacy_level_required",
        });
      }
      if (t.privacyLevel !== undefined && t.postingMode !== "direct") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["privacyLevel"],
          message: "privacy_level_not_allowed_without_direct_mode",
        });
      }
    }),
);
export type TiktokScheduleTarget = z.infer<typeof tiktokScheduleTargetSchema>;

/** Instagram · `Caption 0/2200` (PRD:1351); `carousel`/`reel` sólo warmed (PRD:626). */
export const instagramScheduleTargetSchema = mutuallyExclusiveAccount(
  z
    .object({
      ...targetBase,
      platform: z.literal("instagram"),
      caption: z.string().max(INSTAGRAM_CAPTION_MAX).optional(),
      instagramSlideshowFormat: instagramSlideshowFormatSchema.optional(),
    })
    .strict(),
);
export type InstagramScheduleTarget = z.infer<typeof instagramScheduleTargetSchema>;

/**
 * YouTube · FR-060 (PRD:1353): "`caption` = título del video, `description` =
 * cuerpo". El PRD no da límites de longitud para YouTube: no se inventan.
 */
export const youtubeScheduleTargetSchema = mutuallyExclusiveAccount(
  z
    .object({
      ...targetBase,
      platform: z.literal("youtube"),
      caption: z.string().optional(),
      description: z.string().optional(),
    })
    .strict(),
);
export type YoutubeScheduleTarget = z.infer<typeof youtubeScheduleTargetSchema>;

/**
 * Reddit. El PRD sólo dice que **no** soporta generación de caption (FR-060,
 * PRD:1376) y que la publicación es sólo OAuth (PRD:1374). No enumera campos de
 * copy, así que sólo se contrata `caption`, que es el mínimo común.
 */
export const redditScheduleTargetSchema = z
  .object({
    ...targetBase,
    platform: z.literal("reddit"),
    caption: z.string().optional(),
  })
  .omit({ warmedAccountId: true })
  .strict();
export type RedditScheduleTarget = z.infer<typeof redditScheduleTargetSchema>;

export const scheduleTargetSchema = z.union([
  tiktokScheduleTargetSchema,
  instagramScheduleTargetSchema,
  youtubeScheduleTargetSchema,
  redditScheduleTargetSchema,
]);
export type ScheduleTarget = z.infer<typeof scheduleTargetSchema>;

/**
 * `POST /content/:id/schedule`.
 *
 * `enableCaptionGeneration` rellena **sólo** campos vacíos u omitidos; los
 * valores explícitos no vacíos siempre ganan (AI-006, PRD:2625).
 *
 * El PRD documenta además una opción de "publicar ahora" (F-157, PRD:625) pero
 * no nombra su campo: no se contrata. Ver el reporte.
 */
export const scheduleContentRequestSchema = z
  .object({
    scheduledAtUtc: msEpochSchema,
    targets: z.array(scheduleTargetSchema).min(1),
    enableCaptionGeneration: z.boolean().optional(),
  })
  .strict();
export type ScheduleContentRequest = z.infer<typeof scheduleContentRequestSchema>;

// --- Lotes · NFR-012 ---------------------------------------------------------

/**
 * "Máx. 100 ids por llamada en cancel, delete y analytics de posts; ids
 * duplicados **deduplicados antes** de aplicar el cap" (NFR-012, PRD:2962).
 * El orden importa: 150 ids con 60 repetidos son 90 únicos y la llamada es
 * válida. Por eso el `transform` va antes del `max`.
 */
export const batchPostIdsSchema = z
  .array(postIdSchema)
  .min(1)
  .transform((ids) => [...new Set(ids)])
  .pipe(z.array(postIdSchema).max(BATCH_POST_IDS_MAX));

/** `POST /posts/cancel` — todo o nada (NFR-011, PRD:2961; ERR-F01, PRD:3200). */
export const cancelPostsRequestSchema = z
  .object({ postIds: batchPostIdsSchema })
  .strict();
export type CancelPostsRequest = z.infer<typeof cancelPostsRequestSchema>;

/** `POST /posts/delete` — mismas reglas de lote que cancel. */
export const deletePostsRequestSchema = z
  .object({ postIds: batchPostIdsSchema })
  .strict();
export type DeletePostsRequest = z.infer<typeof deletePostsRequestSchema>;

export { accountRef as postAccountRefSchema };
