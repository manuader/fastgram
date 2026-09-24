"use client";

/**
 * Programar a mano y actuar sobre posts — sprint 7 (publish-flow).
 *
 * | Qué                                   | Endpoint                                 |
 * |---------------------------------------|------------------------------------------|
 * | opciones del diálogo                  | `GET /content/:id/schedule-options`      |
 * | programar / Post now                  | `POST /content/:id/schedule`             |
 * | Improve / Regenerate de un campo      | `POST /content/:id/caption`              |
 * | reintentar / reprogramar un fallido   | `POST /posts/:id/retry`                  |
 * | editar caption u hora                 | `PATCH /posts/:id`                       |
 * | cancelar / borrar en lote             | `POST /posts/cancel`, `POST /posts/delete` |
 * | refrescar métricas                    | `POST /analytics/sync` (`useRequestSync`) |
 *
 * Todo lo que escribe invalida `["posts"]`: la Library, el calendario y Today
 * cuelgan de ese prefijo (`queryKeys.calendarPosts`).
 *
 * La lógica pura (topes por red, conteo por code point, hora local de la marca
 * ↔ UTC, armar los `targets`) está exportada para testearla sin montar nada.
 */
import {
  FACEBOOK_CAPTION_MAX,
  INSTAGRAM_CAPTION_MAX,
  LINKEDIN_COMMENTARY_MAX,
  THREADS_TEXT_MAX,
  TIKTOK_DESCRIPTION_MAX,
  TIKTOK_TITLE_MAX,
  X_TEXT_MAX,
  YOUTUBE_DESCRIPTION_MAX,
  YOUTUBE_TITLE_MAX,
  generatedCaptionSchema,
  postSchema,
  scheduleOptionsSchema,
  type CaptionAiModeName,
  type CaptionFieldName,
  type GeneratedCaption,
  type Post,
  type PostPlatform,
  type PrivacyLevel,
  type ScheduleOptions,
} from "@fastgram/contracts";
import { useMutation, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { z } from "zod";
import { apiRequest, apiSend } from "../api/client";
import type { ApiRequestError } from "../api/errors";
import { useApiQuery } from "../api/hooks";

// ---------------------------------------------------------------------------
// Topes por red
// ---------------------------------------------------------------------------

export interface FieldLimits {
  /** Instagram/X/…: el texto · TikTok/YouTube: el título. `null` = sin tope verificado. */
  readonly caption: number | null;
  /** Sólo TikTok y YouTube. */
  readonly description: number | null;
}

/** Los mismos topes que el contrato y los publicadores (por code point). */
export const PLATFORM_LIMITS: Readonly<Record<PostPlatform, FieldLimits>> = {
  instagram: { caption: INSTAGRAM_CAPTION_MAX, description: null },
  tiktok: { caption: TIKTOK_TITLE_MAX, description: TIKTOK_DESCRIPTION_MAX },
  youtube: { caption: YOUTUBE_TITLE_MAX, description: YOUTUBE_DESCRIPTION_MAX },
  linkedin: { caption: LINKEDIN_COMMENTARY_MAX, description: null },
  reddit: { caption: null, description: null },
  x: { caption: X_TEXT_MAX, description: null },
  threads: { caption: THREADS_TEXT_MAX, description: null },
  facebook: { caption: FACEBOOK_CAPTION_MAX, description: null },
};

/** Redes con caption por IA (Reddit no: `INT-005`). */
export function supportsCaptionAi(platform: PostPlatform): boolean {
  return platform !== "reddit";
}

/** Largo en code points, como el pre-flight de los publicadores. */
export function codePoints(text: string): number {
  return [...text].length;
}

export function isOverLimit(text: string, max: number | null): boolean {
  return max !== null && codePoints(text) > max;
}

// ---------------------------------------------------------------------------
// Hora local de la marca ↔ UTC
// ---------------------------------------------------------------------------

function offsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24,
    get("minute"),
    get("second"),
  );
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/**
 * `"2026-09-25"` + `"14:30"` en `timeZone` → ms UTC. `null` si no parsea.
 * Dos pasadas para caer bien alrededor de un cambio de horario.
 */
export function zonedToUtc(date: string, time: string, timeZone: string): number | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^(\d{2}):(\d{2})$/.exec(time);
  if (d === null || t === null) return null;
  const wall = Date.UTC(
    Number(d[1]),
    Number(d[2]) - 1,
    Number(d[3]),
    Number(t[1]),
    Number(t[2]),
  );
  let guess = wall - offsetMs(wall, timeZone);
  guess = wall - offsetMs(guess, timeZone);
  return guess;
}

/** ms UTC → `{date: "YYYY-MM-DD", time: "HH:mm"}` en `timeZone`. */
export function utcToZoned(
  ms: number,
  timeZone: string,
): { readonly date: string; readonly time: string } {
  const shifted = new Date(ms + offsetMs(ms, timeZone));
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    date: `${String(shifted.getUTCFullYear())}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`,
    time: `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`,
  };
}

/** La hora por defecto: la sugerida por la estrategia, o dentro de una hora redondeada. */
export function defaultScheduleMs(
  options: ScheduleOptions | undefined,
  nowMs: number,
): number {
  const suggested = options?.suggestedAtUtc ?? null;
  if (suggested !== null && suggested > nowMs) return suggested;
  const hour = 3_600_000;
  return Math.ceil((nowMs + hour) / (15 * 60_000)) * 15 * 60_000;
}

// ---------------------------------------------------------------------------
// Estado del diálogo → targets
// ---------------------------------------------------------------------------

export interface NetworkDraft {
  readonly network: PostPlatform;
  readonly selected: boolean;
  readonly connectionId: string | null;
  readonly caption: string;
  readonly description: string;
  /** Instagram con slideshow: `carousel` (default) o `reel`. */
  readonly instagramSlideshowFormat: "carousel" | "reel";
  readonly aiContentDisclaimer: boolean;
  /** TikTok: `null` = borrador en el inbox (D-10, default). */
  readonly tiktokPrivacy: PrivacyLevel | null;
}

/** Los borradores iniciales, uno por red que tiene conexión o está en la estrategia. */
export function initialDrafts(options: ScheduleOptions): NetworkDraft[] {
  return options.networks
    .filter((n) => n.connections.length > 0 || n.inStrategy)
    .map((n) => ({
      network: n.network,
      // Preseleccionadas: las conectadas que la estrategia usa y que la pieza
      // todavía no tiene programadas.
      selected: n.connections.length > 0 && n.inStrategy && !n.alreadyScheduled,
      connectionId: n.connections[0]?.connectionId ?? null,
      caption: n.caption ?? "",
      description: n.description ?? "",
      instagramSlideshowFormat: "carousel",
      aiContentDisclaimer: false,
      tiktokPrivacy: null,
    }));
}

/** Por qué no se puede programar (clave de copy) o `null` si está listo. */
export type DraftProblem =
  | { readonly kind: "none_selected" }
  | { readonly kind: "no_connection"; readonly network: PostPlatform }
  | {
      readonly kind: "too_long";
      readonly network: PostPlatform;
      readonly field: CaptionFieldName;
    };

export function draftProblems(drafts: readonly NetworkDraft[]): DraftProblem[] {
  const selected = drafts.filter((d) => d.selected);
  if (selected.length === 0) return [{ kind: "none_selected" }];
  const out: DraftProblem[] = [];
  for (const d of selected) {
    if (d.connectionId === null) out.push({ kind: "no_connection", network: d.network });
    const limits = PLATFORM_LIMITS[d.network];
    if (isOverLimit(d.caption, limits.caption))
      out.push({ kind: "too_long", network: d.network, field: "caption" });
    if (limits.description !== null && isOverLimit(d.description, limits.description))
      out.push({ kind: "too_long", network: d.network, field: "description" });
  }
  return out;
}

/**
 * El cuerpo de `targets` de `POST /content/:id/schedule`. Una caption vacía se
 * manda como `""` (vacía **a propósito**: la API la respeta); lo que el usuario
 * no tocó ya viene relleno con la derivada.
 */
export function targetsOf(
  drafts: readonly NetworkDraft[],
  contentType: ScheduleOptions["contentType"],
): Record<string, unknown>[] {
  return drafts
    .filter((d) => d.selected && d.connectionId !== null)
    .map((d) => {
      const base = {
        platform: d.network,
        connectionId: d.connectionId,
        ...(d.aiContentDisclaimer ? { aiContentDisclaimer: true } : {}),
      };
      switch (d.network) {
        case "tiktok":
          return {
            ...base,
            title: d.caption,
            description: d.description,
            ...(d.tiktokPrivacy === null
              ? {}
              : { postingMode: "direct", privacyLevel: d.tiktokPrivacy }),
          };
        case "youtube":
          return { ...base, caption: d.caption, description: d.description };
        case "instagram":
          return {
            ...base,
            caption: d.caption,
            ...(contentType === "slideshow"
              ? { instagramSlideshowFormat: d.instagramSlideshowFormat }
              : {}),
          };
        default:
          return { ...base, caption: d.caption };
      }
    });
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export const scheduleOptionsPath = (contentId: string) =>
  `content/${encodeURIComponent(contentId)}/schedule-options`;
export const schedulePath = (contentId: string) =>
  `content/${encodeURIComponent(contentId)}/schedule`;
export const captionPath = (contentId: string) =>
  `content/${encodeURIComponent(contentId)}/caption`;
export const retryPath = (postId: string) => `posts/${encodeURIComponent(postId)}/retry`;
export const postPath = (postId: string) => `posts/${encodeURIComponent(postId)}`;

export const scheduleKeys = {
  options: (contentId: string) => ["content", contentId, "schedule-options"] as const,
};

export function useScheduleOptions(
  contentId: string,
  enabled = true,
): UseQueryResult<ScheduleOptions, ApiRequestError> {
  return useApiQuery<ScheduleOptions>({
    queryKey: scheduleKeys.options(contentId),
    path: scheduleOptionsPath(contentId),
    schema: scheduleOptionsSchema,
    enabled,
    staleTime: 0,
  });
}

export interface ScheduleVariables {
  readonly targets: readonly Record<string, unknown>[];
  /** `null` = Post now. */
  readonly scheduledAtUtc: number | null;
}

export function useSchedulePost(contentId: string) {
  const queryClient = useQueryClient();
  return useMutation<readonly Post[], ApiRequestError, ScheduleVariables>({
    mutationFn: ({ targets, scheduledAtUtc }) =>
      apiRequest<readonly Post[]>(schedulePath(contentId), {
        method: "POST",
        body:
          scheduledAtUtc === null
            ? { postNow: true, targets }
            : { scheduledAtUtc, targets },
        schema: z.array(postSchema),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["posts"] });
      void queryClient.invalidateQueries({ queryKey: scheduleKeys.options(contentId) });
    },
  });
}

export interface CaptionVariables {
  readonly platform: PostPlatform;
  readonly field: CaptionFieldName;
  readonly mode: CaptionAiModeName;
  readonly text?: string;
}

export function useGenerateCaption(contentId: string) {
  return useMutation<GeneratedCaption, ApiRequestError, CaptionVariables>({
    mutationFn: ({ platform, field, mode, text }) =>
      apiRequest<GeneratedCaption>(captionPath(contentId), {
        method: "POST",
        body: {
          platform,
          field,
          mode,
          ...(mode === "improve" && text !== undefined ? { text } : {}),
        },
        schema: generatedCaptionSchema,
      }),
  });
}

export interface RetryVariables {
  readonly postId: string;
  readonly brandId?: string;
  /** Sin hora: ya (ahora + margen). */
  readonly scheduledAtUtc?: number;
  readonly confirmNotPublished?: boolean;
}

export function useRetryPost() {
  const queryClient = useQueryClient();
  return useMutation<Post, ApiRequestError, RetryVariables>({
    mutationFn: ({ postId, brandId, scheduledAtUtc, confirmNotPublished }) =>
      apiRequest<Post>(retryPath(postId), {
        method: "POST",
        body: {
          ...(brandId === undefined ? {} : { brandId }),
          ...(scheduledAtUtc === undefined ? {} : { scheduledAtUtc }),
          ...(confirmNotPublished === true ? { confirmNotPublished: true } : {}),
        },
        schema: postSchema,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["posts"] }),
  });
}

/** El fallo pide confirmar que la plataforma no lo publicó (`NFR-015`). */
export function needsPublishConfirmation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const details = (error as { details?: Record<string, unknown> }).details;
  return details?.["needsConfirmation"] === true;
}

/** Los `errorCode` con los que un reintento exige confirmación (igual que la API). */
export const UNCERTAIN_FAILURE_CODES: ReadonlySet<string> = new Set([
  "delivery_unconfirmed",
  "platform_processing_timeout",
]);

export interface UpdatePostVariables {
  readonly postId: string;
  readonly brandId?: string;
  readonly caption?: string;
  readonly description?: string;
  readonly scheduledAtUtc?: number;
}

export function useUpdatePost() {
  const queryClient = useQueryClient();
  return useMutation<Post, ApiRequestError, UpdatePostVariables>({
    mutationFn: ({ postId, ...body }) =>
      apiRequest<Post>(postPath(postId), {
        method: "PATCH",
        body,
        schema: postSchema,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["posts"] }),
  });
}

export function useGetPost(postId: string | null) {
  return useApiQuery<Post>({
    queryKey: ["posts", postId ?? "none"],
    path: postPath(postId ?? "none"),
    schema: postSchema,
    enabled: postId !== null,
    staleTime: 0,
  });
}

export function useCancelPosts() {
  const queryClient = useQueryClient();
  return useMutation<readonly Post[], ApiRequestError, readonly string[]>({
    mutationFn: (postIds) =>
      apiRequest<readonly Post[]>("posts/cancel", {
        method: "POST",
        body: { postIds },
        schema: z.array(postSchema),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["posts"] }),
  });
}

export function useDeletePosts() {
  const queryClient = useQueryClient();
  return useMutation<void, ApiRequestError, readonly string[]>({
    mutationFn: (postIds) =>
      apiSend("posts/delete", { method: "POST", body: { postIds } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["posts"] }),
  });
}

/** Estados que todavía se pueden cancelar (la lista de la API). */
export const CANCELLABLE: ReadonlySet<string> = new Set([
  "BUILDING",
  "CREATED",
  "SCHEDULED",
  "AWAITING_RECONNECT",
]);

/** Estados que todavía se pueden editar/reprogramar con `PATCH /posts/:id`. */
export const EDITABLE: ReadonlySet<string> = CANCELLABLE;
