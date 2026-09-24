/**
 * Inspiration como tablero de referencias propio — `FR-040` adaptado, `F-041`,
 * `OQ-13`, migración `0022`.
 *
 * Las referencias del dueño viven en `trending_items` con `origin = 'owner'` y
 * `company_id`. Todo acá filtra por las dos cosas **además** de la política
 * RLS: una fila del catálogo global (sin marca) no es una referencia del dueño
 * y no se edita ni se borra desde estas funciones, y una ajena es `null` (el
 * 404 lo pone la ruta, §9.2).
 *
 * ## La búsqueda
 *
 * `ILIKE` sobre título, autor, caption, link, hashtags, etiquetas y texto en
 * pantalla. Sin índice de texto: es el tablero de una persona (decenas o
 * cientos de filas por marca), no el catálogo de 25 000 del PRD. Los comodines
 * del término se escapan: buscar `50%` busca eso, no «50 y cualquier cosa».
 */
import { and, desc, eq, sql, type SQL } from "drizzle-orm";

import type { Executor } from "../client.js";
import {
  buildOffsetPage,
  normalizeLimit,
  normalizePage,
  offsetOf,
} from "../pagination.js";
import {
  trendingItems,
  type TrendingFormat,
  type TrendingIngestState,
} from "../schema/discovery.js";
import type { TenantScope } from "./base.js";

export type TrendingItemRow = typeof trendingItems.$inferSelect;
type SocialPlatform = NonNullable<TrendingItemRow["platform"]>;

export interface NewOwnerReference {
  readonly platform: SocialPlatform | null;
  readonly permalink: string | null;
  readonly niches: readonly string[];
  readonly ingestState: TrendingIngestState;
  readonly format?: TrendingFormat | null;
  readonly title?: string | null;
  readonly mediaId?: string | null;
  readonly importId?: string | null;
  readonly thumbnailUrl?: string | null;
}

/** Lo que el worker completa después de leer la página (`yt-dlp`, visión). */
export interface OwnerReferenceIngestPatch {
  readonly ingestState: TrendingIngestState;
  readonly ingestError?: string | null;
  readonly title?: string | null;
  readonly author?: string | null;
  readonly caption?: string | null;
  readonly hashtags?: readonly string[];
  readonly format?: TrendingFormat | null;
  readonly views?: number | null;
  readonly likes?: number | null;
  readonly comments?: number | null;
  readonly durationSeconds?: number | null;
  readonly isSlideshow?: boolean;
  readonly slideCount?: number;
  readonly thumbnailUrl?: string | null;
  readonly textOverlays?: readonly string[];
  /** Etiquetas sugeridas por el modelo de visión: se **suman** a las del dueño. */
  readonly addNiches?: readonly string[];
}

export interface OwnerReferenceQuery {
  readonly q?: string | undefined;
  readonly format?: TrendingFormat | undefined;
  readonly tag?: string | undefined;
  readonly page?: number | undefined;
  readonly limit?: number | undefined;
}

const ownedBy = (scope: TenantScope): SQL =>
  and(
    eq(trendingItems.companyId, scope.companyId),
    eq(trendingItems.origin, "owner"),
  ) as SQL;

/** Escapa `\`, `%` y `_` para un `ILIKE … ESCAPE '\'`. */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export async function createOwnerReference(
  exec: Executor,
  scope: TenantScope,
  input: NewOwnerReference,
): Promise<TrendingItemRow> {
  const [row] = await exec
    .insert(trendingItems)
    .values({
      companyId: scope.companyId,
      origin: "owner",
      platform: input.platform,
      permalink: input.permalink,
      niches: [...input.niches],
      ingestState: input.ingestState,
      format: input.format ?? null,
      title: input.title ?? null,
      mediaId: input.mediaId ?? null,
      importId: input.importId ?? null,
      thumbnailUrl: input.thumbnailUrl ?? null,
      // Hasta que el worker lea la página, no hay métricas: `null`, no `0`.
      views: null,
      likes: null,
    })
    .returning();
  if (row === undefined) throw new Error("El INSERT de la referencia no devolvió fila.");
  return row;
}

/** Una referencia del dueño **de este workspace**, o `null`. */
export async function findOwnerReference(
  exec: Executor,
  scope: TenantScope,
  id: string,
): Promise<TrendingItemRow | null> {
  const rows = await exec
    .select()
    .from(trendingItems)
    .where(and(ownedBy(scope), eq(trendingItems.id, id)))
    .limit(1);
  return rows[0] ?? null;
}

export async function listOwnerReferences(
  exec: Executor,
  scope: TenantScope,
  query: OwnerReferenceQuery,
): Promise<ReturnType<typeof buildOffsetPage<TrendingItemRow>>> {
  const pageSize = normalizeLimit(query.limit);
  const page = normalizePage(query.page);
  const conditions: SQL[] = [ownedBy(scope)];
  if (query.format !== undefined) conditions.push(eq(trendingItems.format, query.format));
  const tag = query.tag?.trim();
  if (tag !== undefined && tag !== "") {
    conditions.push(sql`${tag} = any(${trendingItems.niches})`);
  }
  const q = query.q?.trim();
  if (q !== undefined && q !== "") {
    const like = `%${escapeLike(q)}%`;
    conditions.push(sql`(
      ${trendingItems.title} ilike ${like} escape '\\'
      or ${trendingItems.author} ilike ${like} escape '\\'
      or ${trendingItems.caption} ilike ${like} escape '\\'
      or ${trendingItems.permalink} ilike ${like} escape '\\'
      or array_to_string(${trendingItems.hashtags}, ' ') ilike ${like} escape '\\'
      or array_to_string(${trendingItems.niches}, ' ') ilike ${like} escape '\\'
      or array_to_string(${trendingItems.textOverlays}, ' ') ilike ${like} escape '\\'
    )`);
  }
  const where = and(...conditions);
  // Mismo snapshot para el total y la página (ver `listByPage` en `base.ts`).
  const totals = await exec
    .select({ value: sql<number>`count(*)::int` })
    .from(trendingItems)
    .where(where);
  const rows = await exec
    .select()
    .from(trendingItems)
    .where(where)
    .orderBy(desc(trendingItems.createdAt), desc(trendingItems.id))
    .limit(pageSize)
    .offset(offsetOf(page, pageSize));
  return buildOffsetPage(rows, page, pageSize, totals[0]?.value ?? 0);
}

/** Las etiquetas en uso en el tablero de la marca, para los chips del filtro. */
export async function listOwnerReferenceTags(
  exec: Executor,
  scope: TenantScope,
): Promise<readonly string[]> {
  const rows = await exec.execute<{ tag: string }>(sql`
    select distinct unnest(${trendingItems.niches}) as tag
      from ${trendingItems}
     where ${trendingItems.companyId} = ${scope.companyId}::uuid
       and ${trendingItems.origin} = 'owner'
     order by 1
     limit 200
  `);
  return rows.map((r) => r.tag).filter((t) => t.trim() !== "");
}

/**
 * Lo que leyó el worker. Sólo sobre una referencia del dueño de esta marca;
 * devuelve `false` si no existe (la borraron mientras se leía).
 */
export async function applyOwnerReferenceIngest(
  exec: Executor,
  scope: TenantScope,
  id: string,
  patch: OwnerReferenceIngestPatch,
): Promise<boolean> {
  const set: Partial<typeof trendingItems.$inferInsert> = {
    ingestState: patch.ingestState,
    fetchedAt: new Date(),
    updatedAt: new Date(),
  };
  if (patch.ingestError !== undefined) set.ingestError = patch.ingestError;
  if (patch.title !== undefined) set.title = patch.title;
  if (patch.author !== undefined) set.author = patch.author;
  if (patch.caption !== undefined) set.caption = patch.caption;
  if (patch.hashtags !== undefined) set.hashtags = [...patch.hashtags];
  if (patch.format !== undefined) set.format = patch.format;
  if (patch.views !== undefined) set.views = patch.views;
  if (patch.likes !== undefined) set.likes = patch.likes;
  if (patch.comments !== undefined) set.comments = patch.comments;
  if (patch.durationSeconds !== undefined) set.durationSeconds = patch.durationSeconds;
  if (patch.isSlideshow !== undefined) set.isSlideshow = patch.isSlideshow;
  if (patch.slideCount !== undefined) set.slideCount = patch.slideCount;
  if (patch.thumbnailUrl !== undefined) set.thumbnailUrl = patch.thumbnailUrl;
  if (patch.textOverlays !== undefined) set.textOverlays = [...patch.textOverlays];
  const added = patch.addNiches ?? [];
  const rows = await exec
    .update(trendingItems)
    .set({
      ...set,
      ...(added.length === 0
        ? {}
        : {
            // Unión sin duplicados, conservando el orden de las del dueño.
            niches: sql`(
              select coalesce(array_agg(t order by min_ord), '{}'::text[])
                from (
                  select t, min(ord) as min_ord
                    from unnest(
                           ${trendingItems.niches} ||
                           array(select jsonb_array_elements_text(${JSON.stringify(added)}::jsonb))
                         ) with ordinality as u(t, ord)
                   group by t
                ) dedup
            )`,
          }),
    })
    .where(and(ownedBy(scope), eq(trendingItems.id, id)))
    .returning({ id: trendingItems.id });
  return rows.length > 0;
}

/** Reemplaza las etiquetas del dueño. `null` si no es suya. */
export async function setOwnerReferenceTags(
  exec: Executor,
  scope: TenantScope,
  id: string,
  niches: readonly string[],
): Promise<TrendingItemRow | null> {
  const rows = await exec
    .update(trendingItems)
    .set({ niches: [...niches], updatedAt: new Date() })
    .where(and(ownedBy(scope), eq(trendingItems.id, id)))
    .returning();
  return rows[0] ?? null;
}

/**
 * Borra la referencia. Las sugerencias y los pedidos que la citaban quedan con
 * `source_trending_item_id` en `NULL` (FK `set null`); su `remix_source_url`
 * se conserva, que es lo que muestra el deck.
 */
export async function deleteOwnerReference(
  exec: Executor,
  scope: TenantScope,
  id: string,
): Promise<boolean> {
  const rows = await exec
    .delete(trendingItems)
    .where(and(ownedBy(scope), eq(trendingItems.id, id)))
    .returning({ id: trendingItems.id });
  return rows.length > 0;
}
