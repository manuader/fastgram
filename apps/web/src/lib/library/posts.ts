"use client";

/**
 * Los datos de `Library → My Posts` · F-120 (PRD:592), FR-100 (PRD:1603-1611),
 * §12 (PRD:2729).
 *
 * ## Lo que `GET /posts` sirve de verdad, y lo que F-120 pide y no está
 *
 * F-120 pide *"grid de posts con plataforma, cuenta, estado, fecha, tipo y
 * métricas"*. Se leyó el contrato (`postSchema`) y el serializer
 * (`apps/api/src/support/serializers.ts`, `toPost`) antes de dibujar nada, y
 * de esa lista **falta una**:
 *
 * | F-120 pide | Campo | ¿Está? |
 * |---|---|---|
 * | plataforma | `platform` | sí |
 * | cuenta | `accountType` + `connectionUsername` | sí, con un matiz (abajo) |
 * | estado | `status` | sí |
 * | fecha | `scheduledAtUtc`, `postedAt` | sí |
 * | **tipo** | — | **no** |
 * | métricas | `views`, `likes`, `comments` | sí |
 *
 * **El tipo de contenido no viaja en el Post.** `postSchema` tiene `contentId`
 * y nada más sobre la pieza: ni `type`, ni `thumbnailUrl`. O sea que el badge
 * de tipo (`Video Hook`, `Green Screen`, …) y el thumbnail 9:16 que PRD:1607-1608
 * dibujan en esta tarjeta **no se pueden pintar con una sola petición**.
 * Conseguirlos serían N peticiones a `GET /content/:id` —una por post, sin
 * endpoint de lote— contra el límite de 60/min de §9.6: con la página de 20 que
 * devuelve el contrato, 21 peticiones para abrir una pestaña.
 *
 * Así que no se dibujan y la pantalla lo dice una vez, arriba. Inventar un tipo
 * (por ejemplo deducirlo de `instagramSlideshowFormat`) sería un dato que
 * parece un dato.
 *
 * **El matiz de la cuenta:** `connectionUsername` sólo lo rellena el camino
 * OAuth. En un post warmed el campo queda nulo a propósito —lo dice
 * `apps/api/src/routes/v1/posts.ts`— y el username vive en
 * `GET /warmed-accounts`. Cruzar las dos listas es otra petición y otra tarea;
 * acá, sin username, se dice de qué **tipo** de cuenta salió el post, que es lo
 * que sí se sabe.
 *
 * ## El filtro, que es uno solo
 *
 * `listPostsQuerySchema` es `.strict()` y extiende el cursor con **`status`** y
 * nada más: no hay filtro por plataforma ni por cuenta ni por fecha. Y la lista
 * de estados filtrables del contrato **no incluye `CANCELLED`**, que sí es un
 * estado válido de un post (FR-060, PRD:1387): el PRD lo omite del filtro de
 * §12 y el contrato lo copia tal cual. Consecuencia visible: un post cancelado
 * aparece en la lista sin filtrar y no hay forma de pedir *sólo* los
 * cancelados. Está reportado, no arreglado acá: arreglarlo es tocar el
 * contrato.
 */
import {
  PAGINATION_LIMIT_DEFAULT,
  postPlatformSchema,
  postStatusFilterSchema,
  postSchema,
  type Post,
  type PostPlatform,
  type PostStatus,
  type PostStatusFilter,
} from "@fastgram/contracts";
import type { UseInfiniteQueryResult } from "@tanstack/react-query";
import type { CopyKey } from "../i18n/t";
import type { CursorPage, QueryParams } from "../api/client";
import type { ApiRequestError } from "../api/errors";
import { useApiInfiniteQuery, type CursorPages } from "../api/hooks";
import { queryKeys } from "../api/keys";
import { BUILD_POLL_INTERVAL_MS } from "./content";

export const POSTS_PATH = "/posts";

/** Los nueve estados **filtrables** de §12 (PRD:2729). Ver la cabecera. */
export const POST_STATUS_FILTERS: readonly PostStatusFilter[] =
  postStatusFilterSchema.options;

export const POST_PLATFORMS: readonly PostPlatform[] = postPlatformSchema.options;

/**
 * Plataforma → copy. `Record` completo y no un `switch`: si el contrato agrega
 * una quinta plataforma, esto deja de compilar y alguien decide cómo se escribe
 * en pantalla, en vez de que salga el identificador crudo.
 */
export const POST_PLATFORM_COPY: Readonly<Record<PostPlatform, CopyKey>> = {
  tiktok: "posts.platform.tiktok",
  instagram: "posts.platform.instagram",
  youtube: "posts.platform.youtube",
  reddit: "posts.platform.reddit",
  x: "posts.platform.x",
  threads: "posts.platform.threads",
  facebook: "posts.platform.facebook",
};

/**
 * Estado → copy. Los **diez** de FR-060 (PRD:1387), incluido `CANCELLED`, que
 * no se puede filtrar pero sí llega en la lista.
 */
export const POST_STATUS_COPY: Readonly<Record<PostStatus, CopyKey>> = {
  BUILDING: "posts.status.building",
  CREATED: "posts.status.created",
  SCHEDULED: "posts.status.scheduled",
  UPLOADING_TO_TIKTOK: "posts.status.uploading",
  IN_USER_INBOX: "posts.status.inUserInbox",
  POSTED: "posts.status.posted",
  FAILED: "posts.status.failed",
  DELETED: "posts.status.deleted",
  AWAITING_RECONNECT: "posts.status.awaitingReconnect",
  CANCELLED: "posts.status.cancelled",
};

/**
 * El tono del badge de estado.
 *
 * PRD:1607 pide un **icono** a la derecha (✓ verde, calendario azul, ✕ ámbar).
 * Acá es un badge con texto y tono, no un icono suelto, por una razón que el
 * PRD no tiene por qué resolver: un icono que es la única señal de estado no
 * tiene nombre para un lector de pantalla, y los diez estados de FR-060 no
 * caben en tres iconos —`IN_USER_INBOX`, `AWAITING_RECONNECT` y
 * `UPLOADING_TO_TIKTOK` no son ninguno de los tres—. El color se conserva; lo
 * que se agrega es el texto.
 *
 * El que importa: **`IN_USER_INBOX` no es `danger`**. PRD:1414 lo dice con
 * todas las letras — *"se muestra como pendiente de acción del usuario, no como
 * error"*. Pintarlo de rojo haría que alguien intentara republicar un post que
 * TikTok ya aceptó, y eso sí es un duplicado.
 */
export type PostStatusTone = "neutral" | "info" | "success" | "warning" | "danger";

export const POST_STATUS_TONE: Readonly<Record<PostStatus, PostStatusTone>> = {
  BUILDING: "neutral",
  CREATED: "neutral",
  SCHEDULED: "info",
  UPLOADING_TO_TIKTOK: "info",
  // PRD:1414 — pendiente de que el usuario abra la app de TikTok, no un error.
  IN_USER_INBOX: "warning",
  POSTED: "success",
  FAILED: "danger",
  DELETED: "neutral",
  // El post no se publicó y no se va a publicar solo: hace falta reconectar.
  AWAITING_RECONNECT: "warning",
  CANCELLED: "neutral",
};

export interface PostFilters {
  /** `undefined` = sin filtrar. §12 (PRD:2729): lista separada por comas. */
  readonly status?: PostStatusFilter | undefined;
}

/** Los filtros, en la forma que viaja en la query string. */
export function postsQueryParams(filters: PostFilters): QueryParams {
  return filters.status === undefined ? {} : { status: filters.status };
}

/** Las páginas del cursor, en la lista que dibuja la grid. */
export function flattenPostPages(data: CursorPages<Post> | undefined): readonly Post[] {
  if (data === undefined) return [];
  return data.pages.flatMap((page: CursorPage<Post>) => page.items);
}

/**
 * ¿Hay algún post construyéndose? Es lo único que decide si se sigue
 * preguntando.
 *
 * **Sólo `BUILDING`**, y la lista corta es la decisión:
 *
 * · `SCHEDULED` puede estar a días de su hora. Un intervalo de 10 s contra eso
 *   son 8 640 peticiones al día para ver el mismo valor.
 * · `UPLOADING_TO_TIKTOK` dura **hasta 72 h** cuando TikTok lo mete en su
 *   carril lento (NFR-015, PRD:1392). Es exactamente la trampa que
 *   `lib/media/media.ts` documenta para `processing`: un estado que parece
 *   transitorio y no lo es.
 * · `IN_USER_INBOX` espera a que una persona abra la app de TikTok (PRD:1390).
 *   No hay reloj que lo resuelva.
 *
 * `BUILDING`, en cambio, lo resuelve el worker en minutos y es el mismo caso
 * que ya cubre ADR-014 para el contenido: mientras el media se construye el
 * post no puede publicarse (PRD:1378), y cuando termina el post se mueve solo.
 */
export function hasBuildingPost(items: readonly { status: PostStatus }[]): boolean {
  return items.some((item) => item.status === "BUILDING");
}

/** La cadencia que corresponde a lo que hay en pantalla. `false` = no preguntar. */
export function postsPollIntervalFor(
  items: readonly { status: PostStatus }[],
): number | false {
  return hasBuildingPost(items) ? BUILD_POLL_INTERVAL_MS : false;
}

export interface UsePostsListOptions extends PostFilters {
  readonly limit?: number;
}

/**
 * `GET /posts` paginado por cursor, con polling mientras haya un build.
 *
 * `staleTime: 0` por el mismo motivo que `useContentList`: mezclar una ventana
 * de frescura con una cadencia de polling deja una duda que sólo se resuelve
 * leyendo el código de la librería.
 */
export function usePostsList(
  options: UsePostsListOptions = {},
): UseInfiniteQueryResult<CursorPages<Post>, ApiRequestError> {
  const { limit = PAGINATION_LIMIT_DEFAULT, ...filters } = options;
  const query = postsQueryParams(filters);
  return useApiInfiniteQuery<Post>({
    queryKey: queryKeys.posts(query),
    path: POSTS_PATH,
    query,
    itemSchema: postSchema,
    limit,
    staleTime: 0,
    refetchInterval: (q) => postsPollIntervalFor(flattenPostPages(q.state.data)),
  });
}

// ---------------------------------------------------------------------------
// Formato
// ---------------------------------------------------------------------------

/**
 * Las fechas, en UTC — y el pie de un post programado **lo dice**.
 *
 * Fijar la zona es la decisión que ya tomaron `error-presentation.ts` (con el
 * `resetAt` de las cuotas) y `lib/media/media.ts` (con la fecha de subida), por
 * el mismo motivo: sin fijarla, `Intl` formatea en la zona de la máquina y dos
 * personas del mismo workspace ven horas distintas para el mismo post.
 *
 * Lo que es propio de esta pantalla es el sufijo `UTC` del pie de un post
 * programado. PRD:1608 escribe `Scheduled: hh:mm am/pm, DD/MM/YY`, sin zona, y
 * acá se le agrega: una **hora** sin zona en la pantalla que dice cuándo va a
 * salir un post es la ambigüedad que produce el ticket *"lo programé para las
 * 9 y dice las 14"*. La fecha de un post ya publicado no lleva sufijo porque no
 * lleva hora. Es una decisión de esta tarea, no una lectura del PRD.
 */
const postedDateFormat = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "2-digit",
  year: "2-digit",
  timeZone: "UTC",
});

const scheduledTimeFormat = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
  timeZone: "UTC",
});

/** `22/09/26` — el `DD/MM/YY` de PRD:1608. */
export function formatPostDate(msEpoch: number): string {
  return postedDateFormat.format(new Date(msEpoch));
}

/** `9:05 am` — el `hh:mm am/pm` de PRD:1608, en minúsculas como lo escribe. */
export function formatPostTime(msEpoch: number): string {
  // `Intl` emite `AM`/`PM` y, según el runtime, separa la hora del sufijo con un
  // espacio fino (U+202F) en vez de uno normal — Node cambió de uno a otro entre
  // versiones. Cualquier espacio se normaliza a uno normal para que el texto sea
  // el mismo en cualquier máquina, incluida la de CI, que es donde se descubre.
  return scheduledTimeFormat.format(new Date(msEpoch)).replace(/\s+/g, " ").toLowerCase();
}

/**
 * `1,234` — las métricas de PRD:1610.
 *
 * Locale fijo por la misma razón que la zona: `Intl` sin locale usa el de la
 * máquina, y `1.234` (es-ES) al lado de `1,234` (en-US) son dos números
 * distintos para el mismo dato.
 */
const metricFormat = new Intl.NumberFormat("en-US");

export function formatMetric(value: number): string {
  return metricFormat.format(value);
}

/**
 * ¿Este post está esperando algo que el usuario tiene que saber?
 *
 * Son las tres notas que FR-060 documenta con consecuencia, no adornos:
 *
 * · `IN_USER_INBOX` (PRD:1390) — TikTok lo aceptó pero **no está publicado**
 *   hasta que alguien abra la app. Sin esta nota, un post en el inbox parece
 *   publicado y nadie va a buscarlo.
 * · `tiktokProcessingDelayed` (PRD:1392) — carril lento, hasta 72 h, y **no se
 *   debe reprogramar** mientras el flag esté puesto porque crearía un
 *   duplicado. Es la nota más cara de las tres.
 * · `cancellationPending` (PRD:1395) — cancelación en curso; no se reintenta.
 *
 * Devuelve la clave de copy, o `null`. El orden es el de urgencia: el aviso de
 * "no reprogrames" gana al de "está en tu inbox", porque el daño de ignorarlo
 * es un post duplicado.
 */
export function postNoticeKey(post: Post): CopyKey | null {
  if (post.tiktokProcessingDelayed === true) return "posts.notice.tiktokDelayed";
  if (post.cancellationPending === true) return "posts.notice.cancelling";
  if (post.status === "IN_USER_INBOX") return "posts.notice.inUserInbox";
  return null;
}
