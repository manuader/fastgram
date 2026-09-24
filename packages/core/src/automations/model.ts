/**
 * Automations (campañas multi-semana) — `FR-150`, `MOD-015`, `DATA-021`,
 * `DATA-022`, `AI-012`, `P3-AUTO-001…013`.
 *
 * Lo que la API y el worker tienen que decidir **igual** sin tocar la base: las
 * dos máquinas de estados, la validación de la configuración, el snapshot de
 * preferencias y las reglas duras de generación.
 *
 * ## Qué es un slot
 *
 * Un slot es **una pieza** publicada a **todas** las cuentas destino de la
 * campaña a la misma hora. Es la lectura que dejan `DATA-022` (`captionsByPlatform`
 * es un mapa por plataforma y `postIds[]` son varios posts) y la regla de
 * YouTube (todo destino YouTube exige `slideshowWeight = 0` **antes** de
 * generar: si un slot publicara sólo a una cuenta, la regla sería por slot).
 * Cantidad de slots = `perAccountPerDay × 7 × durationWeeks`.
 *
 * ## Uso personal (`D-06`)
 *
 * Sin cuotas ni billing: donde el PRD dice "cobra" o "reserva", en modo
 * personal se reserva y se registra pero no se corta. Las cuentas `warmed`
 * no existen (no hay marketplace): un destino es una conexión OAuth de la
 * marca **o** una red "planificada" sin conexión, que reserva un slot
 * planificado en el calendario y el barrido de publicación convierte en post
 * cuando la marca conecta esa red (`accountType: "planned"`, no está en el
 * PRD: es la forma de que una marca sin OAuth todavía pueda armar su campaña).
 */
import { DomainError } from "../errors.js";
import type { BlitzContentType } from "../content/content.js";
import { BLITZ_CONTENT_TYPES } from "../content/content.js";
import {
  TEXT_STYLE_PRESETS,
  type BlitzPreferences,
  type GenderFilter,
} from "../discovery/blitz-preferences.js";
import { isValidTimeZone, parseTimeOfDay } from "../scheduling/zoned-time.js";

// ───────────────────────────────────────────────────────────────────────────
// Límites — `DATA-021` (los mismos que `AUTOMATION_LIMITS` de `db`)
// ───────────────────────────────────────────────────────────────────────────

export const AUTOMATION_CONFIG_LIMITS = {
  nameMaxChars: 100,
  perAccountPerDayMin: 1,
  perAccountPerDayMax: 3,
  durationWeeksMin: 1,
  durationWeeksMax: 4,
  /** Temas libres de la campaña. Número nuestro: el PRD no los acota. */
  topicsMax: 10,
  topicMaxChars: 200,
  /** Horarios fijos por día: tantos como `perAccountPerDayMax`. */
  postingTimesMax: 3,
  /** Una cuenta por red y por campaña (decisión nuestra, ver `validateAccounts`). */
  accountsMax: 7,
} as const;

/**
 * Cuántas generaciones puede consumir una campaña: dos por slot (la primera y
 * un re-roll). El PRD dice que cada sugerencia y cada re-roll *"consume cuota
 * de la campaña"* pero no da el número. En modo personal se registra y no se
 * corta; en `standard`, un re-roll sin cuota se rechaza.
 */
export const AUTOMATION_GENERATIONS_PER_SLOT = 2;

/**
 * Cuántas veces se reintenta la copy de un slot cuando sale repetida antes de
 * darlo por `FAILED_GEN` con `no_unique_content`. Cada intento consume cuota.
 */
export const AUTOMATION_DEDUP_ATTEMPTS = 3;

// ───────────────────────────────────────────────────────────────────────────
// Estados — `FR-150` (normativo)
// ───────────────────────────────────────────────────────────────────────────

export const AUTOMATION_STATUSES = [
  "DRAFT",
  "GENERATING",
  "REVIEW",
  "BUILDING",
  "ACTIVE",
  "COMPLETED",
  "CANCELLED",
  "FAILED",
] as const;
export type AutomationStatus = (typeof AUTOMATION_STATUSES)[number];

export const AUTOMATION_SLOT_STATUSES = [
  "PENDING_GEN",
  "GENERATING",
  "READY",
  "REROLLING",
  "FAILED_GEN",
  "QUEUED_BUILD",
  "BUILDING",
  "SCHEDULED",
  "FAILED",
  "CANCELLED",
] as const;
export type AutomationSlotStatus = (typeof AUTOMATION_SLOT_STATUSES)[number];

export const AUTOMATION_SLOT_FAILURE_REASONS = [
  "no_unique_content",
  "no_demo_video",
] as const;
export type AutomationSlotFailureReason =
  (typeof AUTOMATION_SLOT_FAILURE_REASONS)[number];

/**
 * `DRAFT → GENERATING → REVIEW → BUILDING → ACTIVE → COMPLETED` (o
 * `CANCELLED` / `FAILED`).
 *
 * Lo que el PRD no dibuja y se decide acá:
 * - `GENERATING → FAILED`: la generación no pudo ni empezar (sin LLM, estado
 *   del workspace imposible). Una campaña cuyos slots fallan uno por uno **no**
 *   es `FAILED`: llega a `REVIEW` con menos slots (`AI-012`: *"entrega menos
 *   posts"*), y ahí se puede re-rollar.
 * - `BUILDING → FAILED`: todos los builds fallaron.
 * - Cancelar vale desde `GENERATING` en adelante mientras la campaña esté viva;
 *   una `DRAFT` no se cancela, se borra.
 */
const AUTOMATION_TRANSITIONS: Readonly<
  Record<AutomationStatus, readonly AutomationStatus[]>
> = {
  DRAFT: ["GENERATING"],
  GENERATING: ["REVIEW", "FAILED", "CANCELLED"],
  REVIEW: ["BUILDING", "CANCELLED"],
  BUILDING: ["ACTIVE", "FAILED", "CANCELLED"],
  ACTIVE: ["COMPLETED", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
  FAILED: [],
};

const SLOT_TRANSITIONS: Readonly<
  Record<AutomationSlotStatus, readonly AutomationSlotStatus[]>
> = {
  PENDING_GEN: ["GENERATING", "CANCELLED"],
  // `PENDING_GEN` otra vez: un worker que murió a mitad de la copia.
  GENERATING: ["READY", "FAILED_GEN", "PENDING_GEN", "CANCELLED"],
  // `FAILED` desde `READY`: al lanzar, la media del slot ya no existe.
  READY: ["REROLLING", "QUEUED_BUILD", "FAILED", "CANCELLED"],
  REROLLING: ["READY", "FAILED_GEN", "CANCELLED"],
  FAILED_GEN: ["REROLLING", "CANCELLED"],
  QUEUED_BUILD: ["BUILDING", "SCHEDULED", "FAILED", "CANCELLED"],
  BUILDING: ["SCHEDULED", "FAILED", "CANCELLED"],
  SCHEDULED: ["CANCELLED"],
  FAILED: [],
  CANCELLED: [],
};

export function canTransitionAutomation(
  from: AutomationStatus,
  to: AutomationStatus,
): boolean {
  return AUTOMATION_TRANSITIONS[from].includes(to);
}

export function canTransitionSlot(
  from: AutomationSlotStatus,
  to: AutomationSlotStatus,
): boolean {
  return SLOT_TRANSITIONS[from].includes(to);
}

export function assertAutomationTransition(
  from: AutomationStatus,
  to: AutomationStatus,
): void {
  if (!canTransitionAutomation(from, to)) {
    throw new DomainError(
      "invalid_state",
      `An automation can't go from ${from} to ${to}.`,
      { from, to },
    );
  }
}

export function assertSlotTransition(
  from: AutomationSlotStatus,
  to: AutomationSlotStatus,
): void {
  if (!canTransitionSlot(from, to)) {
    throw new DomainError("invalid_state", `A slot can't go from ${from} to ${to}.`, {
      from,
      to,
    });
  }
}

/** Terminales: nada más les pasa. */
export function isTerminalAutomation(status: AutomationStatus): boolean {
  return AUTOMATION_TRANSITIONS[status].length === 0;
}

/** `delete_automation` se rechaza mientras esté `BUILDING` o `ACTIVE` (`F-219`). */
export function canDeleteAutomation(status: AutomationStatus): boolean {
  return status !== "BUILDING" && status !== "ACTIVE";
}

/** La configuración se bloquea al empezar a generar (`FR-150`). */
export function isConfigEditable(status: AutomationStatus): boolean {
  return status === "DRAFT";
}

/** Slots que todavía se están generando: bloquean el launch. */
export const GENERATING_SLOT_STATUSES: readonly AutomationSlotStatus[] = [
  "PENDING_GEN",
  "GENERATING",
  "REROLLING",
];

// ───────────────────────────────────────────────────────────────────────────
// Destinos
// ───────────────────────────────────────────────────────────────────────────

/** Las redes de la estrategia (`D-09`). Mismas que `STRATEGY_NETWORKS`. */
export const AUTOMATION_PLATFORMS = [
  "instagram",
  "tiktok",
  "x",
  "threads",
  "facebook",
  "youtube",
  "linkedin",
] as const;
export type AutomationPlatform = (typeof AUTOMATION_PLATFORMS)[number];

export type AutomationAccount =
  | {
      readonly platform: AutomationPlatform;
      readonly accountType: "oauth";
      readonly connectionId: string;
    }
  | {
      readonly platform: AutomationPlatform;
      /** Sin conexión todavía: reserva un slot planificado (ver la cabecera). */
      readonly accountType: "planned";
    };

/** Lo que se sabe de una conexión de la marca para validar un destino. */
export interface ConnectionFact {
  readonly id: string;
  readonly platform: string;
  readonly active: boolean;
}

export type AccountProblem =
  | { readonly kind: "duplicate_platform"; readonly platform: AutomationPlatform }
  | { readonly kind: "connection_not_found"; readonly platform: AutomationPlatform }
  | {
      readonly kind: "connection_platform_mismatch";
      readonly platform: AutomationPlatform;
    }
  | { readonly kind: "connection_inactive"; readonly platform: AutomationPlatform };

/**
 * Problemas de los destinos contra las conexiones de la marca.
 *
 * **Una cuenta por red** es decisión nuestra: el barrido de publicación y el
 * `FR-060` resuelven "la conexión de la red", y el calendario planificado
 * reserva por (pieza, red). Dos cuentas de Instagram en la misma campaña
 * publicarían la misma pieza dos veces en la misma red, que es justo lo que
 * las guardas anti-bot evitan.
 *
 * `connection_inactive` no bloquea guardar (una conexión se puede reconectar
 * antes del launch); sí es un gate del launch.
 */
export function accountProblems(
  accounts: readonly AutomationAccount[],
  connections: readonly ConnectionFact[],
): AccountProblem[] {
  const problems: AccountProblem[] = [];
  const seen = new Set<string>();
  for (const account of accounts) {
    if (seen.has(account.platform)) {
      problems.push({ kind: "duplicate_platform", platform: account.platform });
      continue;
    }
    seen.add(account.platform);
    if (account.accountType !== "oauth") continue;
    const connection = connections.find((c) => c.id === account.connectionId);
    if (connection === undefined) {
      problems.push({ kind: "connection_not_found", platform: account.platform });
    } else if (connection.platform !== account.platform) {
      problems.push({ kind: "connection_platform_mismatch", platform: account.platform });
    } else if (!connection.active) {
      problems.push({ kind: "connection_inactive", platform: account.platform });
    }
  }
  return problems;
}

const PLATFORM_SET: ReadonlySet<string> = new Set(AUTOMATION_PLATFORMS);

/** Lee `automations.accounts` (`jsonb`). `null` si algo no tiene la forma. */
export function parseAutomationAccounts(raw: unknown): AutomationAccount[] | null {
  if (!Array.isArray(raw)) return null;
  const out: AutomationAccount[] = [];
  for (const item of raw as unknown[]) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return null;
    const r = item as Record<string, unknown>;
    const platform = r["platform"];
    if (typeof platform !== "string" || !PLATFORM_SET.has(platform)) return null;
    const p = platform as AutomationPlatform;
    if (r["accountType"] === "planned") {
      out.push({ platform: p, accountType: "planned" });
    } else if (r["accountType"] === "oauth" && typeof r["connectionId"] === "string") {
      out.push({ platform: p, accountType: "oauth", connectionId: r["connectionId"] });
    } else {
      return null;
    }
  }
  return out;
}

export function platformsOf(
  accounts: readonly AutomationAccount[],
): readonly AutomationPlatform[] {
  return [...new Set(accounts.map((a) => a.platform))];
}

export function hasYouTubeDestination(accounts: readonly AutomationAccount[]): boolean {
  return accounts.some((a) => a.platform === "youtube");
}

// ───────────────────────────────────────────────────────────────────────────
// `prefsSnapshot` — `F-212`, `P3-AUTO-003`
// ───────────────────────────────────────────────────────────────────────────

/**
 * Las preferencias **congeladas** de la campaña: las de Blitz de la marca al
 * crearla, más lo que el wizard cambió encima, más los temas. La generación
 * lee **sólo esto** (`AI-012`: *"cambiar las preferencias del workspace no
 * altera una campaña existente"*).
 */
export interface AutomationPrefsSnapshot extends BlitzPreferences {
  /** Temas libres de la campaña; un slot usa uno por vuelta (ver `topicForSlot`). */
  readonly topics: readonly string[];
}

/** Lo que el wizard puede pisar sobre las preferencias de la marca. */
export type AutomationPrefsOverrides = {
  readonly [
    K in
      | "slideshowWeight"
      | "wallOfTextWeight"
      | "greenScreenWeight"
      | "videoHookWeight"
      | "remixPercentage"
      | "ownMediaPercentage"
      | "mentionBusinessPercentage"
      | "influencerChance"
      | "angleWeights"
      | "textStyleWeights"
      | "topics"
  ]?: AutomationPrefsSnapshot[K] | undefined;
};

/**
 * El snapshot: copia (no referencia) de las preferencias de la marca con los
 * cambios del wizard. Devuelve objetos nuevos para que nadie pueda mutar el de
 * la marca a través del de la campaña.
 */
export function buildPrefsSnapshot(
  brand: BlitzPreferences,
  overrides: AutomationPrefsOverrides = {},
): AutomationPrefsSnapshot {
  const snapshot: AutomationPrefsSnapshot = {
    slideshowWeight: overrides.slideshowWeight ?? brand.slideshowWeight,
    wallOfTextWeight: overrides.wallOfTextWeight ?? brand.wallOfTextWeight,
    greenScreenWeight: overrides.greenScreenWeight ?? brand.greenScreenWeight,
    videoHookWeight: overrides.videoHookWeight ?? brand.videoHookWeight,
    remixPercentage: overrides.remixPercentage ?? brand.remixPercentage,
    ownMediaPercentage: overrides.ownMediaPercentage ?? brand.ownMediaPercentage,
    mentionBusinessPercentage:
      overrides.mentionBusinessPercentage ?? brand.mentionBusinessPercentage,
    influencerChance: overrides.influencerChance ?? brand.influencerChance,
    smartTextPositioning: brand.smartTextPositioning,
    genderFilter: brand.genderFilter,
    angleWeights: { ...(overrides.angleWeights ?? brand.angleWeights) },
    textStyleWeights: { ...(overrides.textStyleWeights ?? brand.textStyleWeights) },
    topics: [...(overrides.topics ?? [])],
  };
  assertValidPrefsSnapshot(snapshot);
  return snapshot;
}

/** Aplica un cambio del wizard (sólo en `DRAFT`) sobre un snapshot existente. */
export function patchPrefsSnapshot(
  current: AutomationPrefsSnapshot,
  overrides: AutomationPrefsOverrides,
): AutomationPrefsSnapshot {
  return buildPrefsSnapshot(current, {
    ...overrides,
    topics: overrides.topics ?? current.topics,
  });
}

const MIX_KEYS = [
  ["slideshow", "slideshowWeight"],
  ["wall-of-text", "wallOfTextWeight"],
  ["green-screen", "greenScreenWeight"],
  ["video-hook", "videoHookWeight"],
] as const satisfies readonly (readonly [BlitzContentType, keyof BlitzPreferences])[];

/** Los pesos del mix por tipo. */
export function contentMixOf(
  prefs: Pick<
    BlitzPreferences,
    "slideshowWeight" | "wallOfTextWeight" | "greenScreenWeight" | "videoHookWeight"
  >,
): Readonly<Record<BlitzContentType, number>> {
  return {
    slideshow: prefs.slideshowWeight,
    "wall-of-text": prefs.wallOfTextWeight,
    "green-screen": prefs.greenScreenWeight,
    "video-hook": prefs.videoHookWeight,
  };
}

/**
 * Los tipos que la campaña puede producir: **peso > 0**. Un tipo con peso 0
 * queda **excluido** y nunca es fallback (`AI-012`, regla dura, `P3-AUTO-005`).
 */
export function campaignContentTypes(
  prefs: Pick<
    BlitzPreferences,
    "slideshowWeight" | "wallOfTextWeight" | "greenScreenWeight" | "videoHookWeight"
  >,
): readonly BlitzContentType[] {
  const mix = contentMixOf(prefs);
  return BLITZ_CONTENT_TYPES.filter((t) => mix[t] > 0);
}

function isPercentage(n: number): boolean {
  return Number.isFinite(n) && n >= 0 && n <= 100;
}

/**
 * La forma del snapshot. Los cuatro pesos son enteros 0–100 que suman 100
 * (como los sliders de Blitz) **o** 0: todo en 0 se puede guardar en `DRAFT`
 * y es lo que dispara `AUTOMATION_NO_CONTENT_TYPE_SELECTED` al generar.
 */
export function assertValidPrefsSnapshot(snapshot: AutomationPrefsSnapshot): void {
  const bad = (field: string, message: string): never => {
    throw new DomainError("out_of_range", message, { field });
  };
  let sum = 0;
  for (const [, key] of MIX_KEYS) {
    const value = snapshot[key] as number;
    if (!Number.isInteger(value) || value < 0 || value > 100)
      bad(key, `${key} must be an integer between 0 and 100.`);
    sum += value;
  }
  if (sum !== 0 && sum !== 100) bad("contentMix", "The content mix must add up to 100.");
  for (const key of [
    "remixPercentage",
    "ownMediaPercentage",
    "mentionBusinessPercentage",
    "influencerChance",
  ] as const) {
    if (!isPercentage(snapshot[key])) bad(key, `${key} must be between 0 and 100.`);
  }
  for (const [id, w] of Object.entries(snapshot.angleWeights)) {
    if (!Number.isFinite(w) || w < 0)
      bad(`angleWeights.${id}`, "Angle weights must be ≥ 0.");
  }
  for (const [preset, w] of Object.entries(snapshot.textStyleWeights)) {
    if (!(TEXT_STYLE_PRESETS as readonly string[]).includes(preset))
      bad(`textStyleWeights.${preset}`, `Unknown caption style ${preset}.`);
    if (!Number.isFinite(w) || w < 0)
      bad(`textStyleWeights.${preset}`, "Caption style weights must be ≥ 0.");
  }
  if (snapshot.topics.length > AUTOMATION_CONFIG_LIMITS.topicsMax)
    bad("topics", `Up to ${String(AUTOMATION_CONFIG_LIMITS.topicsMax)} topics.`);
  for (const topic of snapshot.topics) {
    if (topic.trim() === "" || topic.length > AUTOMATION_CONFIG_LIMITS.topicMaxChars)
      bad("topics", "Each topic must be 1–200 characters.");
  }
}

const GENDER_FILTERS: readonly GenderFilter[] = ["man", "woman", null];

/**
 * Lee un snapshot guardado (`jsonb`). `null` si no tiene la forma: un snapshot
 * ilegible no se "repara" con defaults, porque eso sería generar con
 * preferencias que nadie eligió.
 */
export function parsePrefsSnapshot(raw: unknown): AutomationPrefsSnapshot | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const num = (k: string): number | null => {
    const v = r[k];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };
  const record = (k: string): Record<string, number> | null => {
    const v = r[k];
    if (v === undefined || v === null) return {};
    if (typeof v !== "object" || Array.isArray(v)) return null;
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(v as Record<string, unknown>)) {
      if (typeof value !== "number" || !Number.isFinite(value)) return null;
      out[key] = value;
    }
    return out;
  };
  const fields = [
    "slideshowWeight",
    "wallOfTextWeight",
    "greenScreenWeight",
    "videoHookWeight",
    "remixPercentage",
    "ownMediaPercentage",
    "mentionBusinessPercentage",
    "influencerChance",
  ] as const;
  const values: Partial<Record<(typeof fields)[number], number>> = {};
  for (const f of fields) {
    const v = num(f);
    if (v === null) return null;
    values[f] = v;
  }
  const angleWeights = record("angleWeights");
  const textStyleWeights = record("textStyleWeights");
  if (angleWeights === null || textStyleWeights === null) return null;
  const gender = r["genderFilter"] ?? null;
  if (!GENDER_FILTERS.includes(gender as GenderFilter)) return null;
  const topicsRaw = r["topics"] ?? [];
  if (!Array.isArray(topicsRaw) || !topicsRaw.every((t) => typeof t === "string"))
    return null;
  const snapshot: AutomationPrefsSnapshot = {
    slideshowWeight: values.slideshowWeight ?? 0,
    wallOfTextWeight: values.wallOfTextWeight ?? 0,
    greenScreenWeight: values.greenScreenWeight ?? 0,
    videoHookWeight: values.videoHookWeight ?? 0,
    remixPercentage: values.remixPercentage ?? 0,
    ownMediaPercentage: values.ownMediaPercentage ?? 0,
    mentionBusinessPercentage: values.mentionBusinessPercentage ?? 0,
    influencerChance: values.influencerChance ?? 0,
    smartTextPositioning: r["smartTextPositioning"] !== false,
    genderFilter: gender as GenderFilter,
    angleWeights,
    textStyleWeights,
    topics: topicsRaw as string[],
  };
  try {
    assertValidPrefsSnapshot(snapshot);
  } catch {
    return null;
  }
  return snapshot;
}

// ───────────────────────────────────────────────────────────────────────────
// Configuración — `F-211`
// ───────────────────────────────────────────────────────────────────────────

export interface AutomationSchedulingConfig {
  readonly perAccountPerDay: number;
  readonly durationWeeks: number;
  readonly timezone: string;
  /** `HH:MM` locales. `null` = los de la estrategia de la marca. */
  readonly postingTimes: readonly string[] | null;
}

/** Rangos de `DATA-021` y forma de los horarios. Lanza `out_of_range`. */
export function assertValidSchedulingConfig(config: AutomationSchedulingConfig): void {
  const L = AUTOMATION_CONFIG_LIMITS;
  if (
    !Number.isInteger(config.perAccountPerDay) ||
    config.perAccountPerDay < L.perAccountPerDayMin ||
    config.perAccountPerDay > L.perAccountPerDayMax
  ) {
    throw new DomainError("out_of_range", "posts per account per day must be 1–3.", {
      field: "perAccountPerDay",
    });
  }
  if (
    !Number.isInteger(config.durationWeeks) ||
    config.durationWeeks < L.durationWeeksMin ||
    config.durationWeeks > L.durationWeeksMax
  ) {
    throw new DomainError("out_of_range", "Campaign length must be 1–4 weeks.", {
      field: "durationWeeks",
    });
  }
  if (!isValidTimeZone(config.timezone)) {
    throw new DomainError("out_of_range", "timezone must be an IANA time zone.", {
      field: "timezone",
    });
  }
  if (config.postingTimes !== null) {
    if (config.postingTimes.length > L.postingTimesMax) {
      throw new DomainError("out_of_range", "Up to 3 posting times.", {
        field: "postingTimes",
      });
    }
    for (const t of config.postingTimes) {
      if (parseTimeOfDay(t) === null) {
        throw new DomainError("out_of_range", `${t} is not a valid time (HH:MM).`, {
          field: "postingTimes",
        });
      }
    }
  }
}

/** Slots de la campaña: `perAccountPerDay × 7 × durationWeeks`. */
export function automationSlotCount(
  config: Pick<AutomationSchedulingConfig, "perAccountPerDay" | "durationWeeks">,
): number {
  return config.perAccountPerDay * 7 * config.durationWeeks;
}

/** Tope de generaciones de la campaña. Ver {@link AUTOMATION_GENERATIONS_PER_SLOT}. */
export function automationGenerationQuota(slotCount: number): number {
  return slotCount * AUTOMATION_GENERATIONS_PER_SLOT;
}

// ───────────────────────────────────────────────────────────────────────────
// Reglas duras de generación — `FR-150`, `AI-012`, `P3-AUTO-011`
// ───────────────────────────────────────────────────────────────────────────

export const AUTOMATION_GENERATION_ERRORS = [
  /** `FR-150`, literal: todos los pesos a 0. */
  "AUTOMATION_NO_CONTENT_TYPE_SELECTED",
  /** `FR-150`, literal: `video-hook` con peso y sin demo video. */
  "AUTOMATION_VIDEO_HOOK_NEEDS_DEMO_VIDEO",
  /**
   * Un destino YouTube con `slideshowWeight > 0`. El PRD pide bloquear con
   * *"el error exacto"* pero no lo nombra; el código es nuestro.
   */
  "AUTOMATION_YOUTUBE_REQUIRES_NO_SLIDESHOW",
  /** Sin destinos no hay a quién generarle captions. Nuestro. */
  "AUTOMATION_NO_DESTINATIONS",
  /** Un tipo con peso > 0 sin media en el Media Bank. Nuestro. */
  "AUTOMATION_CONTENT_TYPE_NEEDS_MEDIA",
] as const;
export type AutomationGenerationError = (typeof AUTOMATION_GENERATION_ERRORS)[number];

export class AutomationGenerationBlocked extends Error {
  override readonly name = "AutomationGenerationBlocked";
  constructor(
    readonly code: AutomationGenerationError,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
  }
}

export interface GenerationPrecheck {
  readonly accounts: readonly AutomationAccount[];
  readonly prefs: AutomationPrefsSnapshot;
  /** Formatos que el Media Bank puede construir hoy (`formatsWithMedia`). */
  readonly availableFormats: readonly BlitzContentType[];
}

/**
 * Lo que bloquea `generate` **antes** de crear un solo slot. En este orden:
 * sin destinos, sin tipo, YouTube con slideshow, video-hook sin demo, otro tipo
 * sin media. Lanza {@link AutomationGenerationBlocked}.
 */
export function assertGenerationAllowed(input: GenerationPrecheck): void {
  if (input.accounts.length === 0) {
    throw new AutomationGenerationBlocked(
      "AUTOMATION_NO_DESTINATIONS",
      "Add at least one account before generating.",
    );
  }
  const types = campaignContentTypes(input.prefs);
  if (types.length === 0) {
    throw new AutomationGenerationBlocked(
      "AUTOMATION_NO_CONTENT_TYPE_SELECTED",
      "Select at least one content type in the content mix.",
    );
  }
  if (hasYouTubeDestination(input.accounts) && input.prefs.slideshowWeight > 0) {
    throw new AutomationGenerationBlocked(
      "AUTOMATION_YOUTUBE_REQUIRES_NO_SLIDESHOW",
      "YouTube destinations require the slideshow weight to be 0: slideshows can't be published as Shorts.",
      { slideshowWeight: input.prefs.slideshowWeight },
    );
  }
  if (types.includes("video-hook") && !input.availableFormats.includes("video-hook")) {
    throw new AutomationGenerationBlocked(
      "AUTOMATION_VIDEO_HOOK_NEEDS_DEMO_VIDEO",
      "Hook demo videos need a demo video in your Media Bank (category hook-video).",
    );
  }
  const missing = types.filter((t) => !input.availableFormats.includes(t));
  if (missing.length > 0) {
    throw new AutomationGenerationBlocked(
      "AUTOMATION_CONTENT_TYPE_NEEDS_MEDIA",
      `Your Media Bank has no media for: ${missing.join(", ")}. Add some or set their weight to 0.`,
      { contentTypes: missing },
    );
  }
}

/**
 * ¿Se puede forzar este tipo en un re-roll? Sólo tipos con peso > 0 en el
 * snapshot (peso 0 está excluido, no es fallback) y nunca `slideshow` si la
 * campaña publica a YouTube (`FR-150`, re-roll).
 */
export function rerollTypeProblem(
  contentType: BlitzContentType,
  prefs: AutomationPrefsSnapshot,
  accounts: readonly AutomationAccount[],
): "excluded_type" | "youtube_slideshow" | null {
  if (contentType === "slideshow" && hasYouTubeDestination(accounts))
    return "youtube_slideshow";
  if (!campaignContentTypes(prefs).includes(contentType)) return "excluded_type";
  return null;
}

/** El tema de un slot: los temas de la campaña en ronda, o ninguno. */
export function topicForSlot(
  prefs: Pick<AutomationPrefsSnapshot, "topics">,
  slotIndex: number,
): string | undefined {
  if (prefs.topics.length === 0) return undefined;
  return prefs.topics[slotIndex % prefs.topics.length];
}

/**
 * Las preferencias con el tipo forzado: el tipo al 100 %, los demás en 0. Es
 * como `planPromptSuggestion` fuerza el formato, pero **conserva los ángulos**:
 * en una campaña el ángulo sigue siendo parte del mix.
 */
export function forcedTypePreferences(
  prefs: BlitzPreferences,
  contentType: BlitzContentType,
): BlitzPreferences {
  return {
    ...prefs,
    slideshowWeight: contentType === "slideshow" ? 100 : 0,
    wallOfTextWeight: contentType === "wall-of-text" ? 100 : 0,
    greenScreenWeight: contentType === "green-screen" ? 100 : 0,
    videoHookWeight: contentType === "video-hook" ? 100 : 0,
  };
}

/**
 * Los ángulos que el planificador puede usar: los activos **que el snapshot
 * pesa**. Un ángulo creado después del snapshot no entra (el snapshot está
 * congelado); uno borrado después, tampoco (ya no existe). Si ninguno queda,
 * la pieza sale sin ángulo en vez de gritar `invalid_state`.
 */
export function snapshotAngleIds(
  prefs: Pick<BlitzPreferences, "angleWeights">,
  activeAngleIds: readonly string[],
): readonly string[] {
  return activeAngleIds.filter((id) => (prefs.angleWeights[id] ?? 0) > 0);
}
