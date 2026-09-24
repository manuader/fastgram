/**
 * El lado de la base del handler de `brand-source-analysis` — PRD §9.5 #18,
 * `AI-016`, `FR-011.7`, `DATA-004`, `DATA-031`, `DATA-032`.
 *
 * ## La forma del handler, y por qué las escrituras son condicionales
 *
 * ```
 *   [tx 1]  pending|analyzing → analyzing          (reclamar la fuente)
 *           leer la fuente, sintetizar con LLM     minutos, fuera de toda tx
 *   [tx 2]  analyzing → ready|partial   (UPDATE … WHERE status='analyzing')
 *           + INSERT del snapshot
 *           + el perfil, con la fila BLOQUEADA
 * ```
 *
 * Igual que `media-normalization.ts`: el trabajo largo no cabe en una
 * transacción, así que lo que tiene que seguir siendo cierto al escribir va en
 * el `WHERE` del `UPDATE`, que con READ COMMITTED **espera y reevalúa** si otra
 * entrega compite (trampa 37: un `UPDATE` es una guarda por sí solo; un
 * `INSERT` no). Por eso el snapshot se inserta **después** de ganar ese
 * `UPDATE` y en la misma transacción: la entrega que pierde no deja un
 * snapshot huérfano.
 *
 * El perfil sí se bloquea (`FOR UPDATE`), porque ahí la carrera es con una
 * persona: un `PATCH /brand/profile` que marca `editedByUser` mientras la
 * síntesis decide si puede escribir ese campo. Con el bloqueo, la decisión se
 * toma sobre la marca que va a quedar.
 *
 * ## Por qué vive en `packages/db`
 *
 * Es SQL, y `apps/worker` no importa `drizzle-orm`: es lo que impide que un
 * proceso arme su propio `WHERE` y se olvide el tenant. Cada sentencia lleva
 * `companyId` **en el `WHERE`**, además de RLS; los tests de
 * `brand-analysis.int.test.ts` corren sin GUC para medir sólo esta capa
 * (trampa 26).
 */

import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";

import type { Executor } from "../client.js";
import {
  brandSources,
  brandSourceSnapshots,
  companyProfiles,
  type BrandSourceAnalysisPhase,
} from "../schema/index.js";
import type { TenantScope } from "./base.js";

export type BrandSourceRow = typeof brandSources.$inferSelect;
export type CompanyProfileRow = typeof companyProfiles.$inferSelect;
type AcquisitionTier = BrandSourceRow["acquisitionTier"];
type FailureReason = NonNullable<BrandSourceRow["failureReason"]>;

/**
 * La fuente, sin bloquear. `null` si no existe o es de otro workspace: los dos
 * son lo mismo para el handler (§9.2) — un payload manipulado no puede
 * analizar la fuente de otro cliente.
 */
export async function findBrandSourceForAnalysis(
  exec: Executor,
  scope: TenantScope,
  brandSourceId: string,
): Promise<BrandSourceRow | null> {
  const filas = await exec
    .select()
    .from(brandSources)
    .where(
      and(
        eq(brandSources.companyId, scope.companyId),
        eq(brandSources.id, brandSourceId),
      ),
    )
    .limit(1);
  return filas[0] ?? null;
}

/**
 * `pending → analyzing`, o reafirma `analyzing`.
 *
 * `pending` es lo que deja `POST /brand/sources`; `analyzing` lo que deja
 * `/reanalyse` (que ya aplicó el cooldown y movió `analysisCount` en su
 * transacción) y también una reentrega de este mismo job. Cualquier otro
 * estado significa que otra entrega ya terminó: `null`, y no se hace nada.
 *
 * **No toca `analysisCount`**: el límite de re-análisis es de la API, que lo
 * cuenta al aceptar el pedido. Contarlo acá también lo contaría dos veces.
 */
export async function claimBrandSourceAnalysis(
  exec: Executor,
  scope: TenantScope,
  brandSourceId: string,
  now: Date,
): Promise<BrandSourceRow | null> {
  const filas = await exec
    .update(brandSources)
    .set({
      status: "analyzing",
      failureReason: null,
      analysisPhase: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(brandSources.companyId, scope.companyId),
        eq(brandSources.id, brandSourceId),
        inArray(brandSources.status, ["pending", "analyzing"]),
      ),
    )
    .returning();
  return filas[0] ?? null;
}

/**
 * `0031` (`P1-ONB-005`): la etapa en la que entra el handler. Sólo mientras
 * la fuente siga `analyzing` —una entrega tardía no pinta una fase sobre un
 * `ready`—, y sin tocar `updatedAt`: es progreso, no un cambio de la fuente.
 * `false` si la fuente ya no estaba en `analyzing` (o no es del workspace).
 */
export async function setBrandSourceAnalysisPhase(
  exec: Executor,
  scope: TenantScope,
  brandSourceId: string,
  phase: BrandSourceAnalysisPhase,
): Promise<boolean> {
  const filas = await exec
    .update(brandSources)
    .set({ analysisPhase: phase })
    .where(
      and(
        eq(brandSources.companyId, scope.companyId),
        eq(brandSources.id, brandSourceId),
        eq(brandSources.status, "analyzing"),
      ),
    )
    .returning({ id: brandSources.id });
  return filas.length > 0;
}

export interface CompleteBrandSourceInput {
  readonly status: "ready" | "partial";
  /** Con qué tier se resolvió de verdad (`DATA-031.acquisitionTier`). */
  readonly acquisitionTier: AcquisitionTier;
  /** `DATA-031.displayName`/`avatarUrl`: lo resuelto en la fuente, si vino. */
  readonly displayName?: string | undefined;
  readonly avatarUrl?: string | undefined;
  readonly now: Date;
}

/**
 * `analyzing → ready | partial`. `null` si la fuente ya no estaba en
 * `analyzing` (otra entrega terminó, o se borró): quien llama no escribe nada
 * más en esa transacción.
 */
export async function completeBrandSourceAnalysis(
  exec: Executor,
  scope: TenantScope,
  brandSourceId: string,
  input: CompleteBrandSourceInput,
): Promise<BrandSourceRow | null> {
  const filas = await exec
    .update(brandSources)
    .set({
      status: input.status,
      failureReason: null,
      analysisPhase: null,
      acquisitionTier: input.acquisitionTier,
      lastAnalysedAt: input.now,
      updatedAt: input.now,
      ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
      ...(input.avatarUrl === undefined ? {} : { avatarUrl: input.avatarUrl }),
    })
    .where(
      and(
        eq(brandSources.companyId, scope.companyId),
        eq(brandSources.id, brandSourceId),
        eq(brandSources.status, "analyzing"),
      ),
    )
    .returning();
  return filas[0] ?? null;
}

export interface FailBrandSourceInput {
  /**
   * `null` cuando ningún motivo del enum de `DATA-031` es verdad (un error
   * interno, una respuesta del LLM fuera de contrato). La columna es nullable
   * y el contrato lo omite: «falló» sin un motivo falso.
   */
  readonly failureReason: FailureReason | null;
  /** `FR-011.4` / `AI-016`: agotada la escalera, se degrada a `D_assisted`. */
  readonly acquisitionTier: AcquisitionTier;
  readonly now: Date;
}

/**
 * `analyzing → failed`. `false` si ya no estaba en `analyzing`: un fallo
 * tardío **no** pisa un `ready` que escribió otra entrega.
 *
 * `lastAnalysedAt` se mueve también, como en `failAnalysis` de `core`: es el
 * ancla de la ventana de re-análisis que usa la API.
 */
export async function failBrandSourceAnalysis(
  exec: Executor,
  scope: TenantScope,
  brandSourceId: string,
  input: FailBrandSourceInput,
): Promise<boolean> {
  const filas = await exec
    .update(brandSources)
    .set({
      status: "failed",
      failureReason: input.failureReason,
      analysisPhase: null,
      acquisitionTier: input.acquisitionTier,
      lastAnalysedAt: input.now,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(brandSources.companyId, scope.companyId),
        eq(brandSources.id, brandSourceId),
        eq(brandSources.status, "analyzing"),
      ),
    )
    .returning({ id: brandSources.id });
  return filas.length > 0;
}

export interface InsertSnapshotInput {
  /** Lo genera quien llama: el `excerptRef` del perfil lo necesita antes del INSERT. */
  readonly id: string;
  readonly brandSourceId: string;
  readonly tier: AcquisitionTier;
  readonly capturedAt: Date;
  readonly profileSignals: unknown;
  readonly contentItems: readonly unknown[];
  readonly derivedFields: unknown;
  readonly conflicts: readonly unknown[];
  /** `DATA-032`: el PRD no da la duración; la pasa quien llama desde su configuración. */
  readonly rawRetentionExpiresAt: Date;
}

/**
 * Inserta el snapshot **sólo si la fuente es del workspace**.
 *
 * Un `INSERT … VALUES` con el `companyId` del scope y un `brandSourceId` ajeno
 * pasaría: la FK no mira el workspace y RLS sólo mira la columna
 * `company_id` de la fila nueva, que es la propia. El resultado sería un
 * snapshot de la fuente de otro cliente colgando del workspace propio. Con
 * `INSERT … SELECT` desde `brand_sources` filtrado por los dos ids, la fila
 * sólo existe si el par es coherente. Devuelve `null` si no lo es.
 */
export async function insertBrandSourceSnapshot(
  exec: Executor,
  scope: TenantScope,
  input: InsertSnapshotInput,
): Promise<{ id: string } | null> {
  const filas = await exec
    .insert(brandSourceSnapshots)
    .select(
      exec
        .select({
          id: sql<string>`${input.id}::uuid`.as("id"),
          brandSourceId: brandSources.id,
          companyId: brandSources.companyId,
          capturedAt: sql<Date>`${input.capturedAt.toISOString()}::timestamptz`.as(
            "captured_at",
          ),
          tier: sql<AcquisitionTier>`${input.tier}::acquisition_tier`.as("tier"),
          profileSignals: sql`${JSON.stringify(input.profileSignals ?? null)}::jsonb`.as(
            "profile_signals",
          ),
          contentItems: sql`${JSON.stringify(input.contentItems)}::jsonb`.as(
            "content_items",
          ),
          derivedFields: sql`${JSON.stringify(input.derivedFields)}::jsonb`.as(
            "derived_fields",
          ),
          conflicts: sql`${JSON.stringify(input.conflicts)}::jsonb`.as("conflicts"),
          rawRetentionExpiresAt:
            sql<Date>`${input.rawRetentionExpiresAt.toISOString()}::timestamptz`.as(
              "raw_retention_expires_at",
            ),
          createdAt: sql<Date>`${input.capturedAt.toISOString()}::timestamptz`.as(
            "created_at",
          ),
        })
        .from(brandSources)
        .where(
          and(
            eq(brandSources.companyId, scope.companyId),
            eq(brandSources.id, input.brandSourceId),
          ),
        ),
    )
    .returning({ id: brandSourceSnapshots.id });
  return filas[0] ?? null;
}

/** El último snapshot de cada una de las **otras** fuentes, para la fusión. */
export interface OtherSourceSnapshot {
  readonly snapshotId: string;
  readonly brandSourceId: string;
  readonly sourceType: BrandSourceRow["sourceType"];
  readonly isPrimary: boolean;
  readonly derivedFields: unknown;
}

/**
 * `AI-016` etapa 4: «si ya hay otras fuentes, se fusionan con la precedencia
 * de `FR-011.6`». Sólo fuentes `ready`, `partial` o `stale`: una `failed` o
 * una en curso no tienen hoy una lectura en la que confiar, y una `pending`
 * no tiene ninguna.
 *
 * `derivedFields` sobrevive a la purga de `rawRetentionExpiresAt` (`DATA-032`),
 * así que esto sigue funcionando sobre snapshots viejos.
 */
export async function latestSnapshotsOfOtherSources(
  exec: Executor,
  scope: TenantScope,
  excludeBrandSourceId: string,
): Promise<readonly OtherSourceSnapshot[]> {
  const filas = await exec
    .selectDistinctOn([brandSourceSnapshots.brandSourceId], {
      snapshotId: brandSourceSnapshots.id,
      brandSourceId: brandSourceSnapshots.brandSourceId,
      sourceType: brandSources.sourceType,
      isPrimary: brandSources.isPrimary,
      derivedFields: brandSourceSnapshots.derivedFields,
    })
    .from(brandSourceSnapshots)
    .innerJoin(brandSources, eq(brandSources.id, brandSourceSnapshots.brandSourceId))
    .where(
      and(
        eq(brandSourceSnapshots.companyId, scope.companyId),
        eq(brandSources.companyId, scope.companyId),
        ne(brandSourceSnapshots.brandSourceId, excludeBrandSourceId),
        inArray(brandSources.status, ["ready", "partial", "stale"]),
      ),
    )
    .orderBy(brandSourceSnapshots.brandSourceId, desc(brandSourceSnapshots.capturedAt));
  return filas;
}

/**
 * El perfil del workspace, **bloqueado** hasta el fin de la transacción, y
 * creado si no existe.
 *
 * El `INSERT … ON CONFLICT DO NOTHING` primero es lo que permite bloquear algo
 * cuando el perfil todavía no existe (el alta de la primera fuente): sin fila
 * no hay qué bloquear, y un `PATCH /brand/profile` concurrente crearía la suya
 * y chocaría contra el índice único.
 */
export async function lockCompanyProfile(
  exec: Executor,
  scope: TenantScope,
): Promise<CompanyProfileRow> {
  await exec
    .insert(companyProfiles)
    .values({ companyId: scope.companyId })
    .onConflictDoNothing({ target: companyProfiles.companyId });
  const filas = await exec
    .select()
    .from(companyProfiles)
    .where(eq(companyProfiles.companyId, scope.companyId))
    .limit(1)
    .for("update");
  const fila = filas[0];
  if (fila === undefined) {
    // El INSERT de arriba garantiza la fila salvo que RLS la esconda — o sea,
    // un GUC que no coincide con el scope. Es un bug de quien llama.
    throw new Error("lockCompanyProfile: el perfil no es visible después de crearlo");
  }
  return fila;
}

/** Los campos que `AI-016` deriva (`BRAND_PROFILE_FIELDS` de `core`). */
export interface MaterializedProfileValues {
  readonly coreIdentity?: string;
  readonly productOffering?: string;
  readonly uniqueBenefits?: string;
  readonly problemSolution?: string;
  readonly marketAndCompetition?: string;
  readonly toneOfVoice?: string;
  readonly targetAudience?: string;
  readonly businessCategories?: readonly string[];
}

export interface SaveMaterializedProfileInput {
  readonly values: MaterializedProfileValues;
  readonly fieldMeta: unknown;
  readonly brandRevision: number;
  readonly status: CompanyProfileRow["status"];
  readonly now: Date;
}

/**
 * Escribe lo que decidió la conciliación. Sólo los campos derivables: el
 * cuestionario del onboarding no se toca desde acá.
 */
export async function saveMaterializedProfile(
  exec: Executor,
  scope: TenantScope,
  profileId: string,
  input: SaveMaterializedProfileInput,
): Promise<CompanyProfileRow | null> {
  const { businessCategories, ...texts } = input.values;
  const filas = await exec
    .update(companyProfiles)
    .set({
      ...texts,
      ...(businessCategories === undefined
        ? {}
        : { businessCategories: [...businessCategories] }),
      fieldMeta: input.fieldMeta,
      brandRevision: input.brandRevision,
      status: input.status,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(companyProfiles.companyId, scope.companyId),
        eq(companyProfiles.id, profileId),
      ),
    )
    .returning();
  return filas[0] ?? null;
}

export const brandAnalysisStore = {
  findBrandSourceForAnalysis,
  claimBrandSourceAnalysis,
  setBrandSourceAnalysisPhase,
  completeBrandSourceAnalysis,
  failBrandSourceAnalysis,
  insertBrandSourceSnapshot,
  latestSnapshotsOfOtherSources,
  lockCompanyProfile,
  saveMaterializedProfile,
};
