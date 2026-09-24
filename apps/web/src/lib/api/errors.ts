/**
 * Errores del cliente de API · PRD §9.3 (PRD:2253-2257).
 *
 * El API devuelve `{"error":{"code","message","details"}}` con un `code`
 * **estable** (`packages/contracts`). La shell nunca enseña el `message` crudo:
 * traduce el `code` a una clave del catálogo de copy. La razón es la regla del
 * proyecto "ningún error crudo de proveedor sale hacia afuera" llevada hasta el
 * final — un `message` en inglés de servidor, sin traducir y sin control de
 * producto, es exactamente eso.
 */
import type { ApiError, ErrorCode } from "@fastgram/contracts";
import type { CopyKey } from "../i18n/t";

/** Fallos que no vienen del API: no hay `code` porque no hubo respuesta útil. */
export type TransportFailureCode = "network_error" | "invalid_response" | "timeout";

export type FailureCode = ErrorCode | TransportFailureCode;

export interface ApiRequestErrorInit {
  code: FailureCode;
  /** `0` cuando la petición ni llegó a tener respuesta. */
  status: number;
  /** El texto del servidor. Para logs y soporte, **no** para pantalla. */
  serverMessage?: string | undefined;
  details?: Record<string, unknown> | undefined;
}

export class ApiRequestError extends Error {
  readonly code: FailureCode;
  readonly status: number;
  readonly serverMessage: string | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(init: ApiRequestErrorInit) {
    super(init.serverMessage ?? init.code);
    this.name = "ApiRequestError";
    this.code = init.code;
    this.status = init.status;
    this.serverMessage = init.serverMessage;
    this.details = init.details;
  }

  static fromEnvelope(error: ApiError, status: number): ApiRequestError {
    return new ApiRequestError({
      code: error.code,
      status,
      serverMessage: error.message,
      details: error.details,
    });
  }
}

export function isApiRequestError(value: unknown): value is ApiRequestError {
  return value instanceof ApiRequestError;
}

/**
 * `code` → clave de copy.
 *
 * El `Record` es **exhaustivo** a propósito: el día que `packages/contracts`
 * añada un código nuevo, esto deja de compilar y alguien tiene que decidir qué
 * lee el usuario. Con un `switch` con `default` el código nuevo saldría como
 * "Something went wrong" y nadie se enteraría nunca.
 *
 * Donde el catálogo de `packages/ui` tiene copy del PRD, se usa. Donde el PRD
 * sólo da el código y no el texto (§19.6), la clave es del catálogo local y el
 * copy lo escribió esta sesión — está marcado allí.
 */
export const FAILURE_COPY_KEYS: Readonly<Record<FailureCode, CopyKey>> = {
  // Transversales
  bad_request: "error.badRequest.title",
  unauthorized: "error.accessDenied.title", // ERR-U01
  forbidden: "error.accessDenied.title", // ERR-U01
  not_found: "error.notFound.title",
  conflict: "error.conflict.title",
  gone: "error.gone.title",
  payment_required: "error.notEnoughCredits.title", // ERR-R08 · PRD:1519
  rate_limited: "error.rateLimited.title", // ERR-R01
  service_unavailable: "error.serviceUnavailable.title", // ERR-R06

  // Cuotas · §19.8
  blitz_quota_exceeded: "error.blitzQuota.title", // ERR-R02
  content_quota_exceeded: "error.contentQuota.title", // ERR-R03

  // Ciclo de vida del contenido · §19.6 (el PRD da el código, no el texto)
  content_still_building: "error.contentStillBuilding.title", // ERR-P02
  content_edit_in_progress: "error.contentEditInProgress.title", // ERR-P03
  stale_revision: "error.staleRevision.title", // ERR-P04
  content_not_editable: "error.contentNotEditable.title", // ERR-P05
  content_has_linked_posts: "error.contentHasLinkedPosts.title", // ERR-P06
  content_unavailable_for_type: "error.contentUnavailableForType.title", // ERR-P07
  company_profile_not_ready: "error.companyProfileNotReady.title", // ERR-P08
  unsupported_content_state: "error.unsupportedContentState.title", // FR-051
  media_in_use: "error.mediaInUse.title", // §19.10

  // Programación y publicación · FR-060
  connection_ambiguous: "error.connectionAmbiguous.title",
  posting_mode_not_supported_for_platform: "error.postingModeNotSupported.title",
  privacy_level_required: "error.privacyLevelRequired.title",
  invalid_privacy_level: "error.invalidPrivacyLevel.title",
  privacy_level_not_allowed_without_direct_mode: "error.privacyLevelNotAllowed.title",
  tiktok_creator_info_unavailable: "error.tiktokCreatorInfoUnavailable.title", // ERR-D09
  tiktok_post_limit_exceeded: "error.platformPostLimit.title", // ERR-R05
  youtube_post_limit_exceeded: "error.platformPostLimit.title", // ERR-R05
  instagram_post_limit_exceeded: "error.platformPostLimit.title", // ERR-R05

  // Ángulos · FR-056
  MAX_ANGLES_EXCEEDED: "error.maxAngles.title",
  MAX_ANGLES_PER_INFLUENCER_EXCEEDED: "error.maxAnglesPerInfluencer.title",

  // Automations · FR-150
  AUTOMATION_NO_CONTENT_TYPE_SELECTED: "error.automationNoContentType.title",
  AUTOMATION_VIDEO_HOOK_NEEDS_DEMO_VIDEO: "error.automationDemoVideo.title",

  // Transporte
  network_error: "error.network.title",
  invalid_response: "error.invalidResponse.title",
  timeout: "error.timeout.title",
};

/** La clave de copy de cualquier error que llegue a una pantalla. */
export function copyKeyForError(error: unknown): CopyKey {
  if (isApiRequestError(error)) return FAILURE_COPY_KEYS[error.code];
  return "common.somethingWentWrong"; // §19.3 · literal
}
