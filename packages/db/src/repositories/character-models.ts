/**
 * Biblioteca de modelos del dueño — sprint 8 (agente K), migración `0033`.
 *
 * ## El scope es el dueño, como en `workspace-directory.ts`
 *
 * Un modelo no es de una marca: es del dueño y se **asigna** a una o más
 * marcas. Así que ninguna función de este módulo toca `character_models` sin
 * `ownerUserId` en el `WHERE` ({@link OwnerScope}). Un id de otro dueño
 * devuelve `null`/nada, igual que un cruce de tenant.
 *
 * ## Qué conexión necesita
 *
 * `character_models` no tiene RLS (está en `NON_TENANT_TABLES`), así que estas
 * funciones andan dentro de cualquier transacción. La única que cruza marcas
 * es {@link characterModelDirectory.brandLinks} (lee `influencers` de varias
 * companies): igual que el directorio de marcas, **tiene que correr con
 * `withoutCompany`** y sin `SET LOCAL ROLE`. Con `fastgram_app` devolvería
 * cero filas; en el modo personal (conexión de desarrollo) funciona.
 *
 * Lo que pasa **dentro** de una marca (crear o reactivar su fila de
 * `influencers`) no está acá: va por `influencerRepository` en una
 * transacción con la marca puesta, para que RLS lo cubra.
 */
import { and, asc, eq, inArray, ne } from "drizzle-orm";

import type { Executor } from "../client.js";
import { characterModels, companies, influencers } from "../schema/index.js";
import type { OwnerScope } from "./workspace-directory.js";

export type CharacterModelRow = typeof characterModels.$inferSelect;
export type NewCharacterModel = Omit<
  typeof characterModels.$inferInsert,
  "id" | "ownerUserId" | "createdAt" | "updatedAt"
> & { readonly id?: string };
export type CharacterModelPatch = Partial<
  Omit<typeof characterModels.$inferInsert, "id" | "ownerUserId" | "createdAt">
>;

/** Una marca del dueño en la que el modelo tiene su fila de `influencers`. */
export interface CharacterModelBrandLink {
  readonly modelId: string;
  readonly companyId: string;
  readonly influencerId: string;
  readonly isActive: boolean;
}

export const characterModelDirectory = {
  /** Los modelos del dueño, del más viejo al más nuevo. */
  async list(exec: Executor, scope: OwnerScope): Promise<CharacterModelRow[]> {
    return exec
      .select()
      .from(characterModels)
      .where(eq(characterModels.ownerUserId, scope.ownerUserId))
      .orderBy(asc(characterModels.createdAt), asc(characterModels.id));
  },

  /** Un modelo del dueño, o `null` (no existe o es de otro). */
  async find(
    exec: Executor,
    scope: OwnerScope,
    id: string,
  ): Promise<CharacterModelRow | null> {
    const rows = await exec
      .select()
      .from(characterModels)
      .where(
        and(
          eq(characterModels.id, id),
          eq(characterModels.ownerUserId, scope.ownerUserId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  /**
   * Los modelos del dueño con esos ids (los que no son suyos no vuelven).
   * Para `JV-6`: la marca conoce los `model_id` de sus influencers y pide
   * sus notas.
   */
  async findMany(
    exec: Executor,
    scope: OwnerScope,
    ids: readonly string[],
  ): Promise<CharacterModelRow[]> {
    if (ids.length === 0) return [];
    return exec
      .select()
      .from(characterModels)
      .where(
        and(
          inArray(characterModels.id, [...ids]),
          eq(characterModels.ownerUserId, scope.ownerUserId),
        ),
      );
  },

  async create(
    exec: Executor,
    scope: OwnerScope,
    values: NewCharacterModel,
  ): Promise<CharacterModelRow> {
    const [row] = await exec
      .insert(characterModels)
      .values({ ...values, ownerUserId: scope.ownerUserId })
      .returning();
    if (row === undefined)
      throw new Error("El INSERT de character_models no devolvió fila.");
    return row;
  },

  /** `null` si no es del dueño. `updatedAt` se pone solo. */
  async update(
    exec: Executor,
    scope: OwnerScope,
    id: string,
    patch: CharacterModelPatch,
  ): Promise<CharacterModelRow | null> {
    const [row] = await exec
      .update(characterModels)
      .set({ ...patch, updatedAt: new Date() })
      .where(
        and(
          eq(characterModels.id, id),
          eq(characterModels.ownerUserId, scope.ownerUserId),
        ),
      )
      .returning();
    return row ?? null;
  },

  /** Borra el modelo. Las filas de `influencers` quedan con `model_id` nulo (FK). */
  async remove(exec: Executor, scope: OwnerScope, id: string): Promise<boolean> {
    const rows = await exec
      .delete(characterModels)
      .where(
        and(
          eq(characterModels.id, id),
          eq(characterModels.ownerUserId, scope.ownerUserId),
        ),
      )
      .returning({ id: characterModels.id });
    return rows.length > 0;
  },

  /**
   * En qué marcas vivas **del dueño** tiene fila cada modelo. Cruza companies:
   * correr con `withoutCompany` (ver cabecera). Activas e inactivas: la ruta
   * decide qué cuenta como «asignado».
   */
  async brandLinks(
    exec: Executor,
    scope: OwnerScope,
    modelIds: readonly string[],
  ): Promise<CharacterModelBrandLink[]> {
    if (modelIds.length === 0) return [];
    const rows = await exec
      .select({
        modelId: influencers.modelId,
        companyId: influencers.companyId,
        influencerId: influencers.id,
        isActive: influencers.isActive,
      })
      .from(influencers)
      .innerJoin(companies, eq(companies.id, influencers.companyId))
      .innerJoin(characterModels, eq(characterModels.id, influencers.modelId))
      .where(
        and(
          inArray(influencers.modelId, [...modelIds]),
          eq(companies.ownerUserId, scope.ownerUserId),
          eq(characterModels.ownerUserId, scope.ownerUserId),
          ne(companies.status, "soft_deleted"),
        ),
      )
      .orderBy(asc(companies.createdAt), asc(companies.id));
    return rows.flatMap((r) =>
      r.modelId === null
        ? []
        : [
            {
              modelId: r.modelId,
              companyId: r.companyId,
              influencerId: r.influencerId,
              isActive: r.isActive,
            },
          ],
    );
  },
};

/* ------------------------------------------------------------------------ *
 * El job de entrenamiento de un modelo desde fotos.
 *
 * Viaja por la cola `influencer-pipeline` (la misma que entrena los
 * influencers de una marca: mismo proveedor, mismos tiempos) y se despacha
 * por payload (trampa 63). La forma vive **acá**, en el paquete que usan la
 * API (encola) y el worker (consume), para que el literal no se escriba de
 * los dos lados (trampa 19).
 * ------------------------------------------------------------------------ */

export const CHARACTER_MODEL_TRAIN_OP = "model-train";

export interface CharacterModelTrainJob {
  readonly op: typeof CHARACTER_MODEL_TRAIN_OP;
  readonly modelId: string;
  readonly ownerUserId: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `null` si el payload no es un job de modelo (es de un influencer). */
export function parseCharacterModelTrainJob(
  payload: unknown,
): CharacterModelTrainJob | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (p["op"] !== CHARACTER_MODEL_TRAIN_OP) return null;
  const modelId = p["modelId"];
  const ownerUserId = p["ownerUserId"];
  if (typeof modelId !== "string" || !UUID_RE.test(modelId)) return null;
  if (typeof ownerUserId !== "string" || !UUID_RE.test(ownerUserId)) return null;
  return { op: CHARACTER_MODEL_TRAIN_OP, modelId, ownerUserId };
}

/** Un modelo se entrena una vez: el id es único, así que esto sólo deduplica reintentos del encolado. */
export function characterModelTrainSingletonKey(modelId: string): string {
  return `character-model:${modelId}`;
}
