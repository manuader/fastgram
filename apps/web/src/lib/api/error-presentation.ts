/**
 * De un `code` del contrato a **qué puede hacer el usuario** · PRD §19.
 *
 * `errors.ts` ya traduce el código a un título. Eso alcanza para un banner y no
 * alcanza para una pantalla: el PRD le da a cada familia de error una salida
 * distinta, y ofrecer la salida equivocada es casi peor que no ofrecer ninguna.
 *
 * El caso que obliga a que este módulo exista es el **402**. `Monthly content
 * quota reached for your plan` (ERR-R03, PRD:3213) con un botón `Try again` es
 * una mentira con forma de botón: reintentar no devuelve cuota, y el usuario
 * aprende que el botón no sirve. Lo que corresponde ahí es `Upgrade`, y el
 * `resetAt` que el servidor se molesta en publicar (§16.2) para decir **cuándo**
 * vuelve. Un 500, en cambio, sí se reintenta.
 *
 * El `Record` es **exhaustivo** por la misma razón que el de `errors.ts`: un
 * código nuevo en `packages/contracts` rompe la compilación y obliga a alguien
 * a decidir qué salida tiene. Con un `default` heredaría "reintentá" en
 * silencio, que es el bug que este archivo evita.
 */
import type { CopyKey, MessageVars } from "../i18n/t";
import { copyKeyForError, isApiRequestError, type FailureCode } from "./errors";
import { ROUTES } from "../nav/routes";

/**
 * La salida que se le ofrece al usuario.
 *
 * · `retry`  — el fallo es transitorio: volver a pedir puede funcionar.
 * · `reload` — el estado del servidor se movió: lo que hay en pantalla es viejo.
 * · `upgrade`— es un límite del plan: reintentar no cambia nada (§19.8).
 * · `profile`— falta completar el perfil de empresa (ERR-P08).
 * · `none`   — no hay nada que el usuario pueda hacer desde acá.
 */
export type Remedy = "retry" | "reload" | "upgrade" | "profile" | "none";

const REMEDIES: Readonly<Record<FailureCode, Remedy>> = {
  // Transversales
  bad_request: "none",
  unauthorized: "none", // ERR-U01: no se arregla reintentando
  forbidden: "none",
  not_found: "none",
  conflict: "reload",
  gone: "none",
  payment_required: "upgrade", // ERR-R08 · PRD:1519
  rate_limited: "retry", // ERR-R01: transitorio por definición
  service_unavailable: "retry", // ERR-R06

  // Cuotas · §19.8 — el motivo de que este archivo exista
  blitz_quota_exceeded: "upgrade", // ERR-R02
  content_quota_exceeded: "upgrade", // ERR-R03

  // Ciclo de vida del contenido · §19.6
  content_still_building: "reload",
  content_edit_in_progress: "reload",
  stale_revision: "reload", // ERR-P04: literalmente "recargá"
  content_not_editable: "none",
  content_has_linked_posts: "none", // hay que borrar los posts primero
  content_unavailable_for_type: "none",
  company_profile_not_ready: "profile", // ERR-P08
  unsupported_content_state: "none",
  media_in_use: "none",

  // Programación y publicación · FR-060: todos piden cambiar la elección
  connection_ambiguous: "none",
  posting_mode_not_supported_for_platform: "none",
  privacy_level_required: "none",
  invalid_privacy_level: "none",
  privacy_level_not_allowed_without_direct_mode: "none",
  tiktok_creator_info_unavailable: "retry", // ERR-D09 dice "or retry", literal
  tiktok_post_limit_exceeded: "none", // ERR-R05: es un límite de la plataforma
  youtube_post_limit_exceeded: "none",
  instagram_post_limit_exceeded: "none",

  // Ángulos · FR-056: son caps, no fallos
  MAX_ANGLES_EXCEEDED: "none",
  MAX_ANGLES_PER_INFLUENCER_EXCEEDED: "none",

  // Transporte
  network_error: "retry",
  invalid_response: "retry",
  timeout: "retry",
};

/** A dónde lleva la acción, cuando la acción es ir a otro lado. */
export const REMEDY_HREF: Readonly<Partial<Record<Remedy, string>>> = {
  upgrade: ROUTES.upgrade,
  profile: ROUTES.brand,
};

/** El copy del botón de cada salida. */
export const REMEDY_LABEL_KEY: Readonly<Record<Remedy, CopyKey | null>> = {
  retry: "common.tryAgain", // §19.3 · literal
  reload: "action.reload",
  upgrade: "billing.upgradeToUnlock", // literal
  profile: "action.goToBrand",
  none: null,
};

export interface ErrorPresentation {
  readonly titleKey: CopyKey;
  readonly remedy: Remedy;
  readonly descriptionKey?: CopyKey;
  readonly vars?: MessageVars;
}

/**
 * Lee el `resetAt` de los detalles de un 402.
 *
 * El servidor lo publica en ms de epoch para `content_quota_exceeded` y
 * `blitz_quota_blocked` (`apps/api/src/http/errors.ts`), y es el único dato que
 * convierte "no podés" en "podés el día 15". Se valida en vez de confiar: los
 * `details` son un `Record<string, unknown>` y un número negativo o un string
 * darían una fecha inventada.
 */
export function quotaResetAt(error: unknown): number | null {
  if (!isApiRequestError(error)) return null;
  const raw = error.details?.["resetAt"];
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return null;
  return raw;
}

/**
 * `timeZone: "UTC"`, y no es un detalle: **el reset está definido en UTC**
 * (§16.2, y PRD:1124 para el cap diario de Blitz). Sin fijarlo, `Intl` formatea
 * en la zona de la máquina y un `resetAt` de las 00:00 UTC del 15 sale como
 * `Oct 14` para cualquiera al oeste de Greenwich. Dos usuarios del mismo
 * workspace verían fechas distintas para el mismo límite, y el ticket de
 * soporte que eso genera empieza con "a mí me dice otra cosa".
 *
 * Lo encontró el test, no la revisión: el primer intento no fijaba la zona y
 * pasaba o fallaba según dónde corriera.
 */
const resetFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

/** Qué enseña una pantalla cuando una petición falla. */
export function presentError(error: unknown): ErrorPresentation {
  const titleKey = copyKeyForError(error);
  if (!isApiRequestError(error)) return { titleKey, remedy: "retry" };

  const remedy = REMEDIES[error.code];
  const resetAt = quotaResetAt(error);
  if (remedy === "upgrade" && resetAt !== null) {
    return {
      titleKey,
      remedy,
      descriptionKey: "error.quota.resetsAt",
      vars: { date: resetFormat.format(new Date(resetAt)) },
    };
  }
  return { titleKey, remedy };
}
