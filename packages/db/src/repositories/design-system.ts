/**
 * Design system de una marca — `brand_design_systems` (migración `0035`,
 * sprint 9, agente M).
 *
 * Todo lleva `TenantScope` y la política RLS repite el filtro: una fila ajena
 * vuelve `null` y el 404 lo pone la ruta (§9.2).
 *
 * ## Activar
 *
 * «Una activa por marca» lo garantiza el índice único parcial; activar es
 * desactivar la anterior y activar ésta **en la misma transacción**, bajo un
 * advisory lock por marca (forma de dos enteros, espacio `design-system`) para
 * que dos imports que terminan a la vez no choquen contra el índice: el
 * segundo espera y gana, que es lo que el dueño espera (el último import).
 *
 * ## Los assets en `media`
 *
 * Se insertan con `origin = 'brand_kit'` (visibles en el Media Bank, migración
 * `0013`) y `tags` con `design-system` + la clase (`logo`, `imagery`,
 * `motif`, `generated`). Las claves son deterministas (ver
 * `core/design-system/jobs.ts`): la inserción saltea las que ya tienen fila,
 * borradas incluidas (igual que el kit de fondos: si el dueño borró un asset,
 * una reentrega no lo resucita).
 */
import { and, desc, eq, inArray, max, ne, sql } from "drizzle-orm";

import type { Executor } from "../client.js";
import { brandDesignSystems, type DesignSystemStatus } from "../schema/design-system.js";
import { media } from "../schema/media.js";
import type { TenantScope } from "./base.js";

export type BrandDesignSystemRow = typeof brandDesignSystems.$inferSelect;

export interface NewBrandDesignSystem {
  readonly source: "zip" | "derived";
  readonly name: string;
  readonly status: DesignSystemStatus;
  readonly description?: string | null;
  readonly tokens?: unknown;
  readonly style?: unknown;
  readonly assets?: unknown;
  readonly zipKey?: string | null;
  readonly zipBytes?: number | null;
}

export interface BrandDesignSystemPatch {
  readonly status?: DesignSystemStatus;
  readonly name?: string;
  readonly description?: string | null;
  readonly tokens?: unknown;
  readonly style?: unknown;
  readonly assets?: unknown;
  readonly fonts?: unknown;
  readonly pendingAssets?: unknown;
  readonly warnings?: readonly string[];
  readonly failureCode?: string | null;
  readonly failureMessage?: string | null;
}

const mine = (scope: TenantScope) => eq(brandDesignSystems.companyId, scope.companyId);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** El tag que marca en `media` lo que vino de un design system. */
export const DESIGN_SYSTEM_MEDIA_TAG = "design-system";

export async function lockCompanyDesignSystem(
  exec: Executor,
  scope: TenantScope,
): Promise<void> {
  await exec.execute(
    sql`select pg_advisory_xact_lock(hashtext('design-system'), hashtext(${scope.companyId}))`,
  );
}

export interface DesignSystemMediaInput {
  readonly mediaType: "image";
  readonly filename: string;
  readonly r2Url: string;
  readonly storageKey: string;
  readonly sizeMb: number;
  readonly categories: readonly string[];
  /** Además de `design-system`: la clase (`logo`, `imagery`, `motif`, `generated`). */
  readonly tags: readonly string[];
}

export const designSystemRepository = {
  table: brandDesignSystems,

  async findById(
    exec: Executor,
    scope: TenantScope,
    id: string,
  ): Promise<BrandDesignSystemRow | null> {
    const rows = await exec
      .select()
      .from(brandDesignSystems)
      .where(and(mine(scope), eq(brandDesignSystems.id, id)))
      .limit(1);
    return rows[0] ?? null;
  },

  async findActive(
    exec: Executor,
    scope: TenantScope,
  ): Promise<BrandDesignSystemRow | null> {
    const rows = await exec
      .select()
      .from(brandDesignSystems)
      .where(and(mine(scope), eq(brandDesignSystems.active, true)))
      .limit(1);
    return rows[0] ?? null;
  },

  /** La más nueva (activa o no): la que muestra el estado de un import en curso. */
  async findLatest(
    exec: Executor,
    scope: TenantScope,
  ): Promise<BrandDesignSystemRow | null> {
    const rows = await exec
      .select()
      .from(brandDesignSystems)
      .where(mine(scope))
      .orderBy(desc(brandDesignSystems.version))
      .limit(1);
    return rows[0] ?? null;
  },

  async list(
    exec: Executor,
    scope: TenantScope,
    limit = 20,
  ): Promise<BrandDesignSystemRow[]> {
    return exec
      .select()
      .from(brandDesignSystems)
      .where(mine(scope))
      .orderBy(desc(brandDesignSystems.version))
      .limit(Math.min(Math.max(1, limit), 100));
  },

  /**
   * Crea una versión nueva. **Tiene que correr después de
   * {@link lockCompanyDesignSystem}** en la misma transacción: el número de
   * versión sale de un `max()` y sin el lock dos creaciones lo repetirían (el
   * índice único lo atraparía como error).
   */
  async create(
    exec: Executor,
    scope: TenantScope,
    input: NewBrandDesignSystem,
  ): Promise<BrandDesignSystemRow> {
    const [{ current } = { current: null }] = await exec
      .select({ current: max(brandDesignSystems.version) })
      .from(brandDesignSystems)
      .where(mine(scope));
    const rows = await exec
      .insert(brandDesignSystems)
      .values({
        companyId: scope.companyId,
        source: input.source,
        name: input.name,
        status: input.status,
        version: (current ?? 0) + 1,
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.tokens === undefined ? {} : { tokens: input.tokens }),
        ...(input.style === undefined ? {} : { style: input.style }),
        ...(input.assets === undefined ? {} : { assets: input.assets }),
        ...(input.zipKey === undefined ? {} : { zipKey: input.zipKey }),
        ...(input.zipBytes === undefined ? {} : { zipBytes: input.zipBytes }),
      })
      .returning();
    const row = rows[0];
    if (row === undefined)
      throw new Error("insert into brand_design_systems returned nothing");
    return row;
  },

  async update(
    exec: Executor,
    scope: TenantScope,
    id: string,
    patch: BrandDesignSystemPatch,
  ): Promise<BrandDesignSystemRow | null> {
    const rows = await exec
      .update(brandDesignSystems)
      .set({
        ...(patch.status === undefined ? {} : { status: patch.status }),
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.description === undefined ? {} : { description: patch.description }),
        ...(patch.tokens === undefined ? {} : { tokens: patch.tokens }),
        ...(patch.style === undefined ? {} : { style: patch.style }),
        ...(patch.assets === undefined ? {} : { assets: patch.assets }),
        ...(patch.fonts === undefined ? {} : { fonts: patch.fonts }),
        ...(patch.pendingAssets === undefined
          ? {}
          : { pendingAssets: patch.pendingAssets }),
        ...(patch.warnings === undefined ? {} : { warnings: [...patch.warnings] }),
        ...(patch.failureCode === undefined ? {} : { failureCode: patch.failureCode }),
        ...(patch.failureMessage === undefined
          ? {}
          : { failureMessage: patch.failureMessage }),
        updatedAt: new Date(),
      })
      .where(and(mine(scope), eq(brandDesignSystems.id, id)))
      .returning();
    return rows[0] ?? null;
  },

  /**
   * Marca `ready` y activa esta versión; desactiva la que estuviera. Tiene que
   * correr después de {@link lockCompanyDesignSystem}. `null` si no es de la marca.
   */
  async activate(
    exec: Executor,
    scope: TenantScope,
    id: string,
    patch: BrandDesignSystemPatch = {},
  ): Promise<BrandDesignSystemRow | null> {
    const target = await designSystemRepository.findById(exec, scope, id);
    if (target === null) return null;
    await exec
      .update(brandDesignSystems)
      .set({ active: false, updatedAt: new Date() })
      .where(
        and(
          mine(scope),
          eq(brandDesignSystems.active, true),
          ne(brandDesignSystems.id, id),
        ),
      );
    const updated = await designSystemRepository.update(exec, scope, id, {
      ...patch,
      status: "ready",
    });
    if (updated === null) return null;
    const rows = await exec
      .update(brandDesignSystems)
      .set({ active: true })
      .where(and(mine(scope), eq(brandDesignSystems.id, id)))
      .returning();
    return rows[0] ?? null;
  },

  /** Borra una versión. Los archivos quedan: una pieza hecha puede usarlos. */
  async delete(exec: Executor, scope: TenantScope, id: string): Promise<boolean> {
    const rows = await exec
      .delete(brandDesignSystems)
      .where(and(mine(scope), eq(brandDesignSystems.id, id)))
      .returning({ id: brandDesignSystems.id });
    return rows.length > 0;
  },

  /** Clave de storage → `mediaId` de las que ya tienen fila (borradas incluidas). */
  async mediaIdsByKey(
    exec: Executor,
    scope: TenantScope,
    storageKeys: readonly string[],
  ): Promise<Map<string, string>> {
    if (storageKeys.length === 0) return new Map();
    const rows = await exec
      .select({ storageKey: media.storageKey, mediaId: media.mediaId })
      .from(media)
      .where(
        and(
          eq(media.companyId, scope.companyId),
          inArray(media.storageKey, [...storageKeys]),
        ),
      );
    return new Map(rows.map((r) => [r.storageKey, r.mediaId]));
  },

  /**
   * Inserta en `media` los assets cuya clave todavía no tiene fila y devuelve
   * clave → `mediaId` de **todos** (los nuevos y los que ya estaban). Correr
   * bajo {@link lockCompanyDesignSystem}: es un `INSERT` (trampa 37).
   */
  async insertMedia(
    exec: Executor,
    scope: TenantScope,
    items: readonly DesignSystemMediaInput[],
  ): Promise<Map<string, string>> {
    const existing = await designSystemRepository.mediaIdsByKey(
      exec,
      scope,
      items.map((i) => i.storageKey),
    );
    const fresh = items.filter((i) => !existing.has(i.storageKey));
    if (fresh.length > 0) {
      const inserted = await exec
        .insert(media)
        .values(
          fresh.map((i) => ({
            companyId: scope.companyId,
            mediaType: i.mediaType,
            filename: i.filename,
            r2Url: i.r2Url,
            storageKey: i.storageKey,
            status: "ready" as const,
            sizeMb: i.sizeMb,
            categories: [...i.categories],
            tags: [
              ...new Set([
                DESIGN_SYSTEM_MEDIA_TAG,
                ...i.tags.map((t) => t.toLowerCase()),
              ]),
            ],
            origin: "brand_kit" as const,
          })),
        )
        .returning({ storageKey: media.storageKey, mediaId: media.mediaId });
      for (const r of inserted) existing.set(r.storageKey, r.mediaId);
    }
    return existing;
  },

  /** Media viva de la marca por id (la de los assets de un design system). */
  async liveMediaByIds(
    exec: Executor,
    scope: TenantScope,
    ids: readonly string[],
  ): Promise<{ mediaId: string; r2Url: string; filename: string }[]> {
    const uuids = ids.filter((id) => UUID_RE.test(id));
    if (uuids.length === 0) return [];
    return exec
      .select({ mediaId: media.mediaId, r2Url: media.r2Url, filename: media.filename })
      .from(media)
      .where(
        and(
          eq(media.companyId, scope.companyId),
          inArray(media.mediaId, uuids),
          sql`${media.deletedAt} is null`,
        ),
      );
  },

  /**
   * La media viva de la marca que sirve para derivar: logos (tag o nombre) e
   * imágenes listas. Sin las del propio design system (`design-system`).
   */
  async listDerivableMedia(
    exec: Executor,
    scope: TenantScope,
    limit = 24,
  ): Promise<{ mediaId: string; filename: string; tags: string[]; sizeMb: number }[]> {
    return exec
      .select({
        mediaId: media.mediaId,
        filename: media.filename,
        tags: media.tags,
        sizeMb: media.sizeMb,
      })
      .from(media)
      .where(
        and(
          eq(media.companyId, scope.companyId),
          eq(media.mediaType, "image"),
          eq(media.status, "ready"),
          sql`${media.deletedAt} is null`,
          sql`not (${DESIGN_SYSTEM_MEDIA_TAG} = any(${media.tags}))`,
        ),
      )
      .orderBy(desc(media.createdAt))
      .limit(limit);
  },
};
