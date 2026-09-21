/**
 * Crear un content angle — PRD `FR-056`, `FR-055` (auto-reconcile), §9.4, `AI-005`.
 *
 * Este caso de uso existe por una razón muy concreta: `assertCanCreateAngle`
 * ya estaba escrito y probado en `angles/`, y **nadie lo llamaba**. El cap de
 * 100 era una constante con un test que verificaba que la constante valía 100.
 * La base aceptaba el ángulo 101.
 *
 * Lo que hay que hacer junto, y que el PRD exige que sea **una transacción**:
 *
 *   contar (sin borrados) → validar campos → validar enlaces de influencer
 *     → crear el ángulo activo → reescribir `angleWeights`
 *
 * §9.4 lo pide literal: «Transacciones que abarquen mutación + reconcile
 * (crear ángulo **y** reescribir `angleWeights` en la misma transacción)».
 *
 * Qué pasa si se separan: entre las dos escrituras hay un instante en que el
 * ángulo existe y los pesos no lo cubren. Si el proceso muere ahí, el mapa
 * queda sumando 100 sobre N-1 ángulos y el nuevo **nunca sale**. No hay error,
 * no hay alerta: el usuario ve un ángulo que creó y que no aparece jamás, y no
 * hay forma de deducirlo mirando la pieza generada.
 */
import { DomainError } from "../errors.js";
import type { IdGenerator } from "../ids.js";
import {
  ANGLE_FIELD_LIMITS,
  assertCanCreateAngle,
  assertCanLinkInfluencer,
  assertValidInfluencerLinks,
  reconcileAngleWeights,
  type AngleWeights,
  type ContentAngle,
  type InfluencerRef,
} from "../angles/angles.js";

/** Handle de transacción. Igual que en `@fastgram/ports`: opaco a propósito. */
export type Transaction = unknown;

export interface CreateContentAngleInput {
  readonly companyId: string;
  readonly actorId: string;
  readonly transaction: Transaction;
  readonly title: string;
  readonly description: string;
  readonly targetAudience: string;
  readonly influencerIds?: readonly string[] | undefined;
  /**
   * `AI-005`: al persistir un ángulo generado hay que reenviar la
   * `brandRevision` con la que se generó. Si la marca cambió en el medio, el
   * ángulo describe una marca que ya no existe y se rechaza.
   */
  readonly expectedBrandRevision?: number | undefined;
}

export interface ContentAngleRepository {
  /**
   * Ángulos **no borrados** del workspace.
   *
   * El nombre dice "active" en el sentido de "no borrado", no de `isActive`:
   * el PRD dice «borrar libera slot» y el borrado es soft-delete. Contar los
   * borrados deja el workspace trabado en 100 para siempre.
   */
  countLiveAngles(companyId: string, transaction: Transaction): Promise<number>;

  /** Ids de los ángulos con `isActive: true`. Entrada del reconcile. */
  listActiveAngleIds(
    companyId: string,
    transaction: Transaction,
  ): Promise<readonly string[]>;

  /** Cuántos ángulos vivos tiene ya enlazados cada influencer. */
  countAnglesPerInfluencer(
    companyId: string,
    influencerIds: readonly string[],
    transaction: Transaction,
  ): Promise<Readonly<Record<string, number>>>;

  listWorkspaceInfluencers(
    companyId: string,
    transaction: Transaction,
  ): Promise<readonly InfluencerRef[]>;

  currentBrandRevision(companyId: string, transaction: Transaction): Promise<number>;

  insertAngle(
    companyId: string,
    angle: ContentAngle,
    transaction: Transaction,
  ): Promise<void>;

  /** Se llama **siempre** tras insertar, en la misma transacción. */
  writeAngleWeights(
    companyId: string,
    weights: AngleWeights,
    transaction: Transaction,
  ): Promise<void>;
}

export interface CreateContentAngleResult {
  readonly angle: ContentAngle;
  readonly weights: AngleWeights;
}

/** `FR-056`: los tres campos de texto son obligatorios y tienen tope. */
export function assertValidAngleFields(fields: {
  readonly title: string;
  readonly description: string;
  readonly targetAudience: string;
}): void {
  for (const [field, max] of Object.entries(ANGLE_FIELD_LIMITS)) {
    const value = fields[field as keyof typeof ANGLE_FIELD_LIMITS];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new DomainError("out_of_range", `${field} is required.`, { field });
    }
    if (value.length > max) {
      throw new DomainError(
        "out_of_range",
        `${field} must be ${max} characters or fewer.`,
        { field, length: value.length, max },
      );
    }
  }
}

export async function createContentAngle(
  deps: { readonly ids: IdGenerator; readonly repository: ContentAngleRepository },
  input: CreateContentAngleInput,
): Promise<CreateContentAngleResult> {
  const { repository, ids } = deps;
  const tx = input.transaction;
  const influencerIds = input.influencerIds ?? [];

  // 1. El cap de 100. Esto es lo que faltaba.
  const liveCount = await repository.countLiveAngles(input.companyId, tx);
  assertCanCreateAngle(liveCount);

  // 2. Campos.
  assertValidAngleFields(input);

  // 3. Guardarraíl de consistencia de marca (`AI-005`). Va antes de escribir
  //    nada: rechazar después de insertar obligaría a compensar.
  if (input.expectedBrandRevision !== undefined) {
    const current = await repository.currentBrandRevision(input.companyId, tx);
    if (current !== input.expectedBrandRevision) {
      throw new DomainError(
        "conflict",
        "Your brand profile changed while this angle was being written. Generate it again.",
        { expected: input.expectedBrandRevision, actual: current },
      );
    }
  }

  // 4. Enlaces de influencer: únicos, del workspace, activos y entrenados.
  //    `assertValidInfluencerLinks` trata al influencer ajeno como inexistente
  //    (§9.2): no confirmamos que el id existe en otra cuenta.
  if (influencerIds.length > 0) {
    const influencers = await repository.listWorkspaceInfluencers(input.companyId, tx);
    assertValidInfluencerLinks(influencerIds, influencers);

    const perInfluencer = await repository.countAnglesPerInfluencer(
      input.companyId,
      influencerIds,
      tx,
    );
    for (const id of influencerIds) {
      assertCanLinkInfluencer(id, perInfluencer[id] ?? 0);
    }
  }

  // 5. El ángulo nace **activo** — `FR-056`, criterio 1: «Crear un ángulo lo
  //    activa inmediatamente y reparte pesos».
  const angle: ContentAngle = {
    id: ids.newId("ang"),
    title: input.title,
    description: input.description,
    targetAudience: input.targetAudience,
    isActive: true,
    influencerIds,
  };

  await repository.insertAngle(input.companyId, angle, tx);

  // 6. Reconcile, en la MISMA transacción. Ver la cabecera.
  const activeIds = await repository.listActiveAngleIds(input.companyId, tx);
  const weights = reconcileAngleWeights(
    activeIds.includes(angle.id) ? activeIds : [...activeIds, angle.id],
  );
  await repository.writeAngleWeights(input.companyId, weights, tx);

  return { angle, weights };
}
