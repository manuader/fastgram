/**
 * El lado de la base de aceptar una sugerencia de Blitz — `FR-050`, `P2-BLITZ-014`.
 *
 * ## Por qué no alcanza con `suggestionRepository`
 *
 * Porque aceptar **saca** una sugerencia de la cola, y dos aceptaciones
 * simultáneas del mismo workspace no pueden sacar la misma. Con la fábrica
 * genérica la secuencia es `list(status = queued, limit 1)` y después un
 * `update(status = popped)`, y con READ COMMITTED las dos transacciones leen la
 * misma fila `queued`: las dos crean su `Content` a partir de ella y las dos
 * cobran un save. No es un save regalado —se cobran los dos— pero es una pieza
 * duplicada que el usuario pagó dos veces y un swipe que no correspondía.
 *
 * {@link claimNextQueuedSuggestion} lee con `FOR UPDATE SKIP LOCKED`:
 *
 *  - **`FOR UPDATE` es el mecanismo.** Deja la fila tomada hasta el commit, así
 *    que dos aceptaciones no pueden sacar la misma. Sin él, las dos leen la misma
 *    `queued`, y la segunda llega a {@link markSuggestionPopped} sobre una fila
 *    ya `popped`: el `WHERE status = 'queued'` del `UPDATE` la frena (trampa 37),
 *    pero como un `500` y después de haber hecho todo el trabajo. Medido en
 *    `apps/api/test/blitz-accept.int.test.ts` quitando el lock: `[202, 500]` en
 *    vez de `[202, 404]`.
 *  - **`SKIP LOCKED` es latencia, no corrección.** Sin él, la segunda espera a que
 *    la primera confirme, Postgres revalida la fila (ya `popped`), la descarta y
 *    **sigue con la próxima** del orden — el mismo resultado, más tarde. Se midió:
 *    quitarlo no pone rojo ningún test. Con él, la segunda no hace cola detrás de
 *    una transacción entera de la primera por una fila que ya no le toca.
 *
 * Con una sola sugerencia en cola y dos aceptaciones, la segunda recibe la cola
 * vacía, que **sí** es cierto desde su punto de vista: la única que había ya
 * tiene dueño.
 *
 * ## El orden de la cola
 *
 * `createdAt` descendente, más nueva primero. Es el orden que la ruta ya usaba
 * con `suggestionRepository.list` (el único que el repositorio sabe dar), y el
 * PRD no define otro. Cambiarlo acá sería una decisión de producto escondida en
 * un cambio de mecanismo.
 */

import { and, desc, eq, sql, type SQL } from "drizzle-orm";

import type { Executor } from "../client.js";
import {
  contentAngles,
  influencers,
  suggestions,
  trendingItems,
} from "../schema/index.js";
import type { TenantScope } from "./base.js";

export type SuggestionRow = typeof suggestions.$inferSelect;
export type SuggestionContentType = SuggestionRow["contentType"];

/**
 * **El** orden de la cola: más nueva primero y, a igual `createdAt`, por id.
 *
 * Es uno solo y lo comparten {@link claimNextQueuedSuggestion} (que consume) y
 * {@link listQueuedSuggestions} (que muestra): el deck promete que la tarjeta
 * de arriba es la que saldría, y dos `ORDER BY` escritos por separado son dos
 * órdenes el día que alguien toque uno. El desempate por id importa: un refill
 * inserta varias filas en una sentencia y comparten el `now()` de la transacción.
 */
const QUEUE_ORDER = [desc(suggestions.createdAt), desc(suggestions.id)] as const;

/**
 * La próxima sugerencia `queued` del workspace, **bloqueada** hasta el fin de la
 * transacción. `null` si no queda ninguna libre.
 *
 * Quien llame tiene que estar dentro de una transacción: fuera de una, el lock
 * se suelta al terminar la sentencia y no protege nada. El `Executor` no lo
 * distingue, así que queda escrito.
 */
export async function claimNextQueuedSuggestion(
  exec: Executor,
  scope: TenantScope,
  filter: { readonly contentType?: SuggestionContentType | undefined } = {},
): Promise<SuggestionRow | null> {
  const conditions: SQL[] = [
    eq(suggestions.companyId, scope.companyId),
    eq(suggestions.status, "queued"),
  ];
  if (filter.contentType !== undefined) {
    conditions.push(eq(suggestions.contentType, filter.contentType));
  }

  const filas = await exec
    .select()
    .from(suggestions)
    .where(and(...conditions))
    .orderBy(...QUEUE_ORDER)
    .for("update", { skipLocked: true })
    .limit(1);

  return filas[0] ?? null;
}

/**
 * Una sugerencia **por id**, bloqueada hasta el fin de la transacción, en el
 * estado que tenga. `null` si no existe en este workspace.
 *
 * Es el lock de las dos decisiones sobre una tarjeta concreta —aceptarla por id
 * (`POST /blitz` con `suggestionId`) y descartarla (`POST /blitz/queue/:id/discard`)—
 * y a propósito **sin** `SKIP LOCKED`: si las dos llegan a la vez, la segunda
 * espera a que la primera confirme, Postgres le devuelve la fila **ya cambiada**
 * (READ COMMITTED revalida la fila bloqueada) y quien llama ve que no está
 * `queued` → `409`. Con `SKIP LOCKED` la segunda vería "no existe" y respondería
 * un `404` que es mentira.
 *
 * No filtra por `status`: el llamador tiene que distinguir "no existe" (404) de
 * "ya no está en cola" (409).
 */
export async function lockSuggestionById(
  exec: Executor,
  scope: TenantScope,
  suggestionId: string,
): Promise<SuggestionRow | null> {
  const filas = await exec
    .select()
    .from(suggestions)
    .where(
      and(eq(suggestions.companyId, scope.companyId), eq(suggestions.id, suggestionId)),
    )
    .for("update")
    .limit(1);
  return filas[0] ?? null;
}

/** Una sugerencia `queued` con lo que la tarjeta del deck muestra de sus relaciones. */
export interface QueuedSuggestionView {
  readonly suggestion: SuggestionRow;
  readonly influencer: { readonly id: string; readonly name: string } | null;
  readonly angle: { readonly id: string; readonly title: string } | null;
  /** El item de tendencia de origen, si el remix salió de uno. */
  readonly trending: {
    readonly permalink: string;
    readonly thumbnailUrl: string | null;
    readonly likes: number;
    readonly views: number;
  } | null;
}

/**
 * Las sugerencias `queued` del workspace, **en el orden en que se consumen**
 * (ver {@link QUEUE_ORDER}). Sin lock: es una lectura para mostrar.
 *
 * Las relaciones van con `LEFT JOIN` y con el `companyId` en la condición del
 * join del influencer y del ángulo: la FK no impide que apunten a otro
 * workspace, y un nombre ajeno en una tarjeta sería una fuga. `trending_items`
 * es global (DATA-023), no tiene tenant.
 */
export async function listQueuedSuggestions(
  exec: Executor,
  scope: TenantScope,
  opts: { readonly limit: number },
): Promise<readonly QueuedSuggestionView[]> {
  const filas = await exec
    .select({
      suggestion: suggestions,
      influencerId: influencers.id,
      influencerName: influencers.name,
      angleId: contentAngles.id,
      angleTitle: contentAngles.title,
      trendingPermalink: trendingItems.permalink,
      trendingThumbnailUrl: trendingItems.thumbnailUrl,
      trendingLikes: trendingItems.likes,
      trendingViews: trendingItems.views,
    })
    .from(suggestions)
    .leftJoin(
      influencers,
      and(
        eq(influencers.id, suggestions.influencerId),
        eq(influencers.companyId, suggestions.companyId),
      ),
    )
    .leftJoin(
      contentAngles,
      and(
        eq(contentAngles.id, suggestions.angleId),
        eq(contentAngles.companyId, suggestions.companyId),
      ),
    )
    .leftJoin(trendingItems, eq(trendingItems.id, suggestions.sourceTrendingItemId))
    .where(
      and(eq(suggestions.companyId, scope.companyId), eq(suggestions.status, "queued")),
    )
    .orderBy(...QUEUE_ORDER)
    .limit(opts.limit);

  return filas.map((f) => ({
    suggestion: f.suggestion,
    influencer:
      f.influencerId === null || f.influencerName === null
        ? null
        : { id: f.influencerId, name: f.influencerName },
    angle:
      f.angleId === null || f.angleTitle === null
        ? null
        : { id: f.angleId, title: f.angleTitle },
    trending:
      f.trendingPermalink === null
        ? null
        : {
            permalink: f.trendingPermalink,
            thumbnailUrl: f.trendingThumbnailUrl,
            likes: f.trendingLikes ?? 0,
            views: f.trendingViews ?? 0,
          },
  }));
}

/**
 * `queued → popped`. Devuelve `false` si la fila no estaba `queued` en este
 * workspace — que después de {@link claimNextQueuedSuggestion} en la misma
 * transacción no puede pasar, y por eso quien llama lo trata como bug.
 *
 * El `WHERE status = 'queued'` no es redundante con el lock: es lo que hace que
 * un llamador que se saltee el `claim` no pueda pasar a `popped` una sugerencia
 * ya descartada.
 */
export async function markSuggestionPopped(
  exec: Executor,
  scope: TenantScope,
  suggestionId: string,
): Promise<boolean> {
  const filas = await exec
    .update(suggestions)
    .set({ status: "popped" })
    .where(
      and(
        eq(suggestions.companyId, scope.companyId),
        eq(suggestions.id, suggestionId),
        eq(suggestions.status, "queued"),
      ),
    )
    .returning({ id: suggestions.id });
  return filas.length > 0;
}

/**
 * Descarta una sugerencia que no se puede construir (`DATA-007`: `discarded`).
 *
 * La usa `POST /blitz` **en su propia transacción**, después de que la de la
 * aceptación volvió atrás: si se descartara dentro de ésa, el rollback la
 * devolvería a `queued` y la próxima petición la tomaría otra vez — el deck
 * quedaría trabado en una sugerencia que nunca se construye. Sólo pasa de
 * `queued` a `discarded`; si otra petición ya la tomó, no la toca.
 */
export async function discardQueuedSuggestion(
  exec: Executor,
  scope: TenantScope,
  suggestionId: string,
): Promise<boolean> {
  const filas = await exec
    .update(suggestions)
    .set({ status: "discarded" })
    .where(
      and(
        eq(suggestions.companyId, scope.companyId),
        eq(suggestions.id, suggestionId),
        eq(suggestions.status, "queued"),
      ),
    )
    .returning({ id: suggestions.id });
  return filas.length > 0;
}

/** Una media que una sugerencia usa, tal como está **ahora**. */
export interface LiveMediaRow {
  readonly mediaId: string;
  readonly url: string;
  readonly mediaType: "image" | "video";
}

/**
 * La media de una sugerencia que **sigue viva** (`ready`, no borrada), con
 * `FOR SHARE`.
 *
 * Es lo que hace honesto el cobro de `POST /blitz`: entre planificar y aceptar
 * el usuario pudo borrar el asset o recategorizarlo, y un build sobre una URL
 * que ya no existe falla **después** de cobrar. El `FOR SHARE` sostiene las
 * filas hasta el commit: un `DELETE /media/:id` concurrente (que es un
 * `UPDATE … deleted_at`) espera a que la pieza exista, y entonces el propio
 * `media_in_use` de `FR-100` lo rechaza.
 *
 * Devuelve sólo las que siguen vivas; quien llama compara contra lo que
 * esperaba. No compara categorías a propósito: `FR-100` dice que recategorizar
 * saca al asset de los pools **futuros**, y la sugerencia ya fue planificada.
 */
export async function lockLiveMedia(
  exec: Executor,
  scope: TenantScope,
  mediaIds: readonly string[],
): Promise<readonly LiveMediaRow[]> {
  if (mediaIds.length === 0) return [];
  const filas = (await exec.execute(sql`
    select media_id::text as media_id, r2_url as url, media_type::text as media_type
      from media
     where company_id = ${scope.companyId}::uuid
       and media_id::text in (${sql.join(
         mediaIds.map((id) => sql`${id}`),
         sql`, `,
       )})
       and deleted_at is null
       and status = 'ready'
     for share
  `)) as unknown as { media_id: string; url: string; media_type: "image" | "video" }[];
  return filas.map((f) => ({ mediaId: f.media_id, url: f.url, mediaType: f.media_type }));
}

/**
 * Como {@link lockLiveMedia} pero **sin lock**: para mostrar (la preview de
 * `GET /blitz/queue`), no para construir. Un `FOR SHARE` en una lectura que el
 * deck repite cada 15 s haría esperar a los borrados de media sin motivo.
 */
export async function findLiveMedia(
  exec: Executor,
  scope: TenantScope,
  mediaIds: readonly string[],
): Promise<readonly LiveMediaRow[]> {
  if (mediaIds.length === 0) return [];
  const filas = (await exec.execute(sql`
    select media_id::text as media_id, r2_url as url, media_type::text as media_type
      from media
     where company_id = ${scope.companyId}::uuid
       and media_id::text in (${sql.join(
         mediaIds.map((id) => sql`${id}`),
         sql`, `,
       )})
       and deleted_at is null
       and status = 'ready'
  `)) as unknown as { media_id: string; url: string; media_type: "image" | "video" }[];
  return filas.map((f) => ({ mediaId: f.media_id, url: f.url, mediaType: f.media_type }));
}

export const blitzAcceptanceStore = {
  table: suggestions,
  claimNextQueuedSuggestion,
  lockSuggestionById,
  listQueuedSuggestions,
  markSuggestionPopped,
  discardQueuedSuggestion,
  lockLiveMedia,
  findLiveMedia,
};
