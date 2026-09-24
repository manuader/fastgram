/**
 * La biblioteca de audio de una marca — `brand_audio_tracks` (migración `0025`).
 *
 * Todo lleva `TenantScope`, igual que el resto del paquete; la política RLS
 * repite el filtro desde la base. Una pista ajena o borrada es `null` y el 404
 * lo pone la ruta (§9.2).
 *
 * ## Por qué no alcanza `createCompanyScopedRepository`
 *
 * Hace falta búsqueda por título (`ILIKE`) con cursor, y el filtro declarativo
 * de `filters.ts` no tiene operador de "contiene". El resto (crear, renombrar,
 * borrar) es CRUD de siempre, escrito a mano para que las cuatro funciones
 * compartan el mismo `WHERE` de pertenencia.
 */
import { and, desc, eq, isNull, sql, type SQL } from "drizzle-orm";

import type { Executor } from "../client.js";
import {
  buildPage,
  cursorCondition,
  fetchLimit,
  normalizeLimit,
  type Page,
  type PageRequest,
} from "../pagination.js";
import { brandAudioTracks, type BrandAudioOrigin } from "../schema/media.js";
import type { TenantScope } from "./base.js";
import { escapeLike } from "./inspiration.js";

export type BrandAudioTrackRow = typeof brandAudioTracks.$inferSelect;

export interface NewBrandAudioTrack {
  readonly id?: string;
  readonly title: string;
  readonly origin: BrandAudioOrigin;
  readonly storageKey: string;
  readonly url: string;
  readonly contentType: string;
  readonly sizeMb: number;
  readonly durationSec?: number | null;
  readonly sourceUrl?: string | null;
  readonly importId?: string | null;
}

export interface BrandAudioListOptions extends PageRequest {
  /** Búsqueda por título, sin distinguir mayúsculas. Los comodines se escapan. */
  readonly q?: string | undefined;
}

export interface BrandAudioPatch {
  readonly title?: string;
  readonly autoUse?: boolean;
}

/** Viva y de esta marca. */
const live = (scope: TenantScope): SQL =>
  and(
    eq(brandAudioTracks.companyId, scope.companyId),
    isNull(brandAudioTracks.deletedAt),
  ) as SQL;

export const brandAudioRepository = {
  table: brandAudioTracks,

  async findById(
    exec: Executor,
    scope: TenantScope,
    id: string,
  ): Promise<BrandAudioTrackRow | null> {
    const rows = await exec
      .select()
      .from(brandAudioTracks)
      .where(and(live(scope), eq(brandAudioTracks.id, id)))
      .limit(1);
    return rows[0] ?? null;
  },

  /** La pista viva de esta marca con esa URL exacta, o `null`. */
  async findByUrl(
    exec: Executor,
    scope: TenantScope,
    url: string,
  ): Promise<BrandAudioTrackRow | null> {
    const rows = await exec
      .select()
      .from(brandAudioTracks)
      .where(and(live(scope), eq(brandAudioTracks.url, url)))
      .limit(1);
    return rows[0] ?? null;
  },

  /** Más nuevas primero: lo último que subiste es lo que vas a buscar. */
  async list(
    exec: Executor,
    scope: TenantScope,
    options: BrandAudioListOptions = {},
  ): Promise<Page<BrandAudioTrackRow>> {
    const limit = normalizeLimit(options.limit);
    const conditions: (SQL | undefined)[] = [
      live(scope),
      cursorCondition(
        brandAudioTracks.createdAt,
        brandAudioTracks.id,
        options.cursor,
        "desc",
      ),
    ];
    const q = options.q?.trim();
    if (q !== undefined && q !== "") {
      conditions.push(
        sql`${brandAudioTracks.title} ilike ${`%${escapeLike(q)}%`} escape '\\'`,
      );
    }
    const rows = await exec
      .select()
      .from(brandAudioTracks)
      .where(and(...conditions))
      .orderBy(desc(brandAudioTracks.createdAt), desc(sql`${brandAudioTracks.id}::text`))
      .limit(fetchLimit(limit));
    return buildPage(rows, limit, (row) => ({ createdAt: row.createdAt, id: row.id }));
  },

  /**
   * Las que Blitz/refill puede elegir solas (`auto_use`). Sin paginar a
   * propósito: es la biblioteca de una marca de uso personal, decenas de
   * pistas; el tope es una red contra una fila escrita a mano.
   */
  async listAutoUse(
    exec: Executor,
    scope: TenantScope,
    max = 500,
  ): Promise<readonly BrandAudioTrackRow[]> {
    return exec
      .select()
      .from(brandAudioTracks)
      .where(and(live(scope), eq(brandAudioTracks.autoUse, true)))
      .orderBy(desc(brandAudioTracks.createdAt))
      .limit(max);
  },

  async create(
    exec: Executor,
    scope: TenantScope,
    input: NewBrandAudioTrack,
  ): Promise<BrandAudioTrackRow> {
    const [row] = await exec
      .insert(brandAudioTracks)
      .values({
        ...(input.id === undefined ? {} : { id: input.id }),
        companyId: scope.companyId,
        title: input.title,
        origin: input.origin,
        storageKey: input.storageKey,
        url: input.url,
        contentType: input.contentType,
        sizeMb: input.sizeMb,
        durationSec: input.durationSec ?? null,
        sourceUrl: input.sourceUrl ?? null,
        importId: input.importId ?? null,
      })
      .returning();
    if (row === undefined) throw new Error("El INSERT de la pista no devolvió fila.");
    return row;
  },

  /**
   * La fila de un import por link, creada una sola vez: un reintento del
   * worker encuentra la que ya existe (`UNIQUE (company_id, import_id)`).
   */
  async createFromImport(
    exec: Executor,
    scope: TenantScope,
    input: NewBrandAudioTrack & { readonly importId: string },
  ): Promise<{ readonly row: BrandAudioTrackRow; readonly created: boolean }> {
    const inserted = await exec
      .insert(brandAudioTracks)
      .values({
        companyId: scope.companyId,
        title: input.title,
        origin: input.origin,
        storageKey: input.storageKey,
        url: input.url,
        contentType: input.contentType,
        sizeMb: input.sizeMb,
        durationSec: input.durationSec ?? null,
        sourceUrl: input.sourceUrl ?? null,
        importId: input.importId,
      })
      .onConflictDoNothing({
        target: [brandAudioTracks.companyId, brandAudioTracks.importId],
        where: sql`${brandAudioTracks.importId} is not null`,
      })
      .returning();
    const row = inserted[0];
    if (row !== undefined) return { row, created: true };
    const existing = await exec
      .select()
      .from(brandAudioTracks)
      .where(
        and(
          eq(brandAudioTracks.companyId, scope.companyId),
          eq(brandAudioTracks.importId, input.importId),
        ),
      )
      .limit(1);
    const found = existing[0];
    if (found === undefined) {
      throw new Error("El import de audio chocó con una fila que no se puede leer.");
    }
    return { row: found, created: false };
  },

  async update(
    exec: Executor,
    scope: TenantScope,
    id: string,
    patch: BrandAudioPatch,
  ): Promise<BrandAudioTrackRow | null> {
    const rows = await exec
      .update(brandAudioTracks)
      .set({
        ...(patch.title === undefined ? {} : { title: patch.title }),
        ...(patch.autoUse === undefined ? {} : { autoUse: patch.autoUse }),
        updatedAt: new Date(),
      })
      .where(and(live(scope), eq(brandAudioTracks.id, id)))
      .returning();
    return rows[0] ?? null;
  },

  /** Soft delete. `false` si no existía, era ajena o ya estaba borrada. */
  async softDelete(exec: Executor, scope: TenantScope, id: string): Promise<boolean> {
    const rows = await exec
      .update(brandAudioTracks)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(live(scope), eq(brandAudioTracks.id, id)))
      .returning({ id: brandAudioTracks.id });
    return rows.length > 0;
  },
};
