/**
 * Onboarding — PRD `FR-010`, `FLOW-001`, `FLOW-009`, `DATA-030`.
 *
 * El wizard tiene cinco pasos y una propiedad que el PRD convierte en criterio
 * de aceptación (`FR-010`, criterio 7):
 *
 *   "El resto del wizard (detalles, cuestionario, preparación) se comporta
 *    **igual** con origen `website` y con origen social; **sólo cambia el
 *    extractor**."
 *
 * Es la forma de que `EXT-001` sea una extensión y no una bifurcación. Un
 * onboarding con dos caminos paralelos —uno de web y otro social— duplica cada
 * validación, cada estado de progreso y cada mensaje de error, y a la tercera
 * corrección los dos dejan de comportarse igual. Por eso acá el `sourceType`
 * **no aparece** después del primer paso: si apareciera, sería la puerta.
 *
 * Y el criterio 11, que es el que define la decisión `D-01`:
 *
 *   "Completar el alta con una fuente social **no requiere autorizar OAuth en
 *    ningún momento**."
 *
 * `oauthConsents` existe para poder afirmarlo en un test en vez de confiar en
 * que nadie agregó un `Connect` obligatorio.
 */
import { DomainError } from "../errors.js";
import { PLANS, type PlanId } from "../quota/plans.js";
import type { CoreBrandSourceType } from "../brand/source-input.js";

export const ONBOARDING_STEPS = [
  /** `Where can we learn about your brand?` */
  "brand_source",
  /** `Company Name`, `Company Description`, `Company Logo`. */
  "company_details",
  /** `Select your role`, tamaño de equipo, modelo, categorías, ingresos. */
  "profiling",
  /** `Analyzing company profile...` → `Workspace ready!` */
  "processing",
  /** `Continue to Dashboard`. */
  "ready",
] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

/** Copy literal de `FR-010` y `ERR-B01`. No se parafrasea: es lo que se muestra. */
export const ONBOARDING_MESSAGES = {
  noSource: "Add a website or a social profile to continue",
  companyNameRequired: "Company name is required",
  companyNameTooShort: "Company name must be at least 2 characters",
  answerTooLong: "Each answer is limited to 4,000 characters.",
  incompleteDetails: "Add your company details before finishing setup.",
  workspaceLimit:
    "You've reached your workspace creation limit. Please try again later.",
  analysisFailed: "Your company profile needs support before setup can finish.",
} as const;

/** `FR-010`: «Each answer is limited to 4,000 characters.» */
export const MAX_ANSWER_CHARS = 4_000;
export const MIN_COMPANY_NAME_CHARS = 2;

export interface OnboardingSourceDraft {
  readonly sourceType: CoreBrandSourceType;
  readonly handle: string;
  readonly canonicalUrl: string;
}

export interface CompanyDetails {
  readonly name: string;
  readonly description: string;
  readonly logoUrl?: string | undefined;
}

/**
 * Respuestas del cuestionario. Se modela como un mapa y no como campos sueltos
 * porque `FR-010` las lista como obligatorias pero no fija sus valores: fijar
 * un enum acá sería inventar el catálogo de roles y de modelos de negocio.
 */
export type ProfilingAnswers = Readonly<Record<string, string | readonly string[]>>;

/** Las claves que `FR-010` marca como obligatorias, con su copy de error. */
export const REQUIRED_PROFILING_ANSWERS: Readonly<Record<string, string>> = {
  role: "Please select your role",
  teamSize: "Please select your team size",
  businessModel: "Please select your business model",
  businessCategories: "Please select at least one business category",
  monthlyRevenue: "Please select your monthly revenue",
} as const;

export interface OnboardingRecord {
  readonly id: string;
  readonly ownerUserId: string;
  readonly draftCompanyId: string;
  readonly step: OnboardingStep;
  readonly sources: readonly OnboardingSourceDraft[];
  /** `true` si el usuario eligió `Use description instead`. */
  readonly manualBranch: boolean;
  readonly details?: CompanyDetails | undefined;
  readonly profiling?: ProfilingAnswers | undefined;
  /**
   * Cuántas veces se le pidió al usuario un consentimiento OAuth durante el
   * alta. `D-01` exige que sea **0** en el camino social. Ver la cabecera.
   */
  readonly oauthConsents: number;
  readonly createdAt: Date;
}

// ───────────────────────────────────────────────────────────────────────────
// Paso 1 — Brand source
// ───────────────────────────────────────────────────────────────────────────

/**
 * `FR-010`: el paso está completo con **una fuente** o con la rama manual.
 *
 * La rama manual (`Use description instead`) se conserva de Fastlane y
 * **produce una `BrandSource` de tipo `manual`**, no un caso especial sin
 * fuente. Modelarla como "sin fuente" obligaría a que todo lo de abajo
 * —fusión, precedencia, badges de origen— tuviera una rama para el vacío.
 */
export function assertBrandSourceStepComplete(record: OnboardingRecord): void {
  if (record.sources.length === 0 && !record.manualBranch) {
    throw new DomainError("out_of_range", ONBOARDING_MESSAGES.noSource, {
      code: "ERR-B01",
    });
  }
}

/** La rama manual, como una fuente más. */
export function manualSourceDraft(): OnboardingSourceDraft {
  return { sourceType: "manual", handle: "", canonicalUrl: "" };
}

// ───────────────────────────────────────────────────────────────────────────
// Paso 2 — Company details
// ───────────────────────────────────────────────────────────────────────────

export function assertValidCompanyDetails(details: CompanyDetails): void {
  const name = details.name.trim();
  if (name.length === 0) {
    throw new DomainError("out_of_range", ONBOARDING_MESSAGES.companyNameRequired, {
      field: "name",
    });
  }
  if (name.length < MIN_COMPANY_NAME_CHARS) {
    throw new DomainError("out_of_range", ONBOARDING_MESSAGES.companyNameTooShort, {
      field: "name",
      length: name.length,
    });
  }
  if (details.description.length > MAX_ANSWER_CHARS) {
    throw new DomainError("out_of_range", ONBOARDING_MESSAGES.answerTooLong, {
      field: "description",
      length: details.description.length,
    });
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Paso 3 — Profiling
// ───────────────────────────────────────────────────────────────────────────

export function assertValidProfiling(answers: ProfilingAnswers): void {
  for (const [key, message] of Object.entries(REQUIRED_PROFILING_ANSWERS)) {
    const value = answers[key];
    const missing =
      value === undefined ||
      (typeof value === "string" && value.trim().length === 0) ||
      (Array.isArray(value) && value.length === 0);
    if (missing) {
      throw new DomainError("out_of_range", message, { field: key });
    }
  }

  for (const [key, value] of Object.entries(answers)) {
    const texts = typeof value === "string" ? [value] : value;
    for (const text of texts) {
      if (text.length > MAX_ANSWER_CHARS) {
        throw new DomainError("out_of_range", ONBOARDING_MESSAGES.answerTooLong, {
          field: key,
          length: text.length,
        });
      }
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Avance y reanudación
// ───────────────────────────────────────────────────────────────────────────

/**
 * Siguiente paso.
 *
 * **No recibe el `sourceType`.** Es el criterio 7 de `FR-010` hecho firma: si
 * el avance dependiera del origen, el wizard tendría dos caminos y a la
 * tercera corrección dejarían de comportarse igual.
 */
export function advanceOnboarding(record: OnboardingRecord): OnboardingRecord {
  switch (record.step) {
    case "brand_source":
      assertBrandSourceStepComplete(record);
      return { ...record, step: "company_details" };
    case "company_details":
      if (record.details === undefined) {
        throw new DomainError("out_of_range", ONBOARDING_MESSAGES.incompleteDetails, {
          step: record.step,
        });
      }
      assertValidCompanyDetails(record.details);
      return { ...record, step: "profiling" };
    case "profiling":
      if (record.profiling === undefined) {
        throw new DomainError("out_of_range", ONBOARDING_MESSAGES.incompleteDetails, {
          step: record.step,
        });
      }
      assertValidProfiling(record.profiling);
      return { ...record, step: "processing" };
    case "processing":
      return { ...record, step: "ready" };
    case "ready":
      throw new DomainError("invalid_state", "This onboarding is already finished.", {
        onboardingId: record.id,
      });
  }
}

/**
 * Dónde retomar tras recargar la página (`FR-010`, criterio 3).
 *
 * Devuelve el paso guardado, **no** el primero. Es literal del PRD («al
 * volver, reanudar desde el paso guardado») y es lo que hace que los mensajes
 * `Failed to save progress:` / `Failed to retrieve onboarding data:` tengan
 * sentido: hay estado intermedio que persiste.
 */
export function resumeOnboarding(record: OnboardingRecord): OnboardingStep {
  return record.step;
}

/**
 * Cuota de workspaces del plan (§16.1).
 *
 * El mensaje es el literal de `FR-010` y dice *"Please try again later"*
 * aunque el límite no se levanta solo. Se conserva porque es copy observado:
 * cambiarlo sería mejorar el producto original, no clonarlo. Queda anotado.
 */
export function assertCanCreateWorkspace(plan: PlanId, currentCount: number): void {
  const limit = PLANS[plan].workspaces;
  if (currentCount >= limit) {
    throw new DomainError("out_of_range", ONBOARDING_MESSAGES.workspaceLimit, {
      plan,
      limit,
      currentCount,
    });
  }
}

/**
 * Lo que hay que disparar al cerrar el alta (`FR-010`, **System behavior**):
 * crear el workspace real, sembrar los content angles iniciales, arrancar el
 * relleno de la discovery queue y marcar el onboarding como completo.
 *
 * Se devuelve como plan y no se ejecuta acá porque tres de las cuatro cosas
 * son escrituras y encolados: el dominio dice **qué**, el borde lo hace dentro
 * de su transacción.
 */
export interface OnboardingCompletionPlan {
  readonly createWorkspace: true;
  readonly seedContentAngles: boolean;
  readonly startDiscoveryRefill: true;
  readonly markComplete: true;
}

export function planOnboardingCompletion(
  record: OnboardingRecord,
  existingAngleCount: number,
): OnboardingCompletionPlan {
  if (record.step !== "processing" && record.step !== "ready") {
    throw new DomainError("invalid_state", "Finish the wizard before completing it.", {
      step: record.step,
    });
  }
  return {
    createWorkspace: true,
    // `FR-011.7` #7: se siembran ángulos **sólo en el primer análisis del
    // workspace**, para no duplicar los que ya existan.
    seedContentAngles: existingAngleCount === 0,
    startDiscoveryRefill: true,
    markComplete: true,
  };
}

/**
 * `D-01` / `FLOW-009`, criterio 11: el alta social se completa **sin un solo
 * consentimiento OAuth**.
 *
 * Existe como aserción del dominio y no sólo como test end-to-end porque el
 * camino se rompe por añadido: alguien mete un `Connect your account` como
 * paso obligatorio y todo sigue verde salvo esta comprobación.
 */
export function assertNoOAuthRequired(record: OnboardingRecord): void {
  if (record.oauthConsents > 0) {
    throw new DomainError(
      "invalid_state",
      "Signing up must not require connecting an account.",
      { onboardingId: record.id, oauthConsents: record.oauthConsents },
    );
  }
}
