/**
 * Puerto AdsPlatform — sprint 9 (agente R), `PU-S9-012`, `D-21`.
 *
 * Crear y operar campañas pagas en una plataforma de anuncios. Hoy la única
 * implementación real es la Marketing API de Meta
 * (`packages/adapters/src/ads/meta`); la otra es un doble en memoria
 * (`packages/adapters/src/ads/fake`) que sirve para los tests y para usar la
 * UI sin cuenta publicitaria.
 *
 * ## La regla de `D-21` vive en la **forma** de este puerto
 *
 * Los métodos que crean (campaña, conjunto, anuncio) **no tienen parámetro de
 * estado**: el adaptador crea siempre en `PAUSED`. No hay forma de pedir
 * "crealo activo" desde el dominio, ni por error. Prender algo es otro método
 * ({@link AdsPlatform.setStatus}), y a ése sólo se llega después de la
 * confirmación con el gasto máximo (`packages/core/src/ads/activation.ts`).
 *
 * ## Plata
 *
 * Todo importe viaja en **unidades mínimas** de la moneda de la cuenta
 * (`…Minor`): centavos en USD/EUR, unidades enteras en JPY/KRW/CLP… Es lo que
 * la Marketing API pide para los presupuestos
 * (https://developers.facebook.com/docs/marketing-api/currencies — "offset").
 * El gasto de los insights viene en unidades mayores y como string; convertir
 * es trabajo del adaptador.
 *
 * ## Errores
 *
 * {@link AdsPlatformError}: un `PortError` con un `reason` estable propio de
 * anuncios. Ningún mensaje ni código de Meta sale de acá (va en `cause`).
 */
import { PortError, type PortErrorCode } from "./errors.js";

/**
 * Objetivos ODAX vigentes —
 * https://developers.facebook.com/docs/marketing-api/reference/ad-campaign-group
 * (consultado el 2026-09-28). Los objetivos viejos (`LINK_CLICKS`,
 * `CONVERSIONS`…) siguen aceptados por Meta, pero no se ofrecen.
 */
export const AD_OBJECTIVES = [
  "OUTCOME_AWARENESS",
  "OUTCOME_TRAFFIC",
  "OUTCOME_ENGAGEMENT",
  "OUTCOME_LEADS",
  "OUTCOME_SALES",
  "OUTCOME_APP_PROMOTION",
] as const;
export type AdObjective = (typeof AD_OBJECTIVES)[number];

/**
 * Los que se ofrecen hoy. Leads, ventas y apps necesitan un `promoted_object`
 * (píxel, formulario, app) que la app todavía no sabe elegir; se dejan fuera
 * en vez de crear conjuntos que Meta va a rechazar.
 */
export const SUPPORTED_AD_OBJECTIVES = [
  "OUTCOME_AWARENESS",
  "OUTCOME_TRAFFIC",
  "OUTCOME_ENGAGEMENT",
] as const satisfies readonly AdObjective[];
export type SupportedAdObjective = (typeof SUPPORTED_AD_OBJECTIVES)[number];

export function isAdObjective(value: string): value is AdObjective {
  return (AD_OBJECTIVES as readonly string[]).includes(value);
}

/** Los dos únicos estados que se escriben. `DELETED`/`ARCHIVED` no se usan. */
export type AdRunStatus = "ACTIVE" | "PAUSED";

/** Motivos estables. La API y la web los traducen; nunca el texto de Meta. */
export const ADS_ERROR_REASONS = [
  /** Token vencido o revocado: reconectar la cuenta publicitaria. */
  "unauthorized",
  /** Falta `ads_management` / `ads_read` o un permiso de la Página. */
  "permission_missing",
  /** Límite de llamadas (BUC) o demasiados cambios de presupuesto. */
  "rate_limited",
  /** Meta rechazó un parámetro (targeting, fechas, ids). */
  "invalid_parameter",
  /** Presupuesto por debajo del mínimo de Meta (1885272). */
  "budget_too_low",
  /** La cuenta publicitaria está deshabilitada o sin acceso a anuncios. */
  "account_disabled",
  /** La media no se pudo subir o Meta la rechazó. */
  "media_rejected",
  /** El objeto no existe (o no es de esta cuenta). */
  "not_found",
  /** Meta no respondió o respondió 5xx. Reintentable. */
  "provider_unavailable",
  /** Respondió algo que no es lo documentado. */
  "unexpected_response",
] as const;
export type AdsErrorReason = (typeof ADS_ERROR_REASONS)[number];

const PORT_CODE_OF: Readonly<Record<AdsErrorReason, PortErrorCode>> = {
  unauthorized: "unauthorized",
  permission_missing: "forbidden",
  rate_limited: "rate_limited",
  invalid_parameter: "bad_request",
  budget_too_low: "bad_request",
  account_disabled: "forbidden",
  media_rejected: "bad_request",
  not_found: "not_found",
  provider_unavailable: "provider_unavailable",
  unexpected_response: "provider_contract_violation",
};

export class AdsPlatformError extends PortError {
  readonly reason: AdsErrorReason;

  constructor(
    reason: AdsErrorReason,
    message: string,
    options: { source: string; cause?: unknown; retryAfterSeconds?: number },
  ) {
    super(PORT_CODE_OF[reason], message, options);
    this.reason = reason;
  }
}

export function isAdsPlatformError(e: unknown): e is AdsPlatformError {
  return e instanceof AdsPlatformError;
}

/** Con qué se habla: token de usuario (en claro, sólo en memoria) y cuenta. */
export interface AdsAuth {
  readonly accessToken: string;
  /** Con el prefijo `act_`. */
  readonly adAccountId: string;
}

/* ------------------------------------------------------------------------ *
 * Conexión
 * ------------------------------------------------------------------------ */

export interface AdAccountSummary {
  /** `act_…`. */
  readonly id: string;
  readonly name: string;
  /** ISO 4217. */
  readonly currency: string;
  readonly timezoneName: string | null;
  /** `1` = ACTIVE según la referencia de Ad Account. */
  readonly accountStatus: number;
}

export interface AdPageSummary {
  readonly id: string;
  readonly name: string;
  /** La cuenta profesional de Instagram vinculada, si la hay. */
  readonly instagramUserId: string | null;
  readonly instagramUsername: string | null;
}

/* ------------------------------------------------------------------------ *
 * Crear (siempre PAUSED)
 * ------------------------------------------------------------------------ */

export interface CreateCampaignInput {
  readonly name: string;
  readonly objective: AdObjective;
}

/**
 * Audiencia básica. Es lo que la doc de Ad Set muestra sin audiencias
 * personalizadas: países (obligatorio), edad e intereses por id.
 */
export interface AdTargeting {
  /** ISO 3166-1 alpha-2. Al menos uno. */
  readonly countries: readonly string[];
  readonly ageMin?: number;
  readonly ageMax?: number;
  /** Ids de intereses de Meta (de la búsqueda de targeting). */
  readonly interestIds?: readonly string[];
}

export interface CreateAdSetInput {
  readonly campaignId: string;
  readonly name: string;
  /** Presupuesto diario del conjunto, en unidades mínimas. */
  readonly dailyBudgetMinor: number;
  readonly targeting: AdTargeting;
  readonly objective: AdObjective;
  /** Sin fin = corre hasta que se pause. */
  readonly endTime?: Date;
}

/** Un video o una imagen ya subidos a la cuenta. */
export type AdMediaRef =
  | { readonly kind: "video"; readonly videoId: string; readonly thumbnailUrl?: string }
  | { readonly kind: "image"; readonly imageHash: string };

export interface CreateCreativeInput {
  readonly name: string;
  readonly pageId: string;
  readonly instagramUserId?: string;
  readonly media: AdMediaRef;
  readonly message: string;
  readonly title?: string;
  /** Destino del clic. Obligatorio para imagen (`link_data.link`). */
  readonly link?: string;
}

export interface CreateAdInput {
  readonly adSetId: string;
  readonly creativeId: string;
  readonly name: string;
}

export interface SplitTestCell {
  readonly name: string;
  /** 1–100; las celdas suman 100. */
  readonly treatmentPercentage: number;
  readonly adSetIds: readonly string[];
}

export interface CreateSplitTestInput {
  /** `/{user_id}/ad_studies` o `/{business_id}/ad_studies`. */
  readonly ownerId: string;
  readonly name: string;
  readonly startTime: Date;
  readonly endTime: Date;
  readonly cells: readonly SplitTestCell[];
}

/* ------------------------------------------------------------------------ *
 * Leer
 * ------------------------------------------------------------------------ */

export interface AdInsightsQuery {
  readonly campaignId: string;
  /** `YYYY-MM-DD` en la zona de la cuenta, inclusive. */
  readonly since: string;
  readonly until: string;
  /** ISO 4217 de la cuenta: el gasto viene en unidades mayores y se convierte. */
  readonly currency: string;
}

/** Una fila por anuncio y por día (`level=ad`, `time_increment=1`). */
export interface AdInsightRow {
  readonly adId: string;
  /** `YYYY-MM-DD` (`date_start`). */
  readonly date: string;
  readonly spendMinor: number;
  readonly impressions: number;
  readonly clicks: number;
  readonly reach: number | null;
  /** `actions[]` sumado por `action_type`. */
  readonly actions: Readonly<Record<string, number>>;
  /** `action_values[]` en unidades mínimas, por `action_type`. */
  readonly actionValuesMinor: Readonly<Record<string, number>>;
}

export interface AdsPlatform {
  /** `ads_management` y `ads_read`: la marca elige una. */
  listAdAccounts(accessToken: string): Promise<readonly AdAccountSummary[]>;
  /** Páginas que administra el usuario, con su IG profesional. */
  listPages(accessToken: string): Promise<readonly AdPageSummary[]>;
  /** El id del usuario del token (dueño de los `ad_studies`). */
  whoAmI(accessToken: string): Promise<{ readonly id: string; readonly name: string }>;

  /** Siempre `PAUSED`. */
  createCampaign(auth: AdsAuth, input: CreateCampaignInput): Promise<{ id: string }>;
  /** Siempre `PAUSED`. */
  createAdSet(auth: AdsAuth, input: CreateAdSetInput): Promise<{ id: string }>;
  /** Meta baja el video de la URL (`file_url`). */
  uploadVideo(
    auth: AdsAuth,
    input: { readonly fileUrl: string; readonly name: string },
  ): Promise<{ videoId: string }>;
  /** `adimages` sólo acepta bytes (no URL). */
  uploadImage(
    auth: AdsAuth,
    input: { readonly bytes: Uint8Array; readonly filename: string },
  ): Promise<{ imageHash: string }>;
  createCreative(auth: AdsAuth, input: CreateCreativeInput): Promise<{ id: string }>;
  /** Siempre `PAUSED`. */
  createAd(auth: AdsAuth, input: CreateAdInput): Promise<{ id: string }>;
  createSplitTest(auth: AdsAuth, input: CreateSplitTestInput): Promise<{ id: string }>;

  /** Campaña, conjunto o anuncio. */
  setStatus(auth: AdsAuth, objectId: string, status: AdRunStatus): Promise<void>;
  updateAdSetDailyBudget(
    auth: AdsAuth,
    adSetId: string,
    dailyBudgetMinor: number,
  ): Promise<void>;

  getInsights(auth: AdsAuth, query: AdInsightsQuery): Promise<readonly AdInsightRow[]>;
}
