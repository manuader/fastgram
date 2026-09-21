/**
 * Content angles y reconcile de pesos — PRD `FR-056`, `FR-055` y §9.4.
 *
 * Los ángulos son los encuadres narrativos con los que la IA escribe. Lo que
 * hace este módulo delicado no son los ángulos: es `angleWeights`, el mapa que
 * decide con qué frecuencia sale cada uno.
 *
 * El PRD exige que ese mapa **cubra todos los ángulos activos y sume
 * exactamente 100**, y que se reescriba en la MISMA transacción que la
 * mutación del ángulo (§9.4). Un mapa que suma 99 o que referencia un ángulo
 * borrado no rompe nada visiblemente: sesga la generación de contenido de
 * forma silenciosa, y el usuario ve que "sale mucho un ángulo" sin poder
 * explicarlo.
 */
import { DomainError } from "../errors.js";
import { HARD_CAPS, type Caps } from "../quota/plans.js";

/**
 * Códigos de error literales del PRD.
 *
 * Están en MAYÚSCULAS mientras el resto del PRD usa snake_case
 * (`content_quota_exceeded`). Se conservan tal cual porque son el literal
 * observado en la API original; unificarlos sería inventar. Queda anotado:
 * si el clon decide normalizar, es una decisión de producto, no un arreglo.
 */
export const ANGLE_ERROR_CODES = {
  maxAngles: "MAX_ANGLES_EXCEEDED",
  maxPerInfluencer: "MAX_ANGLES_PER_INFLUENCER_EXCEEDED",
} as const;

/** Límites de campo del PRD `FR-056`. */
export const ANGLE_FIELD_LIMITS = {
  title: 200,
  description: 2000,
  targetAudience: 500,
} as const;

export interface ContentAngle {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly targetAudience: string;
  readonly isActive: boolean;
  /** Influencers a los que se restringe. Vacío = aplica a todos. */
  readonly influencerIds: readonly string[];
}

export type AngleWeights = Readonly<Record<string, number>>;

// ───────────────────────────────────────────────────────────────────────────
// Reconcile
// ───────────────────────────────────────────────────────────────────────────

/**
 * Reparto par que suma **exactamente** 100.
 *
 * El PRD da el ejemplo que delata la implementación ingenua: 3 ángulos →
 * `34/33/33`, no `33/33/33`. Repartir el resto entre los primeros es lo que
 * cierra la suma. Con 7 ángulos: 100/7 = 14 resto 2 → `15,15,14,14,14,14,14`.
 *
 * Se aplica al CREAR un ángulo activo, al cambiar `isActive` y al borrar.
 * **No** se aplica al renombrar ni al editar la descripción: eso no cambia
 * cuántos ángulos compiten, y disparar reconcile ahí pisaría en silencio los
 * pesos personalizados que el usuario puso a mano.
 */
export function reconcileAngleWeights(activeAngleIds: readonly string[]): AngleWeights {
  // Sin ángulos activos el mapa se limpia. No queda `{}` con un peso huérfano
  // apuntando a un ángulo que ya no compite.
  if (activeAngleIds.length === 0) return {};

  const n = activeAngleIds.length;
  const base = Math.floor(100 / n);
  const remainder = 100 - base * n;

  const weights: Record<string, number> = {};
  activeAngleIds.forEach((id, i) => {
    weights[id] = base + (i < remainder ? 1 : 0);
  });
  return weights;
}

/**
 * Valida un mapa de pesos que llegó del usuario (PATCH explícito).
 *
 * El PRD exige `400` si no cubre todos los activos, si referencia inactivos o
 * ajenos, o si no suma 100.
 */
export function assertValidAngleWeights(
  weights: AngleWeights,
  activeAngleIds: readonly string[],
): void {
  const active = new Set(activeAngleIds);
  const given = Object.keys(weights);

  for (const id of given) {
    if (!active.has(id)) {
      throw new DomainError(
        "out_of_range",
        "angleWeights references an angle that is not active in this workspace.",
        { angleId: id },
      );
    }
  }

  for (const id of activeAngleIds) {
    if (!(id in weights)) {
      throw new DomainError(
        "out_of_range",
        "angleWeights must cover every active angle.",
        { missing: id },
      );
    }
  }

  const sum = Object.values(weights).reduce((a, b) => a + b, 0);
  if (sum !== 100) {
    throw new DomainError(
      "out_of_range",
      `angleWeights must add up to 100, got ${sum}.`,
      {
        sum,
      },
    );
  }

  for (const [id, w] of Object.entries(weights)) {
    if (!Number.isInteger(w) || w < 0) {
      throw new DomainError(
        "out_of_range",
        "Each angle weight must be a whole number ≥ 0.",
        {
          angleId: id,
          weight: w,
        },
      );
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Caps e invariantes
// ───────────────────────────────────────────────────────────────────────────

/** Los caps de ángulos que aplican. Default `HARD_CAPS` — `EXT-005`. */
export type AngleCaps = Readonly<Pick<Caps, "contentAngles" | "anglesPerInfluencer">>;

export function assertCanCreateAngle(
  currentAngleCount: number,
  caps: AngleCaps = HARD_CAPS,
): void {
  // "borrar libera slot" — y borrar es soft-delete, así que quien llame acá
  // tiene que contar sólo los no borrados. Es el error fácil de este cap.
  if (currentAngleCount >= caps.contentAngles) {
    throw new DomainError(
      "out_of_range",
      `You can have up to ${caps.contentAngles} content angles.`,
      { code: ANGLE_ERROR_CODES.maxAngles },
    );
  }
}

export function assertCanLinkInfluencer(
  influencerId: string,
  anglesAlreadyLinked: number,
  caps: AngleCaps = HARD_CAPS,
): void {
  if (anglesAlreadyLinked >= caps.anglesPerInfluencer) {
    throw new DomainError(
      "out_of_range",
      `An influencer can have up to ${caps.anglesPerInfluencer} content angles.`,
      { code: ANGLE_ERROR_CODES.maxPerInfluencer, influencerId },
    );
  }
}

export interface InfluencerRef {
  readonly id: string;
  readonly isActive: boolean;
  readonly isTrained: boolean;
}

/**
 * Valida los `influencerIds` de un ángulo.
 *
 * El PRD: únicos, del workspace, **activos y entrenados**. Un influencer sin
 * entrenar no puede producir una pieza, así que enlazarlo crearía un ángulo
 * que nunca se puede usar — y el usuario lo descubriría recién al ver que ese
 * ángulo no sale nunca.
 */
export function assertValidInfluencerLinks(
  influencerIds: readonly string[],
  workspaceInfluencers: readonly InfluencerRef[],
): void {
  const seen = new Set<string>();
  for (const id of influencerIds) {
    if (seen.has(id)) {
      throw new DomainError("out_of_range", "influencerIds must be unique.", { id });
    }
    seen.add(id);
  }

  const byId = new Map(workspaceInfluencers.map((i) => [i.id, i]));
  for (const id of influencerIds) {
    const inf = byId.get(id);
    // Un influencer de otro workspace es indistinguible de uno inexistente:
    // no confirmamos que el id existe en otra cuenta (§9.2).
    if (inf === undefined) {
      throw new DomainError("not_found", "Influencer not found.", { id });
    }
    if (!inf.isActive || !inf.isTrained) {
      throw new DomainError(
        "invalid_state",
        "Content angles can only be linked to active, trained influencers.",
        { id, isActive: inf.isActive, isTrained: inf.isTrained },
      );
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Transiciones
// ───────────────────────────────────────────────────────────────────────────

export interface AngleMutationResult {
  readonly angle: ContentAngle;
  readonly weights: AngleWeights;
  /** Si el llamador tiene que reescribir los pesos en la misma transacción. */
  readonly weightsChanged: boolean;
}

/**
 * Desactiva un ángulo.
 *
 * **Borra todos sus enlaces de influencer, y reactivarlo NO los restaura.**
 * Es una regla explícita del PRD y contraintuitiva: parece que desactivar
 * debería ser reversible del todo. No lo es, y conviene que la UI lo avise
 * antes de desactivar, no después.
 */
export function deactivateAngle(
  angle: ContentAngle,
  otherActiveAngleIds: readonly string[],
): AngleMutationResult {
  return {
    angle: { ...angle, isActive: false, influencerIds: [] },
    weights: reconcileAngleWeights(otherActiveAngleIds),
    weightsChanged: true,
  };
}

/** Reactiva un ángulo. Los enlaces de influencer NO vuelven. */
export function activateAngle(
  angle: ContentAngle,
  otherActiveAngleIds: readonly string[],
): AngleMutationResult {
  return {
    angle: { ...angle, isActive: true, influencerIds: [] },
    weights: reconcileAngleWeights([...otherActiveAngleIds, angle.id]),
    weightsChanged: true,
  };
}

/**
 * Edita título, descripción o audiencia.
 *
 * **No dispara reconcile**, y por eso devuelve `weightsChanged: false`: no
 * cambia cuántos ángulos compiten. Si disparara, cada corrección de una falta
 * de ortografía borraría los pesos personalizados del usuario.
 */
export function editAngleText(
  angle: ContentAngle,
  changes: Partial<Pick<ContentAngle, "title" | "description" | "targetAudience">>,
  currentWeights: AngleWeights,
): AngleMutationResult {
  for (const [field, max] of Object.entries(ANGLE_FIELD_LIMITS)) {
    const value = changes[field as keyof typeof ANGLE_FIELD_LIMITS];
    if (value !== undefined && value.length > max) {
      throw new DomainError(
        "out_of_range",
        `${field} must be ${max} characters or fewer.`,
        {
          field,
          length: value.length,
          max,
        },
      );
    }
  }

  return {
    angle: { ...angle, ...changes },
    weights: currentWeights,
    weightsChanged: false,
  };
}

/** Asignar influencers a un ángulo inactivo es `400` (PRD `FR-056`). */
export function assertAngleIsActiveForLinking(angle: ContentAngle): void {
  if (!angle.isActive) {
    throw new DomainError(
      "invalid_state",
      "Activate this angle before assigning influencers to it.",
      { angleId: angle.id },
    );
  }
}
