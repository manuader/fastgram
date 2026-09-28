/**
 * Preferencias aprendidas desde Blitz — sprint 9 (agente Q), migración `0039`.
 *
 * ## Dos scopes, como en `character-models.ts`
 *
 * - `preference_signals` y `preference_weights` son **de la marca**: toda
 *   función lleva {@link TenantScope} y filtra por `companyId` además de RLS.
 * - `owner_preferences` es **del dueño** (sin RLS): toda función lleva
 *   {@link OwnerScope}. No tiene RLS, así que anda dentro de la transacción de
 *   cualquier marca: es lo que deja que cada marca escriba su aporte al dueño
 *   sin cruzar tenants (ver la cabecera de la migración).
 *
 * `@fastgram/db` no importa `@fastgram/core`: las estadísticas viajan como
 * `unknown` (jsonb) y los rasgos como `string[]`. Quien las interpreta es
 * `core` (`parsePreferenceStats`, `loadPreferences`).
 */
import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";

import type { Executor } from "../client.js";
import { contentAngles } from "../schema/blitz.js";
import { characterModels } from "../schema/character-models.js";
import { influencers } from "../schema/influencers.js";
import { brandAudioTracks, media } from "../schema/media.js";
import {
  ownerPreferences,
  preferenceSignals,
  preferenceWeights,
  type PreferenceSignalAspectValue,
  type PreferenceSignalKindValue,
} from "../schema/preferences.js";
import type { TenantScope } from "./base.js";
import { workspaceDirectory, type OwnerScope } from "./workspace-directory.js";

export type PreferenceSignalRow = typeof preferenceSignals.$inferSelect;
export type PreferenceWeightsRow = typeof preferenceWeights.$inferSelect;
export type OwnerPreferencesRow = typeof ownerPreferences.$inferSelect;

export interface NewPreferenceSignal {
  readonly suggestionId: string;
  readonly contentId?: string | null | undefined;
  readonly kind: PreferenceSignalKindValue;
  readonly aspect: PreferenceSignalAspectValue;
  readonly features: readonly string[];
  readonly removed?: readonly string[] | undefined;
  readonly added?: readonly string[] | undefined;
  readonly weight: number;
  readonly vocabularyVersion: number;
  readonly occurredAt: Date;
}

/** Tope de señales que lee un recálculo (ver `PREFERENCE_SIGNAL_HORIZON_HALF_LIVES`). */
export const PREFERENCE_RECOMPUTE_MAX_SIGNALS = 5000;

export const preferenceSignalStore = {
  /**
   * Una señal por (sugerencia, tipo, aspecto). Si ya estaba, se reemplaza:
   * reintentar no suma y la última edición de un aspecto es la que vale.
   */
  async upsert(
    exec: Executor,
    scope: TenantScope,
    s: NewPreferenceSignal,
  ): Promise<PreferenceSignalRow> {
    const values = {
      companyId: scope.companyId,
      suggestionId: s.suggestionId,
      contentId: s.contentId ?? null,
      kind: s.kind,
      aspect: s.aspect,
      features: [...s.features],
      removed: [...(s.removed ?? [])],
      added: [...(s.added ?? [])],
      weight: s.weight,
      vocabularyVersion: s.vocabularyVersion,
      occurredAt: s.occurredAt,
    };
    const rows = await exec
      .insert(preferenceSignals)
      .values(values)
      .onConflictDoUpdate({
        target: [
          preferenceSignals.companyId,
          preferenceSignals.suggestionId,
          preferenceSignals.kind,
          preferenceSignals.aspect,
        ],
        set: {
          contentId: sql`coalesce(excluded.content_id, ${preferenceSignals.contentId})`,
          features: values.features,
          removed: values.removed,
          added: values.added,
          weight: values.weight,
          vocabularyVersion: values.vocabularyVersion,
          occurredAt: values.occurredAt,
          updatedAt: sql`now()`,
        },
      })
      .returning();
    const row = rows[0];
    if (row === undefined) throw new Error("upsert de preference_signals sin fila");
    return row;
  },

  /** Borra las ediciones de estos aspectos (el dueño volvió al original). */
  async deleteEdits(
    exec: Executor,
    scope: TenantScope,
    suggestionId: string,
    kind: "edit_before_accept" | "edit_after_accept",
    aspects: readonly PreferenceSignalAspectValue[],
  ): Promise<number> {
    if (aspects.length === 0) return 0;
    const rows = await exec
      .delete(preferenceSignals)
      .where(
        and(
          eq(preferenceSignals.companyId, scope.companyId),
          eq(preferenceSignals.suggestionId, suggestionId),
          eq(preferenceSignals.kind, kind),
          inArray(preferenceSignals.aspect, [...aspects]),
        ),
      )
      .returning({ id: preferenceSignals.id });
    return rows.length;
  },

  /** La aceptación que produjo esta pieza, o `null` (no salió de Blitz). */
  async findAcceptByContent(
    exec: Executor,
    scope: TenantScope,
    contentId: string,
  ): Promise<PreferenceSignalRow | null> {
    const rows = await exec
      .select()
      .from(preferenceSignals)
      .where(
        and(
          eq(preferenceSignals.companyId, scope.companyId),
          eq(preferenceSignals.contentId, contentId),
          eq(preferenceSignals.kind, "accept"),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  /** Las más nuevas primero, desde `since` (exclusivo), hasta el tope. */
  async listRecent(
    exec: Executor,
    scope: TenantScope,
    options: {
      readonly since?: Date | null | undefined;
      readonly limit?: number | undefined;
    } = {},
  ): Promise<PreferenceSignalRow[]> {
    const where =
      options.since === null || options.since === undefined
        ? eq(preferenceSignals.companyId, scope.companyId)
        : and(
            eq(preferenceSignals.companyId, scope.companyId),
            gt(preferenceSignals.occurredAt, options.since),
          );
    return exec
      .select()
      .from(preferenceSignals)
      .where(where)
      .orderBy(desc(preferenceSignals.occurredAt), desc(preferenceSignals.id))
      .limit(options.limit ?? PREFERENCE_RECOMPUTE_MAX_SIGNALS);
  },

  async summary(
    exec: Executor,
    scope: TenantScope,
  ): Promise<{ total: number; lastAt: Date | null }> {
    const rows = await exec
      .select({
        total: sql<number>`count(*)::int`,
        lastAt: sql<Date | null>`max(${preferenceSignals.occurredAt})`,
      })
      .from(preferenceSignals)
      .where(eq(preferenceSignals.companyId, scope.companyId));
    const r = rows[0];
    const last = r?.lastAt ?? null;
    return {
      total: r?.total ?? 0,
      // `max()` por `sql<>` vuelve como string con postgres.js: se normaliza.
      lastAt: last === null ? null : new Date(last),
    };
  },

  async deleteAll(exec: Executor, scope: TenantScope): Promise<number> {
    const rows = await exec
      .delete(preferenceSignals)
      .where(eq(preferenceSignals.companyId, scope.companyId))
      .returning({ id: preferenceSignals.id });
    return rows.length;
  },
};

export interface PreferenceSettingsPatch {
  readonly enabled?: boolean | undefined;
  /** `null` = volver a heredar la del dueño. */
  readonly exploration?: number | null | undefined;
  readonly halfLifeDays?: number | null | undefined;
}

export const preferenceWeightsStore = {
  async find(exec: Executor, scope: TenantScope): Promise<PreferenceWeightsRow | null> {
    const rows = await exec
      .select()
      .from(preferenceWeights)
      .where(eq(preferenceWeights.companyId, scope.companyId))
      .limit(1);
    return rows[0] ?? null;
  },

  /** Escribe los pesos recalculados (crea la fila si falta, sin tocar la configuración). */
  async putStats(
    exec: Executor,
    scope: TenantScope,
    v: {
      readonly stats: unknown;
      readonly signalCount: number;
      readonly computedAt: Date;
    },
  ): Promise<void> {
    await exec
      .insert(preferenceWeights)
      .values({
        companyId: scope.companyId,
        stats: v.stats,
        signalCount: v.signalCount,
        computedAt: v.computedAt,
      })
      .onConflictDoUpdate({
        target: preferenceWeights.companyId,
        set: {
          stats: v.stats,
          signalCount: v.signalCount,
          computedAt: v.computedAt,
          updatedAt: sql`now()`,
        },
      });
  },

  async patchSettings(
    exec: Executor,
    scope: TenantScope,
    patch: PreferenceSettingsPatch,
  ): Promise<PreferenceWeightsRow> {
    const set: Partial<typeof preferenceWeights.$inferInsert> = {};
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    if (patch.exploration !== undefined) set.exploration = patch.exploration;
    if (patch.halfLifeDays !== undefined) set.halfLifeDays = patch.halfLifeDays;
    const rows = await exec
      .insert(preferenceWeights)
      .values({ companyId: scope.companyId, ...set })
      .onConflictDoUpdate({
        target: preferenceWeights.companyId,
        set: { ...set, updatedAt: sql`now()` },
      })
      .returning();
    const row = rows[0];
    if (row === undefined) throw new Error("upsert de preference_weights sin fila");
    return row;
  },

  /** Olvida los pesos (la configuración queda). */
  async clearStats(exec: Executor, scope: TenantScope): Promise<void> {
    await exec
      .update(preferenceWeights)
      .set({ stats: {}, signalCount: 0, computedAt: null, updatedAt: sql`now()` })
      .where(eq(preferenceWeights.companyId, scope.companyId));
  },
};

export interface OwnerPreferencesPatch {
  readonly exploration?: number | undefined;
  readonly halfLifeDays?: number | undefined;
}

export const ownerPreferencesStore = {
  async find(exec: Executor, owner: OwnerScope): Promise<OwnerPreferencesRow | null> {
    const rows = await exec
      .select()
      .from(ownerPreferences)
      .where(eq(ownerPreferences.ownerUserId, owner.ownerUserId))
      .limit(1);
    return rows[0] ?? null;
  },

  /**
   * El aporte de **una** marca al nivel del dueño. Una sola sentencia
   * (`brand_stats || {companyId: stats}`): dos marcas a la vez no se pisan.
   */
  async putBrandStats(
    exec: Executor,
    owner: OwnerScope,
    companyId: string,
    stats: unknown,
  ): Promise<void> {
    const entry = sql`jsonb_build_object(${companyId}::text, ${JSON.stringify(stats)}::jsonb)`;
    await exec
      .insert(ownerPreferences)
      .values({ ownerUserId: owner.ownerUserId, brandStats: sql`${entry}` })
      .onConflictDoUpdate({
        target: ownerPreferences.ownerUserId,
        set: {
          brandStats: sql`${ownerPreferences.brandStats} || ${entry}`,
          updatedAt: sql`now()`,
        },
      });
  },

  async removeBrand(exec: Executor, owner: OwnerScope, companyId: string): Promise<void> {
    await exec
      .update(ownerPreferences)
      .set({
        brandStats: sql`${ownerPreferences.brandStats} - ${companyId}::text`,
        updatedAt: sql`now()`,
      })
      .where(eq(ownerPreferences.ownerUserId, owner.ownerUserId));
  },

  async patchSettings(
    exec: Executor,
    owner: OwnerScope,
    patch: OwnerPreferencesPatch,
  ): Promise<OwnerPreferencesRow> {
    const set: Partial<typeof ownerPreferences.$inferInsert> = {};
    if (patch.exploration !== undefined) set.exploration = patch.exploration;
    if (patch.halfLifeDays !== undefined) set.halfLifeDays = patch.halfLifeDays;
    const rows = await exec
      .insert(ownerPreferences)
      .values({ ownerUserId: owner.ownerUserId, ...set })
      .onConflictDoUpdate({
        target: ownerPreferences.ownerUserId,
        set: { ...set, updatedAt: sql`now()` },
      })
      .returning();
    const row = rows[0];
    if (row === undefined) throw new Error("upsert de owner_preferences sin fila");
    return row;
  },

  /**
   * Reset del dueño: lo anterior a `at` deja de contar para su nivel. Las
   * marcas conservan lo suyo.
   */
  async reset(exec: Executor, owner: OwnerScope, at: Date): Promise<void> {
    await exec
      .insert(ownerPreferences)
      .values({ ownerUserId: owner.ownerUserId, resetAt: at })
      .onConflictDoUpdate({
        target: ownerPreferences.ownerUserId,
        set: { resetAt: at, brandStats: {}, updatedAt: sql`now()` },
      });
  },
};

/**
 * `PreferenceSnapshotStore` de `@fastgram/core` sobre una transacción **con la
 * marca puesta** (`withCompany`/`runScoped`). Estructural: `db` no importa
 * `core`, y el tipo de `core` lo verifica en quien lo usa.
 *
 * El dueño se resuelve desde la company de la marca (`companies` es visible
 * con RLS para su propia fila) y su fila no tiene RLS.
 */
export function preferenceSnapshotStore(exec: Executor): {
  load(companyId: string): Promise<{
    brand: {
      enabled: boolean;
      exploration: number | null;
      halfLifeDays: number | null;
      stats: unknown;
    } | null;
    owner: {
      exploration: number;
      halfLifeDays: number;
      brandStats: Record<string, unknown>;
    } | null;
  }>;
} {
  return {
    async load(companyId) {
      const brand = await preferenceWeightsStore.find(exec, { companyId });
      const ownerOf = await workspaceDirectory.ownerOf(exec, companyId);
      const owner =
        ownerOf === null
          ? null
          : await ownerPreferencesStore.find(exec, { ownerUserId: ownerOf.ownerUserId });
      return {
        brand:
          brand === null
            ? null
            : {
                enabled: brand.enabled,
                exploration: brand.exploration,
                halfLifeDays: brand.halfLifeDays,
                stats: brand.stats,
              },
        owner:
          owner === null
            ? null
            : {
                exploration: owner.exploration,
                halfLifeDays: owner.halfLifeDays,
                brandStats: isRecord(owner.brandStats) ? owner.brandStats : {},
              },
      };
    },
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// ───────────────────────────────────────────────────────────────────────────
// Lo que hace falta para extraer rasgos y nombrarlos
// ───────────────────────────────────────────────────────────────────────────

/** Lo que un rasgo necesita de un asset del Media Bank. */
export interface PreferenceMediaFacts {
  readonly mediaId: string;
  readonly url: string;
  readonly mediaType: "image" | "video";
  readonly origin: string;
  readonly tags: readonly string[];
  readonly durationSec: number | null;
}

export interface PreferenceAudioFacts {
  readonly id: string;
  readonly url: string;
  readonly origin: string;
  readonly title: string;
}

const mediaFacts = {
  mediaId: media.mediaId,
  url: media.r2Url,
  mediaType: media.mediaType,
  origin: media.origin,
  tags: media.tags,
  durationSec: media.videoDurationSec,
};

const audioFacts = {
  id: brandAudioTracks.id,
  url: brandAudioTracks.url,
  origin: brandAudioTracks.origin,
  title: brandAudioTracks.title,
};

/**
 * Lecturas de apoyo, todas con scope de marca (media, pistas, ángulos,
 * influencers) salvo los nombres de modelos, que son del dueño. Incluyen lo
 * borrado: una pieza vieja sigue teniendo los rasgos de su fondo aunque el
 * asset ya no esté en el Media Bank.
 */
export const preferenceLookups = {
  async mediaByIds(
    exec: Executor,
    scope: TenantScope,
    ids: readonly string[],
  ): Promise<PreferenceMediaFacts[]> {
    if (ids.length === 0) return [];
    return exec
      .select(mediaFacts)
      .from(media)
      .where(and(eq(media.companyId, scope.companyId), inArray(media.mediaId, [...ids])));
  },

  async mediaByUrls(
    exec: Executor,
    scope: TenantScope,
    urls: readonly string[],
  ): Promise<PreferenceMediaFacts[]> {
    if (urls.length === 0) return [];
    return exec
      .select(mediaFacts)
      .from(media)
      .where(and(eq(media.companyId, scope.companyId), inArray(media.r2Url, [...urls])));
  },

  async audioByIds(
    exec: Executor,
    scope: TenantScope,
    ids: readonly string[],
  ): Promise<PreferenceAudioFacts[]> {
    if (ids.length === 0) return [];
    return exec
      .select(audioFacts)
      .from(brandAudioTracks)
      .where(
        and(
          eq(brandAudioTracks.companyId, scope.companyId),
          inArray(brandAudioTracks.id, [...ids]),
        ),
      );
  },

  async audioByUrls(
    exec: Executor,
    scope: TenantScope,
    urls: readonly string[],
  ): Promise<PreferenceAudioFacts[]> {
    if (urls.length === 0) return [];
    return exec
      .select(audioFacts)
      .from(brandAudioTracks)
      .where(
        and(
          eq(brandAudioTracks.companyId, scope.companyId),
          inArray(brandAudioTracks.url, [...urls]),
        ),
      );
  },

  /** influencer → nombre y modelo de la biblioteca (`model_id`, 0033). */
  async influencers(
    exec: Executor,
    scope: TenantScope,
    ids: readonly string[],
  ): Promise<{ id: string; name: string; modelId: string | null }[]> {
    if (ids.length === 0) return [];
    return exec
      .select({
        id: influencers.id,
        name: influencers.name,
        modelId: influencers.modelId,
      })
      .from(influencers)
      .where(
        and(
          eq(influencers.companyId, scope.companyId),
          inArray(influencers.id, [...ids]),
        ),
      );
  },

  async angles(
    exec: Executor,
    scope: TenantScope,
    ids: readonly string[],
  ): Promise<{ id: string; title: string }[]> {
    if (ids.length === 0) return [];
    return exec
      .select({ id: contentAngles.id, title: contentAngles.title })
      .from(contentAngles)
      .where(
        and(
          eq(contentAngles.companyId, scope.companyId),
          inArray(contentAngles.id, [...ids]),
        ),
      );
  },

  /** Nombres de modelos **del dueño** (los ajenos no vuelven). */
  async modelNames(
    exec: Executor,
    owner: OwnerScope,
    ids: readonly string[],
  ): Promise<{ id: string; name: string }[]> {
    if (ids.length === 0) return [];
    return exec
      .select({ id: characterModels.id, name: characterModels.name })
      .from(characterModels)
      .where(
        and(
          eq(characterModels.ownerUserId, owner.ownerUserId),
          inArray(characterModels.id, [...ids]),
        ),
      );
  },
};
