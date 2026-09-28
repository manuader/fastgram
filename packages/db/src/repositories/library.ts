/**
 * Biblioteca global de assets — sprint 9 (agente N), migración `0036`, D-19.
 *
 * ## Sin scope, igual que `catalog.ts`
 *
 * `library_assets` no tiene `companyId` (está en `NON_TENANT_TABLES`): es el
 * catálogo de la instalación. Las firmas no llevan `TenantScope` y **eso es
 * la señal**, no un olvido. Anda dentro de cualquier transacción (con o sin
 * `SET LOCAL ROLE`): la tabla no tiene RLS y `fastgram_app` tiene los GRANT.
 *
 * `importedByCompanyId` se escribe (auditoría) y nunca se filtra por él.
 *
 * ## Qué valida quién
 *
 * El JSON de `metadata` y `license` lo valida quien escribe con los schemas de
 * `@fastgram/contracts` (`packages/db` no depende de contracts). Acá sólo se
 * guarda y se consulta.
 */
import { and, desc, eq, gte, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";

import type { Executor } from "../client.js";
import { buildPage, cursorCondition, fetchLimit, type Page } from "../pagination.js";
import { libraryAssets, type LibraryAssetRowStatus } from "../schema/index.js";

export type LibraryAssetRow = typeof libraryAssets.$inferSelect;
export type NewLibraryAsset = Omit<
  typeof libraryAssets.$inferInsert,
  "createdAt" | "updatedAt" | "deletedAt"
>;
export type LibraryAssetPatch = Partial<
  Omit<typeof libraryAssets.$inferInsert, "id" | "createdAt" | "deletedAt">
>;

export interface LibraryAssetFilter {
  readonly q?: string;
  readonly kinds?: readonly string[];
  readonly memeTypes?: readonly string[];
  readonly emotions?: readonly string[];
  readonly aspects?: readonly string[];
  readonly licenseTypes?: readonly string[];
  readonly minDurationSec?: number;
  readonly maxDurationSec?: number;
  /** Default: `processing` y `ready`. */
  readonly statuses?: readonly LibraryAssetRowStatus[];
  readonly cursor?: string | null;
  /** 1–100. Default 40. */
  readonly limit?: number;
}

/** Lo que pide el decisor de assets (`PU-S9-008`, agente O). */
export interface LibraryCandidateQuery {
  readonly kinds: readonly string[];
  readonly maxDurationSec?: number;
  /** `9:16`, `16:9`, `1:1`… Sin él, cualquier aspecto. */
  readonly aspect?: string;
  /** Búsqueda libre sobre `search_text` (tema, emoción, situación). */
  readonly text?: string;
  /** Default 30, máximo 100 (Laya recorta alrededor de 20: D-18). */
  readonly limit?: number;
}

const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 100;

const clampLimit = (limit: number | undefined, fallback: number): number => {
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)));
};

const textArray = (values: readonly string[]): SQL =>
  sql`ARRAY[${sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )}]::text[]`;

/** `websearch_to_tsquery` no falla con comillas sueltas ni operadores a medias. */
function textCondition(q: string): SQL {
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  return or(
    sql`to_tsvector('simple', ${libraryAssets.searchText}) @@ websearch_to_tsquery('simple', ${q})`,
    sql`${libraryAssets.title} ilike ${like}`,
  ) as SQL;
}

function filterConditions(filter: LibraryAssetFilter): (SQL | undefined)[] {
  const statuses = filter.statuses ?? ["processing", "ready"];
  const q = filter.q?.trim() ?? "";
  return [
    isNull(libraryAssets.deletedAt),
    statuses.length === 0 ? undefined : inArray(libraryAssets.status, [...statuses]),
    q === "" ? undefined : textCondition(q),
    filter.kinds === undefined || filter.kinds.length === 0
      ? undefined
      : inArray(libraryAssets.kind, [...filter.kinds]),
    filter.licenseTypes === undefined || filter.licenseTypes.length === 0
      ? undefined
      : inArray(libraryAssets.licenseType, [...filter.licenseTypes]),
    filter.memeTypes === undefined || filter.memeTypes.length === 0
      ? undefined
      : sql`${libraryAssets.metadata}->>'memeType' = any(${textArray(filter.memeTypes)})`,
    filter.emotions === undefined || filter.emotions.length === 0
      ? undefined
      : sql`jsonb_exists_any(${libraryAssets.metadata}->'emotions', ${textArray(filter.emotions)})`,
    filter.aspects === undefined || filter.aspects.length === 0
      ? undefined
      : sql`${libraryAssets.metadata}->'aspect'->>'ratio' = any(${textArray(filter.aspects)})`,
    filter.minDurationSec === undefined
      ? undefined
      : gte(libraryAssets.durationSec, filter.minDurationSec),
    filter.maxDurationSec === undefined
      ? undefined
      : lte(libraryAssets.durationSec, filter.maxDurationSec),
  ];
}

export const libraryAssetRepository = {
  table: libraryAssets,

  /**
   * Crea la fila (`processing`). Si ya hay una viva con la misma
   * `licenseSourceUrl` (dedupe), no crea nada y devuelve `null`: quien llama
   * busca la existente con {@link findBySourceUrls}.
   */
  async create(exec: Executor, values: NewLibraryAsset): Promise<LibraryAssetRow | null> {
    const rows = await exec
      .insert(libraryAssets)
      .values(values)
      .onConflictDoNothing()
      .returning();
    return rows[0] ?? null;
  },

  async findById(
    exec: Executor,
    id: string,
    options: { readonly includeDeleted?: boolean } = {},
  ): Promise<LibraryAssetRow | null> {
    const rows = await exec
      .select()
      .from(libraryAssets)
      .where(
        and(
          eq(libraryAssets.id, id),
          options.includeDeleted === true ? undefined : isNull(libraryAssets.deletedAt),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  /** Las filas vivas con esas URLs de origen (para marcar «ya importado»). */
  async findBySourceUrls(
    exec: Executor,
    urls: readonly string[],
  ): Promise<LibraryAssetRow[]> {
    if (urls.length === 0) return [];
    return exec
      .select()
      .from(libraryAssets)
      .where(
        and(
          inArray(libraryAssets.licenseSourceUrl, [...urls]),
          isNull(libraryAssets.deletedAt),
        ),
      );
  },

  /** Lo más nuevo primero, keyset por `(created_at, id)`. */
  async list(
    exec: Executor,
    filter: LibraryAssetFilter = {},
  ): Promise<Page<LibraryAssetRow>> {
    const limit = clampLimit(filter.limit, DEFAULT_LIMIT);
    const rows = await exec
      .select()
      .from(libraryAssets)
      .where(
        and(
          ...filterConditions(filter),
          cursorCondition(
            libraryAssets.createdAt,
            libraryAssets.id,
            filter.cursor,
            "desc",
          ),
        ),
      )
      .orderBy(desc(libraryAssets.createdAt), sql`${libraryAssets.id}::text desc`)
      .limit(fetchLimit(limit));
    return buildPage(rows, limit, (row) => ({ createdAt: row.createdAt, id: row.id }));
  },

  async update(
    exec: Executor,
    id: string,
    patch: LibraryAssetPatch,
  ): Promise<LibraryAssetRow | null> {
    const rows = await exec
      .update(libraryAssets)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(libraryAssets.id, id), isNull(libraryAssets.deletedAt)))
      .returning();
    return rows[0] ?? null;
  },

  /**
   * Soft delete. El objeto queda en el bucket: las copias en el Media Bank de
   * cada marca son independientes, y el render de una pieza vieja que
   * apuntara al asset global no se rompe por borrarlo de la lista.
   */
  async softDelete(exec: Executor, id: string): Promise<boolean> {
    const rows = await exec
      .update(libraryAssets)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(libraryAssets.id, id), isNull(libraryAssets.deletedAt)))
      .returning({ id: libraryAssets.id });
    return rows.length > 0;
  },
};

/**
 * Candidatos para el decisor (`PU-S9-008`): sólo `ready`, filtrados en SQL por
 * lo que es duro (tipo, duración, aspecto) y ordenados por relevancia de
 * texto si hay texto. El juicio fino (¿encaja con el guion?) no es de acá: lo
 * hace el decisor leyendo `describeLibraryAsset` de cada fila.
 */
export async function listLibraryCandidates(
  exec: Executor,
  query: LibraryCandidateQuery,
): Promise<LibraryAssetRow[]> {
  if (query.kinds.length === 0) return [];
  const limit = clampLimit(query.limit, 30);
  const text = query.text?.trim() ?? "";
  const conditions: (SQL | undefined)[] = [
    isNull(libraryAssets.deletedAt),
    eq(libraryAssets.status, "ready"),
    inArray(libraryAssets.kind, [...query.kinds]),
    query.maxDurationSec === undefined
      ? undefined
      : lte(libraryAssets.durationSec, query.maxDurationSec),
    query.aspect === undefined
      ? undefined
      : sql`${libraryAssets.metadata}->'aspect'->>'ratio' = ${query.aspect}`,
  ];
  if (text === "") {
    return exec
      .select()
      .from(libraryAssets)
      .where(and(...conditions))
      .orderBy(desc(libraryAssets.createdAt))
      .limit(limit);
  }
  // Con texto: primero lo que matchea (por rank), después el resto; un tema
  // raro no deja al decisor sin candidatos (se completa hasta `limit`).
  const rank = sql<number>`ts_rank(to_tsvector('simple', ${libraryAssets.searchText}), websearch_to_tsquery('simple', ${text}))`;
  return exec
    .select()
    .from(libraryAssets)
    .where(and(...conditions))
    .orderBy(sql`${rank} desc`, desc(libraryAssets.createdAt))
    .limit(limit);
}
