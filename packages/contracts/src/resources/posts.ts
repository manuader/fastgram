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
  contentStatusSchema,
  contentTypeSchema,
  instagramSlideshowFormatSchema,
  postPlatformSchema,
  postStatusSchema,
  postingModeSchema,
  privacyLevelSchema,
  tiktokSoundModeSchema,
} from "../primitives/enums.js";
import {
  connectionIdSchema,
  contentIdSchema,
  msEpochSchema,
  postIdSchema,
  tiktokSoundIdSchema,
  warmedAccountIdSchema,
} from "../primitives/ids.js";
import { cursorQuerySchema } from "../primitives/pagination.js";

// --- Números del PRD ---------------------------------------------------------

/** F-153 (PRD:621) / FR-060 (PRD:1351) — Instagram `Caption 0/2200`. */
export const INSTAGRAM_CAPTION_MAX = 2200;
/** F-153 (PRD:621) / INT-001 (PRD:2444) — TikTok `title` ≤ 90. */
export const TIKTOK_TITLE_MAX = 90;
/** F-153 (PRD:621) / INT-001 (PRD:2444) — TikTok `description` ≤ 4000. */
export const TIKTOK_DESCRIPTION_MAX = 4000;
/**
 * X · 280 caracteres (`docs.x.com/fundamentals/counting-characters`, citado en
 * `packages/adapters/src/publishers/x/x-publisher.ts`). Se cuenta **por code
 * point**, igual que el pre-flight del adaptador (`assertPublishable`): X pondera
 * (URL = 23, emoji = 2) y ese conteo no se replica acá, así que un texto con
 * muchos emojis puede pasar y rebotar en X. Es el mismo hueco del adaptador.
 */
export const X_TEXT_MAX = 280;
/** Threads · «Text posts are limited to 500 characters» (adaptador de Threads). */
export const THREADS_TEXT_MAX = 500;
/**
 * Facebook Reels · `description`. La guía de Meta no publica un tope; el
 * adaptador toma el de Instagram como techo conservador (**no verificado**).
 */
export const FACEBOOK_CAPTION_MAX = 2200;
/**
 * YouTube · `snippet.title` *"Maximum 100 characters"*; `snippet.description`
 * *"Maximum 5000 bytes"* — https://developers.google.com/youtube/v3/docs/videos
 * (`PU-LATER-001`). El contrato cuenta caracteres (code points); el adaptador
 * mide los bytes UTF-8 de la descripción antes de subir.
 */
export const YOUTUBE_TITLE_MAX = 100;
export const YOUTUBE_DESCRIPTION_MAX = 5000;
/**
 * LinkedIn · *"The maximum length of the text of a UGC Post is 3,000
 * characters"* — https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/ugc-post-api
 * (la Posts API usa el mismo campo, `commentary`; `PU-LATER-002`).
 */
export const LINKEDIN_COMMENTARY_MAX = 3000;
/** NFR-012 (PRD:2962) / F-162 (PRD:630) — máx. 100 ids por lote. */
export const BATCH_POST_IDS_MAX = 100;
/** FR-060 (PRD:1394) — "Warmed-account posts can only be scheduled up to 30 days ahead." */
export const WARMED_MAX_SCHEDULE_DAYS_AHEAD = 30;
/** `GET /posts?from&to` — el mismo techo que `GET /calendar` (`CALENDAR_RANGE_MAX_DAYS`). */
export const POSTS_RANGE_MAX_DAYS = 62;
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
    /**
     * Rango del calendario (`PU-CAL-002`), ms epoch, `[from, to)` en UTC. Van
     * **juntos o ninguno** (la ruta responde `400` con uno solo) y cambian el
     * modo del listado: la fecha que filtra y ordena es la **efectiva**
     * —`coalesce(postedAt, scheduledAtUtc)`—, en orden **ascendente**, y el
     * cursor es de ese modo (no se puede reusar uno del listado sin rango).
     * Propuesta de `docs/SESSION-2026-09-23-sexta-tanda.md`; no está en §12 del
     * PRD. Rango máximo: {@link POSTS_RANGE_MAX_DAYS} días.
     */
    from: z.coerce.number().int().nonnegative().optional(),
    to: z.coerce.number().int().nonnegative().optional(),
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
 * cuerpo". Los topes son los de la API ({@link YOUTUBE_TITLE_MAX},
 * {@link YOUTUBE_DESCRIPTION_MAX}). El publicador es de Shorts por OAuth
 * (`PU-LATER-001`); una cuenta warmed de YouTube la rechaza core (FR-130).
 * Los topes van por code point y con `refine` escrito acá porque
 * `codePointText` se declara más abajo.
 */
export const youtubeScheduleTargetSchema = mutuallyExclusiveAccount(
  z
    .object({
      ...targetBase,
      platform: z.literal("youtube"),
      caption: z
        .string()
        .refine((s) => [...s].length <= YOUTUBE_TITLE_MAX, {
          message: `must be ${String(YOUTUBE_TITLE_MAX)} characters or fewer`,
        })
        .optional(),
      description: z
        .string()
        .refine((s) => [...s].length <= YOUTUBE_DESCRIPTION_MAX, {
          message: `must be ${String(YOUTUBE_DESCRIPTION_MAX)} characters or fewer`,
        })
        .optional(),
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

/**
 * Largo por **code point** (`[...s].length`), no por unidad UTF-16 como
 * `z.string().max()`: es lo que cuenta el pre-flight de los adaptadores
 * (`packages/adapters/src/publishers/shared/base.ts`), y un emoji fuera del BMP
 * son dos unidades UTF-16. Con `.max()` el contrato rechazaría textos que el
 * publicador acepta. En OpenAPI no sale como `maxLength` (el conversor describe
 * el lado de entrada de un `refine`); el número está en la descripción del `400`.
 */
const codePointText = (max: number) =>
  z.string().refine((s) => [...s].length <= max, {
    message: `must be ${String(max)} characters or fewer`,
  });

/**
 * X, Threads y Facebook (`D-09`). Las tres publican **sólo por OAuth** (las
 * cuentas warmed son de TikTok e Instagram, FR-130), así que, como Reddit, no
 * llevan `warmedAccountId`. Tampoco `postingMode` ni `privacyLevel`, que son
 * sólo TikTok. El único campo de copy es `caption`: el texto del post en X y
 * Threads, la `description` del reel en Facebook.
 *
 * La Página de Facebook no se elige acá: es la conexión (`connectionId`), que
 * se crea eligiendo una Página en `POST /connections/facebook/pages`.
 */
export const xScheduleTargetSchema = z
  .object({
    ...targetBase,
    platform: z.literal("x"),
    caption: codePointText(X_TEXT_MAX).optional(),
  })
  .omit({ warmedAccountId: true })
  .strict();
export type XScheduleTarget = z.infer<typeof xScheduleTargetSchema>;

export const threadsScheduleTargetSchema = z
  .object({
    ...targetBase,
    platform: z.literal("threads"),
    caption: codePointText(THREADS_TEXT_MAX).optional(),
  })
  .omit({ warmedAccountId: true })
  .strict();
export type ThreadsScheduleTarget = z.infer<typeof threadsScheduleTargetSchema>;

export const facebookScheduleTargetSchema = z
  .object({
    ...targetBase,
    platform: z.literal("facebook"),
    caption: codePointText(FACEBOOK_CAPTION_MAX).optional(),
  })
  .omit({ warmedAccountId: true })
  .strict();
export type FacebookScheduleTarget = z.infer<typeof facebookScheduleTargetSchema>;

/**
 * LinkedIn (`PU-LATER-002`). Sólo OAuth, como X/Threads/Facebook. `caption` es
 * el `commentary` del post. Perfil o Página se elige al conectar: es la
 * conexión (`connectionId`), creada en `POST /connections/linkedin/pages`
 * cuando la cuenta administra Páginas.
 */
export const linkedinScheduleTargetSchema = z
  .object({
    ...targetBase,
    platform: z.literal("linkedin"),
    caption: codePointText(LINKEDIN_COMMENTARY_MAX).optional(),
  })
  .omit({ warmedAccountId: true })
  .strict();
export type LinkedinScheduleTarget = z.infer<typeof linkedinScheduleTargetSchema>;

export const scheduleTargetSchema = z.union([
  tiktokScheduleTargetSchema,
  instagramScheduleTargetSchema,
  youtubeScheduleTargetSchema,
  redditScheduleTargetSchema,
  xScheduleTargetSchema,
  threadsScheduleTargetSchema,
  facebookScheduleTargetSchema,
  linkedinScheduleTargetSchema,
]);
export type ScheduleTarget = z.infer<typeof scheduleTargetSchema>;

/**
 * Margen de «Post now» (F-157): el post se programa a `ahora + esto`. No es
 * `ahora` a secas porque el job entra a la cola dentro de la transacción y el
 * publicador saltea un post cuya hora todavía no llegó; unos segundos dejan
 * además un instante para cancelar. Número nuestro (sprint 7), no del PRD.
 */
export const POST_NOW_LEAD_MS = 30_000;

/**
 * `POST /content/:id/schedule`.
 *
 * `enableCaptionGeneration` rellena **sólo** campos vacíos u omitidos; los
 * valores explícitos no vacíos siempre ganan (AI-006, PRD:2625).
 *
 * **Caption omitida ≠ caption vacía** (sprint 7): un target sin `caption` (o
 * sin `title`/`description` en TikTok/YouTube) recibe la derivada de la copy
 * de la pieza (`deriveCaption` de `@fastgram/core`); un `""` explícito es
 * «vacía a propósito» y se respeta.
 *
 * `postNow` (F-157, "publicar ahora": el PRD no nombra el campo; el nombre es
 * nuestro, sprint 7): programa a `ahora + POST_NOW_LEAD_MS` e ignora
 * `scheduledAtUtc`, que pasa a ser opcional. Sin `postNow`, `scheduledAtUtc`
 * es obligatorio y tiene que ser futuro: una hora pasada nunca se lee como
 * «ahora» por accidente.
 */
export const scheduleContentRequestSchema = z
  .object({
    scheduledAtUtc: msEpochSchema.optional(),
    postNow: z.boolean().optional(),
    targets: z.array(scheduleTargetSchema).min(1),
    enableCaptionGeneration: z.boolean().optional(),
  })
  .strict()
  .refine((v) => v.postNow === true || v.scheduledAtUtc !== undefined, {
    message: "scheduledAtUtc is required unless postNow is true",
    path: ["scheduledAtUtc"],
  });
export type ScheduleContentRequest = z.infer<typeof scheduleContentRequestSchema>;

// --- Caption · sprint 7 (publish-flow) ---------------------------------------

export const captionFieldSchema = z.enum(["caption", "description"]);
export type CaptionFieldName = z.infer<typeof captionFieldSchema>;

export const captionAiModeSchema = z.enum(["improve", "regenerate"]);
export type CaptionAiModeName = z.infer<typeof captionAiModeSchema>;

/** Tope del texto que se manda a mejorar (el mayor de las redes, YouTube). */
export const CAPTION_IMPROVE_INPUT_MAX = 5000;

/**
 * `POST /content/:id/caption` — genera (`regenerate`) o mejora (`improve`) el
 * campo `field` de la red `platform` con el modelo `text` del registro. No
 * escribe nada: devuelve el texto para que el usuario lo vea en el diálogo.
 * `field` omitido = `caption`. `text` es obligatorio en `improve`.
 *
 * Errores: `503 service_unavailable` con `details.reason` =
 * `llm_not_configured` | `llm_failed` | `caption_rejected` (códigos de
 * `errorCodeSchema`: uno nuevo sería `invalid_response` en el cliente web), y
 * `400 bad_request` (Reddit, campo que la red no tiene, `improve` sin texto).
 */
export const generateCaptionRequestSchema = z
  .object({
    platform: postPlatformSchema,
    field: captionFieldSchema.optional(),
    mode: captionAiModeSchema,
    text: z.string().max(CAPTION_IMPROVE_INPUT_MAX).optional(),
  })
  .strict();
export type GenerateCaptionRequest = z.infer<typeof generateCaptionRequestSchema>;

export const generatedCaptionSchema = z
  .object({
    platform: postPlatformSchema,
    field: captionFieldSchema,
    text: z.string(),
    /** El modelo que respondió (del registro). */
    model: z.string(),
  })
  .strict();
export type GeneratedCaption = z.infer<typeof generatedCaptionSchema>;

/**
 * `GET /content/:id/schedule-options` — todo lo que el diálogo de Schedule
 * necesita en una sola vuelta: la caption por defecto de cada red (derivada de
 * la pieza), las conexiones activas por red, qué redes están en la estrategia
 * y el próximo horario libre de cada una (el mismo cálculo del auto-slot, sin
 * escribir nada), y la zona horaria de la marca.
 */
export const scheduleOptionsSchema = z
  .object({
    contentId: contentIdSchema,
    contentType: contentTypeSchema,
    contentStatus: contentStatusSchema,
    timezone: z.string(),
    /** El más temprano de `networks[].suggestedAtUtc`, o `null`. */
    suggestedAtUtc: msEpochSchema.nullable(),
    /** `PUBLISH_X_ALLOW_LINKS`: si X conserva las URLs. */
    xAllowLinks: z.boolean(),
    networks: z.array(
      z
        .object({
          network: postPlatformSchema,
          inStrategy: z.boolean(),
          /** Próximo horario libre de la estrategia; `null` si no está o no hay. */
          suggestedAtUtc: msEpochSchema.nullable(),
          /** Si esta pieza ya tiene un post vivo o un slot en esta red. */
          alreadyScheduled: z.boolean(),
          connections: z.array(
            z.object({ connectionId: connectionIdSchema, username: z.string() }).strict(),
          ),
          caption: z.string().nullable(),
          description: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();
export type ScheduleOptions = z.infer<typeof scheduleOptionsSchema>;

// --- Acciones sobre un post · sprint 7 ---------------------------------------

/**
 * `POST /posts/:id/retry` — vuelve a encolar un post `FAILED` con la misma
 * pieza. Sin `scheduledAtUtc`, a `ahora + POST_NOW_LEAD_MS`; con él (futuro),
 * a esa hora (es el «Reschedule» de un fallido). Las guardas anti-bot corren
 * igual al publicar.
 *
 * `confirmNotPublished` es obligatorio cuando el fallo fue
 * `delivery_unconfirmed` o `platform_processing_timeout`: la plataforma pudo
 * haberlo publicado, y reintentar a ciegas lo duplicaría (`NFR-015`). Sin la
 * confirmación: `409 conflict`.
 *
 * `brandId`, como en `mark-posted`: la marca del post, para actuar desde una
 * vista de todas las marcas.
 */
export const retryPostRequestSchema = z
  .object({
    scheduledAtUtc: msEpochSchema.optional(),
    confirmNotPublished: z.boolean().optional(),
    brandId: z.string().uuid().optional(),
  })
  .strict();
export type RetryPostRequest = z.infer<typeof retryPostRequestSchema>;

/**
 * `PATCH /posts/:id` — editar la caption (y la descripción donde la red la
 * tiene) y/o la hora de un post que todavía no salió (`SCHEDULED`,
 * `BUILDING`, `AWAITING_RECONNECT`). Cambiar la hora es lo mismo que mover el
 * post en el calendario: la fila vieja pasa a `CANCELLED` y se crea otra con su
 * job (ver `routes/v1/calendar.ts`), así que la respuesta puede traer **otro
 * `_id`**. Los topes por red se validan en la ruta (la red es la del post).
 */
export const updatePostRequestSchema = z
  .object({
    caption: z.string().max(CAPTION_IMPROVE_INPUT_MAX).optional(),
    description: z.string().max(CAPTION_IMPROVE_INPUT_MAX).optional(),
    scheduledAtUtc: msEpochSchema.optional(),
    brandId: z.string().uuid().optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.caption !== undefined ||
      v.description !== undefined ||
      v.scheduledAtUtc !== undefined,
    { message: "Nothing to update" },
  );
export type UpdatePostRequest = z.infer<typeof updatePostRequestSchema>;

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

// --- Marcar publicado a mano · PU-UI-002 ------------------------------------

/**
 * `POST /posts/{id}/mark-posted` — el borrador de TikTok que el usuario terminó
 * en la app (FR-060: `IN_USER_INBOX` queda esperando una acción **suya**, y la
 * API de TikTok no avisa cuando la hace). Sólo `IN_USER_INBOX` → `POSTED`, con
 * `postedAt` = ahora; cualquier otro estado es `409`.
 *
 * No es del PRD: lo pide la pantalla "Today" de `docs/PLAN-USO-PERSONAL.md` §7.
 *
 * `brandId` es la marca del post, para marcar desde una vista de **todas** las
 * marcas sin cambiar la activa: el proxy de la web sólo reenvía la marca de su
 * cookie. Mismo criterio que `PATCH /calendar/items/{kind}/{id}`: sin él, la
 * marca de la request (`X-Fastgram-Workspace` o la de la key); con uno de otro
 * dueño, `404`.
 */
export const markPostedRequestSchema = z
  .object({ brandId: z.string().uuid().optional() })
  .strict();
export type MarkPostedRequest = z.infer<typeof markPostedRequestSchema>;

export { accountRef as postAccountRefSchema };
