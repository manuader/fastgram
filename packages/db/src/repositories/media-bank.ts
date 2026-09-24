/**
 * Media Bank — búsqueda, filtros e importación de posts propios (migración
 * `0029`, sprint 7 agente F: `P2-MEDIA-007`, `P1-ONB-008`).
 *
 * El filtro declarativo de `filters.ts` sólo sabe `eq`/`in`/`isNull`: buscar
 * por texto (`ILIKE`) y por pertenencia a un array (`@>`) no entra ahí sin
 * abrir un operador genérico que después alguien usaría con input del usuario
 * sobre cualquier columna. Estas dos consultas son concretas y viven acá.
 */
import { and, eq, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm";

import type { Executor } from "../client.js";
import {
  buildPage,
  cursorCondition,
  cursorOrderBy,
  fetchLimit,
  normalizeLimit,
  type Page,
} from "../pagination.js";
import { media, ownPostImports } from "../schema/index.js";
import { createCompanyScopedRepository, type TenantScope } from "./base.js";

type MediaRowOf = typeof media.$inferSelect;

export interface MediaSearch {
  readonly limit?: number | undefined;
  readonly cursor?: string | undefined;
  readonly mediaType?: MediaRowOf["mediaType"] | undefined;
  /** Los orígenes que se listan (FR-100: generados, demo e internos nunca). */
  readonly origins: readonly MediaRowOf["origin"][];
  /** Nombre de archivo o etiqueta, sin distinguir mayúsculas. */
  readonly q?: string | undefined;
  readonly category?: string | undefined;
  /** Etiqueta exacta, en minúsculas. */
  readonly tag?: string | undefined;
}

/** `ILIKE` con los comodines del usuario escapados: `50%` busca «50%», no todo. */
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * `GET /media` con búsqueda. Mismo orden y mismo cursor que `mediaRepository.list`
 * (`createdAt desc, id desc`): un cursor de una página sin filtros sigue siendo
 * válido con filtros, sólo que salta lo que no coincide.
 */
export async function searchMedia(
  exec: Executor,
  scope: TenantScope,
  search: MediaSearch,
): Promise<Page<MediaRowOf>> {
  const limit = normalizeLimit(search.limit);
  const conditions: (SQL | undefined)[] = [
    eq(media.companyId, scope.companyId),
    isNull(media.deletedAt),
    search.origins.length === 0 ? sql`false` : inArray(media.origin, [...search.origins]),
    search.mediaType === undefined ? undefined : eq(media.mediaType, search.mediaType),
    search.category === undefined
      ? undefined
      : sql`${media.categories} @> ARRAY[${search.category}]::text[]`,
    search.tag === undefined
      ? undefined
      : sql`${media.tags} @> ARRAY[${search.tag.toLowerCase()}]::text[]`,
    search.q === undefined
      ? undefined
      : or(
          ilike(media.filename, likePattern(search.q)),
          // Una etiqueta que **contiene** el término: «cat» encuentra «cats».
          sql`exists (select 1 from unnest(${media.tags}) as t(tag) where t.tag ilike ${likePattern(search.q.toLowerCase())})`,
        ),
    cursorCondition(media.createdAt, media.mediaId, search.cursor),
  ];
  const rows = await exec
    .select()
    .from(media)
    .where(and(...conditions))
    .orderBy(...cursorOrderBy(media.createdAt, media.mediaId))
    .limit(fetchLimit(limit));
  return buildPage(rows, limit, (row) => ({ createdAt: row.createdAt, id: row.mediaId }));
}

/**
 * Las etiquetas en uso en la marca, con cuántos assets vivos (listables) las
 * llevan. Alimenta los chips de filtro del Media Bank.
 */
export async function listMediaTags(
  exec: Executor,
  scope: TenantScope,
  origins: readonly MediaRowOf["origin"][],
  max = 50,
): Promise<{ tag: string; count: number }[]> {
  if (origins.length === 0) return [];
  const rows = await exec
    .select({
      tag: sql<string>`t.tag`,
      count: sql<number>`count(*)::int`,
    })
    .from(sql`${media}, unnest(${media.tags}) as t(tag)`)
    .where(
      and(
        eq(media.companyId, scope.companyId),
        isNull(media.deletedAt),
        inArray(media.origin, [...origins]),
      ),
    )
    .groupBy(sql`t.tag`)
    .orderBy(sql`count(*) desc`, sql`t.tag asc`)
    .limit(max);
  return rows;
}

/** Un asset por su origen externo (dedupe del import de posts propios). */
export async function findMediaBySourceRef(
  exec: Executor,
  scope: TenantScope,
  sourceRef: string,
): Promise<MediaRowOf | null> {
  const rows = await exec
    .select()
    .from(media)
    .where(and(eq(media.companyId, scope.companyId), eq(media.sourceRef, sourceRef)))
    .limit(1);
  return rows[0] ?? null;
}

export type ImportedMediaValues = Omit<
  typeof media.$inferInsert,
  "companyId" | "sourceRef" | "origin"
> & { readonly sourceRef: string };

/**
 * Inserta un asset importado **salvo que ese origen ya exista** en la marca
 * (incluso borrado: el usuario lo borró a propósito y reimportarlo lo
 * resucitaría). `null` = ya estaba. La guarda la sostiene el índice único
 * parcial `media_company_source_ref_uq`, no esta función: dos imports en
 * paralelo del mismo post no pueden duplicarlo.
 */
export async function insertImportedMedia(
  exec: Executor,
  scope: TenantScope,
  values: ImportedMediaValues,
): Promise<MediaRowOf | null> {
  const rows = await exec
    .insert(media)
    .values({ ...values, companyId: scope.companyId, origin: "imported" })
    .onConflictDoNothing({
      target: [media.companyId, media.sourceRef],
      where: sql`${media.sourceRef} is not null`,
    })
    .returning();
  return rows[0] ?? null;
}

/** `own_post_imports` (`0029`). Sin soft-delete: es un registro de trabajo. */
export const ownPostImportRepository = createCompanyScopedRepository({
  table: ownPostImports,
  id: ownPostImports.id,
  companyId: ownPostImports.companyId,
  createdAt: ownPostImports.createdAt,
});

export type OwnPostImportRow = typeof ownPostImports.$inferSelect;
