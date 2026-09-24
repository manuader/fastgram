/**
 * Programar y publicar — PRD `FR-060`, `DATA-020`.
 *
 * Al confirmar se crea **un `Post` por cada (contenido × plataforma × cuenta)**.
 * El fan-out es la parte que hay que hacer bien de entrada: si un `Post`
 * cubriera varias plataformas, el primer fallo de una dejaría al registro sin
 * un estado que lo describa —¿`FAILED` cuando dos de tres publicaron?— y toda
 * la máquina de estados de `FR-060` (`IN_USER_INBOX`, `AWAITING_RECONNECT`,
 * el carril lento de TikTok) dejaría de tener sentido.
 *
 * Las reglas de resolución de cuenta son las que más `400` producen en la
 * práctica y las tres se equivocan igual de fácil:
 *
 *  - `connectionId` es opcional **sólo si** el workspace tiene exactamente
 *    una conexión activa en esa plataforma. Con dos, elegir por nosotros
 *    publica desde la cuenta equivocada — y eso no se deshace.
 *  - `connectionId` y `warmedAccountId` son **mutuamente excluyentes**.
 *  - El lead time de una cuenta warmed es **el de la cuenta**, no el global.
 */
import { DomainError } from "../errors.js";

/** `D-02`, más `x`, `threads` y `facebook` de `D-09` (migración `0015`). */
export const PLATFORMS = [
  "instagram",
  "tiktok",
  "youtube",
  "linkedin",
  "reddit",
  "x",
  "threads",
  "facebook",
] as const;
export type Platform = (typeof PLATFORMS)[number];

/** `FR-060`: las cuentas warmed sólo soportan estas dos. */
export const WARMED_CAPABLE_PLATFORMS = ["tiktok", "instagram"] as const;

/** Enum normativo de `FR-060`. */
export const POST_STATUSES = [
  "BUILDING",
  "CREATED",
  "SCHEDULED",
  "UPLOADING_TO_TIKTOK",
  "IN_USER_INBOX",
  "POSTED",
  "FAILED",
  "DELETED",
  "AWAITING_RECONNECT",
  "CANCELLED",
] as const;
export type PostStatus = (typeof POST_STATUSES)[number];

/** Códigos literales de `FR-060`. Son contrato público. */
export const SCHEDULING_ERROR_CODES = {
  connectionAmbiguous: "connection_ambiguous",
  postingModeNotSupported: "posting_mode_not_supported_for_platform",
  privacyLevelRequired: "privacy_level_required",
  invalidPrivacyLevel: "invalid_privacy_level",
  privacyLevelWithoutDirect: "privacy_level_not_allowed_without_direct_mode",
} as const;

/**
 * Topes de caracteres por plataforma.
 *
 * Instagram y TikTok están **confirmados** en `FR-060` (contadores observados
 * en la UI). `null` significa "sin verificar", **no** "sin límite": poner un
 * número a ojo produciría un rechazo de la plataforma que el pre-flight no
 * vería venir, que es justo lo que `EXT-007` existe para evitar.
 *
 * YouTube (`PU-LATER-001`): `caption` es el título, *"Maximum 100
 * characters"*; `description`, *"Maximum 5000 bytes"* —
 * https://developers.google.com/youtube/v3/docs/videos — acá va 5 000 como
 * techo de caracteres; el adaptador mide los **bytes** UTF-8 antes de subir.
 * LinkedIn (`PU-LATER-002`): *"The maximum length of the text of a UGC Post
 * is 3,000 characters"* —
 * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/ugc-post-api
 * (la página de la Posts API no repite el número; es el mismo campo).
 *
 * X (280), Threads (500) y Facebook (2 200) son los de sus adaptadores
 * (`packages/adapters/src/publishers/*`, con la doc citada allí). El de
 * Facebook es un techo conservador tomado de Instagram: Meta no publica uno.
 */
export const PLATFORM_FIELD_LIMITS: Readonly<
  Record<Platform, { caption: number | null; description: number | null }>
> = {
  instagram: { caption: 2_200, description: null },
  tiktok: { caption: 90, description: 4_000 },
  youtube: { caption: 100, description: 5_000 },
  linkedin: { caption: 3_000, description: null },
  reddit: { caption: null, description: null },
  x: { caption: 280, description: null },
  threads: { caption: 500, description: null },
  facebook: { caption: 2_200, description: null },
};

/** `FR-060`: `Send to Inbox` / `Post Directly`. Sólo TikTok OAuth. */
export type PostingMode = "inbox" | "direct";

export interface PlatformTarget {
  readonly platform: Platform;
  readonly connectionId?: string | undefined;
  readonly warmedAccountId?: string | undefined;
  readonly caption?: string | undefined;
  readonly description?: string | undefined;
  readonly postingMode?: PostingMode | undefined;
  readonly privacyLevel?: string | undefined;
  readonly autoAddMusic?: boolean | undefined;
}

export interface Connection {
  readonly id: string;
  readonly platform: Platform;
  readonly isActive: boolean;
}

export interface WarmedAccount {
  readonly id: string;
  readonly platform: Platform;
  readonly status: "pending_approval" | "active" | "paused" | "finished";
  /** **De la cuenta**, no el global. `FR-060` lo subraya. */
  readonly minLeadTimeMs: number;
}

export interface Entitlements {
  readonly tiktokDirect: boolean;
  readonly autoCaptions: boolean;
  readonly warmedPosting: boolean;
}

// ───────────────────────────────────────────────────────────────────────────
// Resolución de cuenta
// ───────────────────────────────────────────────────────────────────────────

/**
 * `connection_ambiguous`: con más de una conexión activa, `connectionId` es
 * obligatorio, y el error **lista las candidatas**.
 *
 * Listarlas no es cortesía: sin la lista, el cliente sabe que falta elegir
 * pero no qué puede elegir, y tiene que hacer otra llamada para averiguarlo.
 */
export function resolveConnection(
  platform: Platform,
  requested: string | undefined,
  connections: readonly Connection[],
): string {
  const active = connections.filter((c) => c.platform === platform && c.isActive);

  if (requested !== undefined) {
    const found = active.find((c) => c.id === requested);
    if (found === undefined) {
      // Una conexión de otro workspace o inexistente: `404`, no `403` (§9.2).
      throw new DomainError("not_found", "Connection not found.", {
        platform,
        connectionId: requested,
      });
    }
    return found.id;
  }

  if (active.length === 0) {
    throw new DomainError("invalid_state", `Connect a ${platform} account first.`, {
      platform,
    });
  }
  if (active.length > 1) {
    throw new DomainError(
      "out_of_range",
      `Pick which ${platform} account to post from.`,
      {
        code: SCHEDULING_ERROR_CODES.connectionAmbiguous,
        platform,
        candidates: active.map((c) => c.id),
      },
    );
  }
  return (active[0] as Connection).id;
}

/** `connectionId` y `warmedAccountId` son mutuamente excluyentes (`FR-060`). */
export function assertAccountSelection(target: PlatformTarget): void {
  if (target.connectionId !== undefined && target.warmedAccountId !== undefined) {
    throw new DomainError(
      "out_of_range",
      "Choose either a connected account or a warmed account, not both.",
      { platform: target.platform },
    );
  }
}

// ───────────────────────────────────────────────────────────────────────────
// TikTok: posting mode y privacy level
// ───────────────────────────────────────────────────────────────────────────

export interface TikTokOptionsContext {
  readonly entitlements: Entitlements;
  /**
   * Valores que **la plataforma** declara para esta cuenta (creator info).
   *
   * No hay una lista fija en el dominio a propósito: el PRD la obtiene del
   * proveedor y tiene un `503 tiktok_creator_info_unavailable` para cuando no
   * responde. Fijar las constantes acá sería inventar el catálogo de otro.
   */
  readonly allowedPrivacyLevels: readonly string[];
}

export function assertValidTikTokOptions(
  target: PlatformTarget,
  context: TikTokOptionsContext,
): void {
  const usesWarmed = target.warmedAccountId !== undefined;

  if (target.postingMode !== undefined) {
    // `posting_mode` es **sólo TikTok OAuth**.
    if (target.platform !== "tiktok" || usesWarmed) {
      throw new DomainError(
        "out_of_range",
        "Posting mode is only available for connected TikTok accounts.",
        {
          code: SCHEDULING_ERROR_CODES.postingModeNotSupported,
          platform: target.platform,
        },
      );
    }
  }

  if (target.postingMode === "direct") {
    if (!context.entitlements.tiktokDirect) {
      throw new DomainError(
        "invalid_state",
        "Posting directly to TikTok isn't available on your plan.",
        { code: "forbidden", platform: target.platform },
      );
    }
    if (target.privacyLevel === undefined) {
      throw new DomainError("out_of_range", "Choose a privacy level.", {
        code: SCHEDULING_ERROR_CODES.privacyLevelRequired,
      });
    }
    if (!context.allowedPrivacyLevels.includes(target.privacyLevel)) {
      throw new DomainError("out_of_range", "That privacy level isn't available.", {
        code: SCHEDULING_ERROR_CODES.invalidPrivacyLevel,
        allowed_values: context.allowedPrivacyLevels,
      });
    }
    return;
  }

  // Sin modo directo, un `privacy_level` no aplica: el post va al inbox del
  // creador y la privacidad la elige él al publicarlo.
  if (target.privacyLevel !== undefined) {
    throw new DomainError(
      "out_of_range",
      "Privacy level only applies when posting directly.",
      { code: SCHEDULING_ERROR_CODES.privacyLevelWithoutDirect },
    );
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Cuentas warmed
// ───────────────────────────────────────────────────────────────────────────

/** `Warmed-account posts can only be scheduled up to 30 days ahead.` */
export const WARMED_MAX_DAYS_AHEAD = 30;
const DAY_MS = 86_400_000;

export function assertWarmedSchedulable(
  account: WarmedAccount,
  scheduledFor: Date,
  now: Date,
  entitlements: Entitlements,
): void {
  if (!(WARMED_CAPABLE_PLATFORMS as readonly string[]).includes(account.platform)) {
    throw new DomainError(
      "out_of_range",
      "Warmed accounts are only available for TikTok and Instagram.",
      { platform: account.platform },
    );
  }
  if (!entitlements.warmedPosting) {
    throw new DomainError(
      "invalid_state",
      "Warmed posting isn't enabled for this workspace.",
      { code: "forbidden" },
    );
  }
  if (account.status === "pending_approval") {
    throw new DomainError(
      "conflict",
      "This warmed account is awaiting your approval. Approve the account, then reschedule this post.",
      { warmedAccountId: account.id },
    );
  }
  if (account.status !== "active") {
    throw new DomainError("conflict", "That warmed account can't post right now.", {
      warmedAccountId: account.id,
      status: account.status,
    });
  }

  const lead = scheduledFor.getTime() - now.getTime();
  if (lead < account.minLeadTimeMs) {
    // **El de la cuenta**, no un global. Usar un global publica antes de que
    // la cuenta esté lista y es lo que quema cuentas warmed.
    const hours = Math.ceil(account.minLeadTimeMs / 3_600_000);
    throw new DomainError(
      "out_of_range",
      `Warmed-account posts need at least ${hours} hours of lead time.`,
      { warmedAccountId: account.id, minLeadTimeMs: account.minLeadTimeMs },
    );
  }

  if (lead > WARMED_MAX_DAYS_AHEAD * DAY_MS) {
    throw new DomainError(
      "out_of_range",
      `Warmed-account posts can only be scheduled up to ${WARMED_MAX_DAYS_AHEAD} days ahead.`,
      { warmedAccountId: account.id, maxDaysAhead: WARMED_MAX_DAYS_AHEAD },
    );
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Generación de captions
// ───────────────────────────────────────────────────────────────────────────

export interface CaptionGenerationResult {
  readonly target: PlatformTarget;
  /** Campos que la IA tiene que rellenar. Vacío = no hay nada que generar. */
  readonly fieldsToGenerate: readonly ("caption" | "description")[];
}

/**
 * `enableCaptionGeneration` rellena **sólo campos vacíos**; los valores
 * explícitos no vacíos **siempre ganan** (`FR-060`, `AI-006`).
 *
 * Es la regla que decide si el producto es una herramienta o una sorpresa: si
 * la generación pisara lo escrito, alguien que redactó una caption con cuidado
 * la vería reemplazada al programar, sin aviso y sin forma de recuperarla.
 *
 * `reddit` no lo soporta.
 */
export function planCaptionGeneration(
  target: PlatformTarget,
  entitlements: Entitlements,
): CaptionGenerationResult {
  if (!entitlements.autoCaptions) {
    throw new DomainError(
      "invalid_state",
      "Automatic captions aren't available on your plan.",
      { code: "payment_required" },
    );
  }
  if (target.platform === "reddit") {
    throw new DomainError(
      "out_of_range",
      "Automatic captions aren't supported on Reddit.",
      { platform: target.platform },
    );
  }

  const fields: ("caption" | "description")[] = [];
  if (isBlank(target.caption)) fields.push("caption");
  if (
    PLATFORM_FIELD_LIMITS[target.platform].description !== null &&
    isBlank(target.description)
  ) {
    fields.push("description");
  }
  return { target, fieldsToGenerate: fields };
}

function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim().length === 0;
}

/**
 * Topes de caracteres, donde el PRD o el adaptador los dan. Ver
 * `PLATFORM_FIELD_LIMITS`.
 *
 * Se cuenta **por code point**, como el pre-flight de los publicadores
 * (`assertPublishable`): `string.length` cuenta unidades UTF-16 y un emoji
 * fuera del BMP valdría dos, así que el dominio rechazaría lo que el
 * publicador acepta.
 */
export function assertValidCopy(target: PlatformTarget): void {
  const limits = PLATFORM_FIELD_LIMITS[target.platform];
  const captionLength = target.caption === undefined ? 0 : codePoints(target.caption);
  if (limits.caption !== null && captionLength > limits.caption) {
    throw new DomainError(
      "out_of_range",
      `The ${target.platform} caption must be ${limits.caption} characters or fewer.`,
      { platform: target.platform, length: captionLength, max: limits.caption },
    );
  }
  const descriptionLength =
    target.description === undefined ? 0 : codePoints(target.description);
  if (limits.description !== null && descriptionLength > limits.description) {
    throw new DomainError(
      "out_of_range",
      `The ${target.platform} description must be ${limits.description} characters or fewer.`,
      {
        platform: target.platform,
        length: descriptionLength,
        max: limits.description,
      },
    );
  }
}

function codePoints(value: string): number {
  return [...value].length;
}

// ───────────────────────────────────────────────────────────────────────────
// Fan-out
// ───────────────────────────────────────────────────────────────────────────

export interface PlannedPost {
  readonly contentId: string;
  readonly platform: Platform;
  readonly accountRef: { readonly kind: "connection" | "warmed"; readonly id: string };
  readonly status: Extract<PostStatus, "SCHEDULED" | "BUILDING">;
  readonly scheduledFor: Date;
  readonly caption?: string | undefined;
  readonly description?: string | undefined;
  readonly postingMode?: PostingMode | undefined;
  readonly privacyLevel?: string | undefined;
}

/**
 * Un `Post` por (contenido × plataforma × cuenta).
 *
 * `contentStatus` decide el estado inicial: si la pieza todavía no está
 * `CREATED`, el post nace en `BUILDING` y espera al media. Es lo que permite
 * programar desde Blitz **antes** de que el render termine, que es el flujo
 * normal: el build tarda 30 s – 2 min y nadie espera mirando.
 */
export function planPostFanOut(params: {
  readonly contentId: string;
  readonly contentStatus: "BUILDING" | "CREATED" | "FAILED";
  readonly targets: readonly PlatformTarget[];
  readonly resolvedAccounts: ReadonlyMap<
    Platform,
    { readonly kind: "connection" | "warmed"; readonly id: string }
  >;
  readonly scheduledFor: Date;
}): readonly PlannedPost[] {
  if (params.contentStatus === "FAILED") {
    throw new DomainError(
      "invalid_state",
      "This piece failed to build, so it can't be scheduled.",
      { contentId: params.contentId },
    );
  }
  if (params.targets.length === 0) {
    throw new DomainError("out_of_range", "Pick at least one platform.", {
      contentId: params.contentId,
    });
  }

  return params.targets.map((target) => {
    const account = params.resolvedAccounts.get(target.platform);
    if (account === undefined) {
      throw new DomainError("invalid_state", "No account resolved for this platform.", {
        platform: target.platform,
      });
    }
    return {
      contentId: params.contentId,
      platform: target.platform,
      accountRef: account,
      status: params.contentStatus === "CREATED" ? "SCHEDULED" : "BUILDING",
      scheduledFor: params.scheduledFor,
      caption: target.caption,
      description: target.description,
      postingMode: target.postingMode,
      privacyLevel: target.privacyLevel,
    };
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Reprogramación y cancelación
// ───────────────────────────────────────────────────────────────────────────

export interface ExistingPost {
  readonly id: string;
  readonly status: PostStatus;
  /** TikTok en su carril lento. Reintenta hasta 72 h. */
  readonly tiktokProcessingDelayed?: boolean | undefined;
  readonly cancellationPending?: boolean | undefined;
  readonly scheduledFor: Date;
  readonly isWarmed: boolean;
}

/** `FR-060`: Fastlane reintenta el carril lento hasta **72 h**. */
export const TIKTOK_SLOW_LANE_MAX_HOURS = 72;

/**
 * `tiktokProcessingDelayed` **bloquea la reprogramación** (`FR-060`, criterio 5).
 *
 * La razón es la peor posible si se ignora: TikTok suele publicar solo en
 * 24–48 h. Reprogramar mientras el flag está puesto crea un **duplicado** en
 * el perfil del cliente, y borrar un post duplicado ya publicado no siempre se
 * puede.
 */
export function assertCanReschedule(post: ExistingPost): void {
  if (post.tiktokProcessingDelayed === true) {
    throw new DomainError(
      "conflict",
      "TikTok is still processing this post. Rescheduling now would post it twice.",
      { postId: post.id },
    );
  }
  if (post.cancellationPending === true) {
    // Se resuelve sola a `CANCELLED` o a `POSTED`. Reintentar la empeora.
    throw new DomainError(
      "conflict",
      "This post is being cancelled. Wait for it to settle.",
      { postId: post.id },
    );
  }
  if (post.status === "POSTED" || post.status === "DELETED") {
    throw new DomainError("invalid_state", "This post can't be rescheduled.", {
      postId: post.id,
      status: post.status,
    });
  }
}

/**
 * `Posts scheduled for today are handed off quickly and can't be cancelled
 * once they're being posted.`
 *
 * "El mismo día" se evalúa en UTC, igual que los resets de cuota (§16.2). No
 * es la zona del usuario, y conviene saberlo: la alternativa —la zona local—
 * haría que la cancelabilidad de un post dependiera de dónde está sentado
 * quien la pide.
 */
export function assertCanCancel(post: ExistingPost, now: Date): void {
  if (post.status === "POSTED") {
    throw new DomainError("invalid_state", "This post already went out.", {
      postId: post.id,
    });
  }
  if (post.status === "UPLOADING_TO_TIKTOK" || post.status === "IN_USER_INBOX") {
    throw new DomainError(
      "conflict",
      "This post has already been handed off and can't be cancelled.",
      { postId: post.id, status: post.status },
    );
  }
  if (post.isWarmed && sameUtcDay(post.scheduledFor, now)) {
    throw new DomainError(
      "conflict",
      "Posts scheduled for today are handed off quickly and can't be cancelled once they're being posted.",
      { postId: post.id },
    );
  }
}

function sameUtcDay(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

/**
 * `IN_USER_INBOX` **no es un error** (`FR-060`, criterio 4).
 *
 * TikTok aceptó el post y lo dejó como borrador en la app del creador. Está
 * pendiente de una acción **del usuario**, no rota. Mostrarlo como fallo hace
 * que la gente reintente y termine publicando dos veces.
 */
export function isAwaitingUserAction(status: PostStatus): boolean {
  return status === "IN_USER_INBOX" || status === "AWAITING_RECONNECT";
}

export function isTerminal(status: PostStatus): boolean {
  return (
    status === "POSTED" ||
    status === "FAILED" ||
    status === "DELETED" ||
    status === "CANCELLED"
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Estrategia y calendario (`PU-CAL-001`, `PU-CAL-002`)
// ───────────────────────────────────────────────────────────────────────────
//
// Se re-exportan desde acá y no desde `src/index.ts` porque ese índice es
// compartido con otros agentes del sprint 2: `index.ts` ya exporta este
// archivo, así que los módulos nuevos del área quedan publicados sin tocarlo.
export * from "./zoned-time.js";
export * from "./auto-slot.js";
export * from "./calendar-move.js";
