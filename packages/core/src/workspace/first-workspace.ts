/**
 * El primer workspace de un usuario — `P1-TENANT-001`, `F-008`, PRD §15.4,
 * `DATA-002`, `DATA-003`, y la decisión del dueño del producto de PRD §2.4
 * (2026-09-23).
 *
 * ## Qué decide este módulo y qué no
 *
 * **Decide** con qué nace el workspace: plan, estado de suscripción, estado del
 * workspace, día ancla, la membresía del dueño y que pase a ser su workspace por
 * defecto. Y valida lo que el usuario escribe.
 *
 * **No decide** si el usuario ya tiene uno: eso es una lectura que cruza
 * workspaces y la resuelve el repositorio dentro de la misma transacción que
 * escribe, con el usuario bloqueado (trampa 37 de `docs/HANDOFF.md`: un `INSERT`
 * no se guarda solo). Lo que sí vive acá es **qué se responde** cuando ya lo
 * tiene: {@link workspaceAlreadyExists}.
 *
 * ## La decisión del dueño, y lo que implica
 *
 * *"Un workspace nace en el plan Free de §16.1 con `subscriptionStatus =
 * trialing` […] Crear el **primero** no consulta el límite de workspaces; los
 * adicionales siguen sin número para Free."* (PRD §2.4).
 *
 * Por eso esto **no llama** a `assertCanCreateWorkspace`. `PLANS.free.workspaces`
 * vale `1` y, con el conteo en `0`, la llamada pasaría igual — pero pasaría por
 * la razón equivocada: el `1` de Free no es un número del PRD (§16.1 no lo da
 * para Free) y el día que alguien lo cambie a `0` el alta entera se rompería.
 * Que el primero no consulte el límite es la regla; que hoy dé lo mismo es
 * casualidad.
 *
 * Los **adicionales** no existen todavía: quien ya tiene un workspace recibe
 * {@link workspaceAlreadyExists}, sin inventar el límite.
 *
 * ## Los campos que `DATA-002` exige y el onboarding no pide
 *
 * - `billingAnchorDay` es `NOT NULL` y el PRD no dice con qué valor nace. Se
 *   toma **el día del mes de la creación, en UTC** (1–31). Es lo que hace que el
 *   primer período dure un mes desde el alta y no "hasta el 1"; y es UTC porque
 *   `quota/reset.ts` calcula los resets en UTC (§16.2, *"00:00 UTC"*). Un día
 *   29–31 no es un problema: `nextBillingResetUtc` ya lo recorta al último día
 *   de los meses cortos. DECISIÓN de `P1-TENANT-001`, no del PRD.
 * - `status` nace en **`draft`**: `FR-010` *"crear `company` en estado draft"*.
 *   Pasa a `active` al cerrar el onboarding, que es lo que `GET /onboarding` lee
 *   como "terminado".
 * - `timezone` no la decide `core`: el repositorio copia la del dueño
 *   (`users.timezone`, `DATA-001`), que ya es obligatoria. Ver el repositorio.
 */
import { DomainError } from "../errors.js";
import { detectBrandSource } from "../brand/source-input.js";
import { MIN_COMPANY_NAME_CHARS, ONBOARDING_MESSAGES } from "../onboarding/onboarding.js";
import type { PlanId } from "../quota/plans.js";

/** PRD §2.4 — decisión del dueño del producto (2026-09-23). */
export const FIRST_WORKSPACE_PLAN_ID = "free" as const satisfies PlanId;
/** PRD §2.4 — decisión del dueño del producto (2026-09-23). */
export const FIRST_WORKSPACE_SUBSCRIPTION_STATUS = "trialing" as const;
/** `FR-010`: *"crear `company` en estado draft"*. */
export const FIRST_WORKSPACE_STATUS = "draft" as const;

/**
 * Copy de las validaciones de la web del alta. Literal de `FR-010` (PRD:765),
 * rama web, CONFIRMED.
 */
export const WEBSITE_MESSAGES = {
  invalid: "Please enter a valid website URL",
  alreadyRegistered: "This website is already registered.",
} as const;

/**
 * El 409 de "ya tenés workspace". **No es copy del PRD**: §15.4 no tiene un
 * mensaje para esto porque en Fastlane el segundo workspace pasa por
 * `Create another workspace` y su límite. Acá los adicionales no existen
 * todavía, así que se dice eso y nada más.
 */
export const WORKSPACE_ALREADY_EXISTS_MESSAGE =
  "You already have a workspace. Creating additional workspaces isn't available yet.";

export interface FirstWorkspaceInput {
  /** Verificado por el proveedor de identidad. Nunca del cuerpo del pedido. */
  readonly ownerUserId: string;
  /** `Company Name` de `FR-010`. */
  readonly name: string;
  /**
   * Opcional por `EXT-001` (`DATA-002`). `null`, `undefined` y la cadena vacía
   * significan lo mismo: el usuario no puso web.
   */
  readonly websiteUrl?: string | null | undefined;
}

/**
 * Todo lo que el repositorio escribe, ya decidido. Es un plan y no una
 * escritura por la misma razón que `planOnboardingCompletion`: el dominio dice
 * **qué**, el borde lo hace dentro de su transacción.
 */
export interface FirstWorkspacePlan {
  readonly ownerUserId: string;
  readonly name: string;
  /** Forma canónica (sin tracking, sin `www.`), o `null`. */
  readonly websiteUrl: string | null;
  readonly planId: typeof FIRST_WORKSPACE_PLAN_ID;
  readonly subscriptionStatus: typeof FIRST_WORKSPACE_SUBSCRIPTION_STATUS;
  readonly status: typeof FIRST_WORKSPACE_STATUS;
  /** 1–31, el día UTC de `now`. Ver la cabecera. */
  readonly billingAnchorDay: number;
  /** `DATA-003`: el creador queda como `owner` (`FR-010` Permissions). */
  readonly ownerMembership: { readonly role: "owner"; readonly status: "active" };
  /**
   * `users.default_workspace_id` pasa a apuntar al nuevo. Es lo que
   * `app.resolve_session_workspace` (`0012`) elige primero, así que después
   * de crear, `GET /auth/session` devuelve este `companyId`.
   */
  readonly setAsDefaultWorkspace: true;
}

/**
 * Valida y normaliza la web. `null` si no hay.
 *
 * Usa el mismo detector que `POST /brand/sources` con la pista `website` —el
 * campo legacy `Company Website` de `FR-010` es de web por definición—, así que
 * las reglas SSRF y la forma canónica son **las mismas** en los dos caminos. La
 * unicidad global de `DATA-002` compara la forma canónica: sin normalizar,
 * `https://www.x.com/?utm_source=a` y `x.com` serían dos webs distintas.
 *
 * Un perfil social (`instagram.com/marca`) o un `@handle` **no** son una web: se
 * rechazan con el copy de web inválida. Su camino es `POST /brand/sources`.
 */
export function normalizeWorkspaceWebsite(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || raw.trim().length === 0) return null;

  // `detectBrandSource` lanza los `DomainError` SSRF con su copy literal
  // (`Localhost URLs are not allowed`, …). El mensaje se conserva; sólo se le
  // agrega `field`, que es lo que deja a la UI marcar el input correcto.
  let detected: ReturnType<typeof detectBrandSource>;
  try {
    detected = detectBrandSource(raw, { hint: "website" });
  } catch (error) {
    if (error instanceof DomainError && error.code === "out_of_range") {
      throw new DomainError("out_of_range", error.message, {
        ...error.details,
        field: "websiteUrl",
      });
    }
    throw error;
  }
  if (detected.kind !== "resolved" || detected.sourceType !== "website") {
    throw new DomainError("out_of_range", WEBSITE_MESSAGES.invalid, {
      field: "websiteUrl",
    });
  }
  return detected.canonicalUrl;
}

/**
 * El plan del primer workspace.
 *
 * El nombre se valida con el copy de `FR-010` y se guarda **recortado**: la
 * regla de los 2 caracteres ya mide el valor recortado (`assertValidCompanyDetails`),
 * así que guardar los espacios dejaría en la base un nombre que la regla nunca vio.
 */
export function planFirstWorkspace(
  input: FirstWorkspaceInput,
  now: Date,
): FirstWorkspacePlan {
  const name = input.name.trim();
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

  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) {
    throw new Error("planFirstWorkspace: `now` no es una fecha válida.");
  }

  return {
    ownerUserId: input.ownerUserId,
    name,
    websiteUrl: normalizeWorkspaceWebsite(input.websiteUrl),
    planId: FIRST_WORKSPACE_PLAN_ID,
    subscriptionStatus: FIRST_WORKSPACE_SUBSCRIPTION_STATUS,
    status: FIRST_WORKSPACE_STATUS,
    billingAnchorDay: now.getUTCDate(),
    ownerMembership: { role: "owner", status: "active" },
    setAsDefaultWorkspace: true,
  };
}

/**
 * El rechazo cuando el usuario ya es miembro activo de un workspace vivo.
 *
 * `conflict` (409). El `companyId` que ya tiene va a `details` para el log y
 * **no** sale al cliente (`DomainError.details` nunca se serializa): el cliente
 * lo obtiene de `GET /auth/session`, que es su fuente.
 */
export function workspaceAlreadyExists(existingCompanyId: string): DomainError {
  return new DomainError("conflict", WORKSPACE_ALREADY_EXISTS_MESSAGE, {
    reason: "workspace_already_exists",
    existingCompanyId,
  });
}

/** El 409 de `DATA-002`: la web es única global. Copy literal de `FR-010`. */
export function websiteAlreadyRegistered(): DomainError {
  return new DomainError("conflict", WEBSITE_MESSAGES.alreadyRegistered, {
    reason: "website_already_registered",
    field: "websiteUrl",
  });
}
