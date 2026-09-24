/**
 * Puerto SocialPublisher — PRD `INT-001`…`INT-006`, `FR-060`, §10 regla 7,
 * §19.5, `NFR-012`, `NFR-015`.
 *
 * Qué lo obliga, además de la separación lectura/publicación de `INT-014` (ver
 * `social-reader.ts`): `INT-006`. Ayrshare aparece nombrado en la
 * documentación oficial y **algunas capacidades sólo existen por esa ruta**
 * —la etiqueta de contenido IA en Instagram—, de donde el PRD saca una
 * conclusión explícita para el clon: «la arquitectura de publicación debe
 * soportar **múltiples proveedores por plataforma con capacidades distintas**,
 * y **exponer al usuario qué se puede y qué no según la ruta**».
 *
 * Eso es lo que hace que {@link SocialPublishCapabilities} no sea decorado: no
 * hay una «publicación» genérica que todas las plataformas hagan igual. TikTok
 * tiene `posting_mode` y niveles de privacidad; Reddit rechaza la generación
 * de captions (`INT-005`); YouTube usa `caption` como título; LinkedIn sólo
 * tiene `caption`; las cuentas warmed existen únicamente en TikTok e
 * Instagram. Si el puerto asumiera un denominador común, la UI tendría que
 * volver a saber de plataformas —que es exactamente lo que el puerto evita— y
 * `P3-OAUTH-011` (los 16 estados de error de §19.5) no tendría dónde vivir.
 *
 * **Traducción de errores.** §10 regla 6 y `FR-060`: «los errores de
 * plataforma se traducen a códigos estables neutrales respecto al proveedor
 * antes de mostrarse». Acá eso se parte en dos: el fallo de publicación es un
 * **resultado** con {@link PublishFailureReason} neutral —`instagram_repeated_mention`
 * del contrato público se compone como plataforma + `repeated_mention`, y esa
 * composición la hace `packages/contracts`, no el puerto—; el fallo de
 * transporte es `PortError`. `DP-006` (§25.1) agrega la regla de implementación:
 * «una tabla de mapeo determinística debe ser la primera línea» y sólo lo que
 * no matchea escala al puerto `Judgment`.
 *
 * Errores (`PortError`):
 *  - `unauthorized` — la conexión está `expired` / `revoked`. Es lo que lleva
 *    un `Post` a `AWAITING_RECONNECT` (`FR-060`), no a `FAILED`.
 *  - `forbidden` — falta un entitlement o un scope de la plataforma.
 *  - `rate_limited` — límite de la plataforma; `retryAfterSeconds` si vino.
 *  - `provider_unavailable` — incluye `503 tiktok_creator_info_unavailable`.
 *  - `timeout`, `not_found` (referencia de post desconocida),
 *    `bad_request` (payload que viola las capacidades declaradas),
 *    `conflict` (cancelación en curso), `provider_contract_violation`.
 *
 * Lo que este puerto NO hace: no programa (eso es `Queue` + `core`), no decide
 * el watcher de 72 h de `NFR-015` ni el reintento — sólo reporta
 * {@link PublishStatus.processingDelayed} para que la política viva en un solo
 * lugar—, y no resuelve la ambigüedad de cuenta (`400 connection_ambiguous`
 * es de `core`, que sabe cuántas conexiones hay).
 */

import { PortError } from "./errors.js";

/*
 * Las listas de este archivo están en runtime —y los tipos derivados de ellas—
 * por la misma razón que `ACQUISITION_TIERS` en `social-reader.ts`: cada una
 * tiene un gemelo en el enum de Postgres (`packages/db`) y en el zod de
 * `packages/contracts`, y una unión de literales no se puede leer desde fuera
 * de TypeScript. `scripts/check-consistency.mjs` las compara leyendo texto.
 * El orden es el del `CREATE TYPE` de la base.
 */

/**
 * `D-02` · enum `social_platform` (`DATA-016`), más las tres redes de `D-09`
 * que suma la migración `0015` (`x`, `threads`, `facebook`, en ese orden: el
 * `ALTER TYPE … ADD VALUE` las agrega al final).
 */
export const PUBLISH_PLATFORMS = [
  "tiktok",
  "instagram",
  "youtube",
  "linkedin",
  "reddit",
  "x",
  "threads",
  "facebook",
] as const;
export type PublishPlatform = (typeof PUBLISH_PLATFORMS)[number];

/** `DATA-020`. Mutuamente excluyentes en un `Post`. */
export const PUBLISH_ACCOUNT_TYPES = ["oauth", "warmed"] as const;
export type PublishAccountType = (typeof PUBLISH_ACCOUNT_TYPES)[number];

/** `INT-001`. Sólo TikTok OAuth. */
export const POSTING_MODES = ["inbox", "direct"] as const;
export type PostingMode = (typeof POSTING_MODES)[number];

/** `DATA-020`, literal. */
export const PRIVACY_LEVELS = [
  "PUBLIC_TO_EVERYONE",
  "MUTUAL_FOLLOW_FRIENDS",
  "FOLLOWER_OF_CREATOR",
  "SELF_ONLY",
] as const;
export type PrivacyLevel = (typeof PRIVACY_LEVELS)[number];

export type PublishMediaKind = "video" | "image" | "carousel" | "slideshow" | "text";

/** `NFR-012`: máx. 100 ids por llamada, con deduplicación previa. */
export const MAX_METRICS_BATCH = 100;

/* ------------------------------------------------------------------------ *
 * Capacidades
 * ------------------------------------------------------------------------ */

export interface CaptionLimits {
  /** Instagram 2200 · TikTok (title) 90 · YouTube (título) · LinkedIn. */
  readonly caption: number;
  /** TikTok 4000 · YouTube (cuerpo). Ausente si la plataforma no lo tiene. */
  readonly description?: number;
}

export interface SocialPublishCapabilities {
  readonly platform: PublishPlatform;
  /**
   * Ruta que implementa este adaptador. `INT-006`: hay más de una por
   * plataforma y no dan lo mismo. Opaco a propósito — quien llama compara
   * capacidades, no nombres de proveedor.
   */
  readonly provider: string;
  readonly accountTypes: readonly PublishAccountType[];
  readonly mediaKinds: readonly PublishMediaKind[];
  readonly captionLimits: CaptionLimits;
  /** Vacío donde no aplica. Sólo TikTok OAuth tiene modos (`FR-060`). */
  readonly postingModes: readonly PostingMode[];
  /** Los que la ruta admite. Los permitidos *para esta cuenta* los da
   *  {@link SocialPublisher.getAccountOptions}. */
  readonly privacyLevels: readonly PrivacyLevel[];
  /** `INT-002`: la etiqueta de contenido IA existe sólo por la ruta Ayrshare. */
  readonly supportsAiLabel: boolean;
  readonly supportsPartnershipDisclosure: boolean;
  /** `INT-001`: `Auto-Add Music` en slideshows de TikTok. */
  readonly supportsAutoAddMusic: boolean;
  /** `INT-005`: Reddit devuelve `400 bad_request` si se pide. */
  readonly supportsCaptionGeneration: boolean;
  /** `false` ⇒ el adaptador publica al instante y la hora la pone `Queue`. */
  readonly supportsNativeScheduling: boolean;
  /**
   * `INT-001`: «Personal accounts cannot use the publishing API». Vacío
   * significa que la plataforma no distingue.
   */
  readonly requiredAccountKinds: readonly string[];
  /**
   * De dónde tiene que salir la media que se le pasa en {@link PublishMedia.urls}.
   *
   * - `public_url` (default): la plataforma **baja** la media ella misma
   *   (Instagram: «We cURL media used in publishing attempts»; Threads; el
   *   `file_url` de los Reels de Facebook; las fotos de TikTok por
   *   `PULL_FROM_URL`). Tiene que ser una URL que alguien de afuera alcance:
   *   el puerto `PublicMediaUrls`.
   * - `private_url`: el adaptador baja los bytes y los sube él (X, video de
   *   TikTok por `FILE_UPLOAD`). Alcanza con una URL firmada del propio
   *   storage, y no hace falta túnel.
   */
  readonly mediaSource?: "public_url" | "private_url";
  /**
   * Excepciones por tipo de media a {@link mediaSource}. TikTok: el video se
   * sube (`FILE_UPLOAD`, alcanza una URL privada) y las fotos se traen
   * (`PULL_FROM_URL`, pública y de dominio verificado).
   */
  readonly mediaSourceByKind?: Readonly<
    Partial<Record<PublishMediaKind, "public_url" | "private_url">>
  >;
}

/**
 * Lo que la Creator Info API de TikTok responde por cuenta (`INT-001`):
 * valores de privacidad permitidos **ahora mismo** para esta cuenta. No es
 * estático, por eso no vive en {@link SocialPublishCapabilities}.
 */
export interface AccountPublishOptions {
  readonly allowedPrivacyLevels: readonly PrivacyLevel[];
  /** `false` ⇒ direct posting cae al inbox (`ERR-D14`). */
  readonly directPostingAvailable: boolean;
  readonly maxVideoDurationSeconds?: number;
  readonly displayName?: string;
}

/* ------------------------------------------------------------------------ *
 * Publicación
 * ------------------------------------------------------------------------ */

/** Referencia a la cuenta destino. Los tokens los resuelve el adaptador. */
export interface PublishAccountRef {
  readonly accountType: PublishAccountType;
  /** Id interno de `Connection` (`DATA-016`) o de `WarmedAccount` (`DATA-017`). */
  readonly accountId: string;
  /** Credencial ya descifrada. Nunca se loguea ni se devuelve (`NFR-007`). */
  readonly accessToken?: string;
  /**
   * El id de la cuenta **en la plataforma** (`connections.platformUserId`): el
   * IG user id, el Threads user id o el id de la Página de Facebook que va en
   * la ruta de la API. Las plataformas que lo deducen del token (X, TikTok) lo
   * ignoran.
   */
  readonly platformUserId?: string;
}

export interface PublishMedia {
  readonly kind: PublishMediaKind;
  /**
   * URLs firmadas y de vida corta del propio storage (`NFR-008`). Varias sólo
   * para `carousel` / `slideshow`.
   */
  readonly urls: readonly string[];
  readonly durationSeconds?: number;
  /**
   * Píxeles del render (el `canvas` del payload de build), si se conocen.
   * YouTube los usa para decidir si un video es un Short (vertical o
   * cuadrado) **antes** de gastar una subida de la cuota diaria.
   */
  readonly width?: number;
  readonly height?: number;
}

export interface PublishRequest {
  readonly account: PublishAccountRef;
  readonly media: PublishMedia;
  /** Copy del usuario. Instagram: caption. YouTube: título. TikTok: title. */
  readonly caption: string;
  /** TikTok description · YouTube cuerpo. `undefined` donde no aplica. */
  readonly description?: string;
  readonly postingMode?: PostingMode;
  /** Obligatorio con `postingMode: "direct"` (`FR-060`). */
  readonly privacyLevel?: PrivacyLevel;
  /** `NFR-024`: disclosure de contenido IA. Requiere `supportsAiLabel`. */
  readonly aiGenerated?: boolean;
  /** `NFR-024`: disclosure de partnership pagado. */
  readonly paidPartnership?: boolean;
  readonly autoAddMusic?: boolean;
  /**
   * `NFR-004` / `NFR-015`. Mismo key + mismo contenido ⇒ el adaptador devuelve
   * el resultado anterior en vez de publicar dos veces. Es la defensa contra
   * el duplicado del carril lento.
   */
  readonly idempotencyKey: string;
}

/**
 * Motivos neutrales. Los cuatro primeros salen de copy o de códigos literales
 * del PRD; `unsupported_media` y `unknown` son de este puerto, porque un enum
 * cerrado sin salida obligaría a inventar una categoría cada vez que una
 * plataforma agregue un rechazo.
 */
export type PublishFailureReason =
  /** `tiktok_post_limit_exceeded` · `instagram_…` · `youtube_…` (`FR-060`). */
  | "post_limit_exceeded"
  /** `instagram_repeated_mention` (`INT-002`). */
  | "repeated_mention"
  /** `ERR-D03` / `ERR-D05`. */
  | "permissions_missing"
  /** `ERR-D06`: se conectó otra cuenta distinta a la esperada. */
  | "account_changed"
  /** `ERR-D16`: el nivel de privacidad no está disponible para esta cuenta. */
  | "privacy_level_not_allowed"
  /** `ERR-P11`: la plataforma rechazó el archivo. */
  | "unsupported_media"
  | "unknown";

export interface PublishFailure {
  readonly reason: PublishFailureReason;
  /**
   * `FR-060`: «un `errorMessage` siempre seguro de mostrar». Sin ids internos,
   * sin nombres de proveedor, sin trazas.
   */
  readonly message: string;
}

/** Estados observables de un intento, alineados con los de `Post` (`FR-060`). */
export type PublishStatusKind =
  /** `UPLOADING_TO_TIKTOK` y equivalentes. */
  | "processing"
  /** `IN_USER_INBOX`. **No es un error**: falta que el usuario pulse Post. */
  | "in_user_inbox"
  /** `POSTED`. */
  | "published"
  /** `FAILED`. */
  | "failed"
  /** `CANCELLED`. */
  | "cancelled";

export interface PublishStatus {
  readonly kind: PublishStatusKind;
  /** Id del post en la plataforma. Presente desde `processing` en adelante. */
  readonly externalPostId?: string;
  readonly permalink?: string;
  /** `DATA-020`: la copy realmente publicada, si la plataforma la ajustó. */
  readonly publishedCaption?: string;
  /** `DATA-020`: hoy sólo `repeated_mention`. */
  readonly captionAdjustmentReason?: "repeated_mention";
  /**
   * `tiktokProcessingDelayed` sin el prefijo de plataforma. `NFR-015`: mientras
   * esté puesto **no se reprograma** —crearía un duplicado— y el watcher
   * espera hasta 72 h. Esa política es de `core`; el puerto sólo informa.
   */
  readonly processingDelayed?: boolean;
  /** Sólo con `kind: "failed"`. */
  readonly failure?: PublishFailure;
}

/** Con qué volver a preguntar por un post. */
export interface PublishRef {
  readonly account: PublishAccountRef;
  readonly externalPostId: string;
}

export interface PostMetrics {
  readonly externalPostId: string;
  readonly views?: number;
  readonly likes?: number;
  readonly comments?: number;
  readonly shares?: number;
  /**
   * `NFR-016`: hay que poder distinguir un cero real de un pre-sync. Quien
   * consume compara esto con `postedAt`.
   */
  readonly syncedAt: Date;
}

export interface CancelOutcome {
  /** `false` si ya salió o ya estaba terminado. */
  readonly cancelled: boolean;
  /**
   * `cancellationPending` de `FR-060`: la cancelación está en curso y se
   * resuelve sola a `CANCELLED` o a `POSTED`. **No reintentar.**
   */
  readonly pending: boolean;
}

/* ------------------------------------------------------------------------ *
 * El puerto
 * ------------------------------------------------------------------------ */

export interface SocialPublisher {
  /** Estático por adaptador. No hace red. */
  capabilities(): SocialPublishCapabilities;

  /** Por cuenta y en vivo. Ver {@link AccountPublishOptions}. */
  getAccountOptions(account: PublishAccountRef): Promise<AccountPublishOptions>;

  /**
   * Entrega el post a la plataforma. Devolver `kind: "failed"` es un resultado
   * legítimo: la publicación falló, la llamada no.
   */
  publish(request: PublishRequest): Promise<PublishStatus>;

  /** Para el watcher: reconsulta el estado. `null` si la plataforma lo perdió. */
  getStatus(ref: PublishRef): Promise<PublishStatus | null>;

  cancel(ref: PublishRef): Promise<CancelOutcome>;

  /**
   * Métricas de §9.5 #10. Máx. {@link MAX_METRICS_BATCH} referencias; más es
   * `bad_request`. Los ids que la plataforma no reconoce simplemente no
   * aparecen en la respuesta: pedir métricas no es preguntar por existencia.
   */
  fetchMetrics(refs: readonly PublishRef[]): Promise<readonly PostMetrics[]>;
}

/* ------------------------------------------------------------------------ *
 * Entrega incierta
 * ------------------------------------------------------------------------ */

/**
 * La llamada falló **en un punto donde la plataforma pudo haber publicado
 * igual**: un timeout o un 5xx en el paso que publica (`media_publish`,
 * `threads_publish`, `upload_phase=finish`, `POST /2/tweets`).
 *
 * Es la distinción que hace posible reintentar sin duplicar (`NFR-005`,
 * `NFR-015`): un `PortError` común con `isRetryable` dice «no llegó nada, se
 * puede volver a intentar»; éste dice «no se sabe», y **nunca** se reintenta
 * solo aunque el código sea transitorio.
 */
export class PublishDeliveryUncertainError extends PortError {
  readonly deliveryUncertain = true as const;

  override get isRetryable(): boolean {
    return false;
  }
}

export function isPublishDeliveryUncertain(
  e: unknown,
): e is PublishDeliveryUncertainError {
  return e instanceof PublishDeliveryUncertainError;
}

export * from "./connection-tokens.js";
