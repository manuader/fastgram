/**
 * El lado de la base de «buscar el meme si no hay» — sprint 7, migración
 * `0026` (`phase`, `meme_searches`, `auto_media_id` en
 * `blitz_prompt_requests`).
 *
 * Por qué hacen falta: la búsqueda cruza reintentos del job (una bajada puede
 * no terminar en un intento, y la normalización del clip tarda), así que el
 * pedido recuerda cuántas búsquedas lleva (tope 2, CHECK de la base) y qué
 * clip ya importó, para que un reintento lo retome en vez de bajar otro.
 *
 * Todo con `TenantScope` y sólo sobre pedidos **abiertos**: un pedido cerrado
 * no vuelve a buscar ni cambia de fase.
 */
import { and, eq, inArray, lt, sql } from "drizzle-orm";

import type { Executor } from "../client.js";
import { blitzPromptRequests } from "../schema/blitz.js";
import { media } from "../schema/media.js";
import type { TenantScope } from "./base.js";

const OPEN = ["queued", "running"] as const;

const own = (scope: TenantScope, requestId: string) =>
  and(
    eq(blitzPromptRequests.companyId, scope.companyId),
    eq(blitzPromptRequests.id, requestId),
    inArray(blitzPromptRequests.status, [...OPEN]),
  );

/**
 * Reserva una búsqueda: pasa a `searching_meme` y suma 1, **sólo** si el
 * pedido sigue abierto y no llegó a `maxSearches`. `false` = no se busca.
 * La reserva y el tope van en la misma sentencia: dos entregas a la vez no
 * pueden pasarse del tope.
 */
export async function reservePromptMemeSearch(
  exec: Executor,
  scope: TenantScope,
  requestId: string,
  maxSearches: number,
): Promise<boolean> {
  const rows = await exec
    .update(blitzPromptRequests)
    .set({
      phase: "searching_meme",
      memeSearches: sql`${blitzPromptRequests.memeSearches} + 1`,
      updatedAt: sql`now()`,
    })
    .where(and(own(scope, requestId), lt(blitzPromptRequests.memeSearches, maxSearches)))
    .returning({ id: blitzPromptRequests.id });
  return rows.length > 0;
}

/** Anota el clip importado (o lo borra con `null`). */
export async function setPromptAutoMedia(
  exec: Executor,
  scope: TenantScope,
  requestId: string,
  mediaId: string | null,
): Promise<void> {
  await exec
    .update(blitzPromptRequests)
    .set({ autoMediaId: mediaId, updatedAt: sql`now()` })
    .where(own(scope, requestId));
}

/** Vuelve a la fase de siempre (planificar y escribir la copy). */
export async function clearPromptPhase(
  exec: Executor,
  scope: TenantScope,
  requestId: string,
): Promise<void> {
  await exec
    .update(blitzPromptRequests)
    .set({ phase: null, updatedAt: sql`now()` })
    .where(own(scope, requestId));
}

/**
 * Suma una etiqueta a un asset (`media.tags`, `0029`), sin repetirla. Es la
 * marca `auto-found` del meme que encontró la búsqueda.
 */
export async function addMediaTag(
  exec: Executor,
  scope: TenantScope,
  mediaId: string,
  tag: string,
): Promise<void> {
  await exec
    .update(media)
    .set({ tags: sql`array_append(${media.tags}, ${tag}::text)` })
    .where(
      and(
        eq(media.companyId, scope.companyId),
        eq(media.mediaId, mediaId),
        sql`not (${tag}::text = any(${media.tags}))`,
      ),
    );
}
