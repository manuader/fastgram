/**
 * Ciclo de vida de una Brand Source — PRD `DATA-031`, `FR-011.7`, `FR-011.8`,
 * `AI-016`, §19.5.1.
 *
 *   pending → analyzing → ready | partial | failed
 *   ready → stale (a los 90 días) → analyzing (al refrescar)
 *
 * Tres reglas que el PRD marca y que cambian el comportamiento del producto:
 *
 * 1. **Un fallo de OCR degrada a `partial`, NO a `failed`** (`AI-016`,
 *    Reintentos). Es la regla que más fácil se implementa al revés, porque
 *    "el OCR falló" suena a error. Tratarlo como `failed` tira a la basura la
 *    bio, la categoría, los links y las 24 captions que sí se leyeron, y manda
 *    al usuario a la rama asistida teniendo ya casi todo el perfil. `partial`
 *    significa "hay perfil, con huecos marcados", y los huecos se preguntan.
 *
 * 2. **Ningún fallo de lectura bloquea el alta** (§19.5.1). `not_found`,
 *    `private` e `insufficient_content` degradan y siguen.
 *
 * 3. **Una cuenta borrada o suspendida después del análisis no borra el
 *    perfil de marca** (`FR-011.11`). El `CompanyProfile` ya está
 *    materializado y es dato del cliente; la fuente pasa a `failed` y se avisa
 *    sin bloquear nada.
 */
import { DomainError } from "../errors.js";
import { HARD_CAPS } from "../quota/plans.js";
import { assertCanAddBrandSource } from "../workspace/caps.js";
import { SOCIAL_SOURCE_TYPES, type CoreBrandSourceType } from "./source-input.js";

export const BRAND_SOURCE_STATUSES = [
  "pending",
  "analyzing",
  "ready",
  "partial",
  "failed",
  "stale",
] as const;
export type BrandSourceStatus = (typeof BRAND_SOURCE_STATUSES)[number];

/** `DATA-031.failureReason`. Enum cerrado: no se inventan motivos. */
export const BRAND_SOURCE_FAILURE_REASONS = [
  "not_found",
  "private",
  "insufficient_content",
  "rate_limited",
  "provider_unavailable",
  "unsupported_platform",
  "already_registered",
] as const;
export type BrandSourceFailureReason = (typeof BRAND_SOURCE_FAILURE_REASONS)[number];

/** `DATA-031`: `stale` a los 90 días. */
export const STALE_AFTER_DAYS = 90;
const DAY_MS = 86_400_000;

/** Ventana del límite de re-análisis. Ver `assertCanReanalyse`. */
export const REANALYSIS_WINDOW_HOURS = 24;

export interface BrandSource {
  readonly id: string;
  readonly companyId: string;
  readonly sourceType: CoreBrandSourceType;
  readonly handle: string;
  readonly canonicalUrl: string;
  readonly displayName?: string | undefined;
  readonly avatarUrl?: string | undefined;
  /** Exactamente una por workspace (`FR-011.6`). */
  readonly isPrimary: boolean;
  readonly status: BrandSourceStatus;
  readonly failureReason?: BrandSourceFailureReason | undefined;
  readonly lastAnalysedAt?: Date | undefined;
  /** Análisis dentro de la ventana actual. */
  readonly analysisCount: number;
  readonly analysisWindowStartedAt?: Date | undefined;
  readonly createdAt: Date;
}

// ───────────────────────────────────────────────────────────────────────────
// Alta
// ───────────────────────────────────────────────────────────────────────────

export interface CreateBrandSourceParams {
  readonly id: string;
  readonly companyId: string;
  readonly sourceType: CoreBrandSourceType;
  readonly handle: string;
  readonly canonicalUrl: string;
  readonly displayName?: string | undefined;
  /** Fuentes ya existentes en el workspace. Para el cap y para `isPrimary`. */
  readonly existingCount: number;
  /**
   * `true` si `(sourceType, handle)` ya está en **otro** workspace.
   * `DATA-031`: la unicidad es **global**, como la de `websiteUrl` en Fastlane.
   */
  readonly takenByAnotherWorkspace: boolean;
  readonly now: Date;
}

export function createBrandSource(params: CreateBrandSourceParams): BrandSource {
  assertCanAddBrandSource(params.existingCount);

  if (params.takenByAnotherWorkspace) {
    throw new DomainError(
      "conflict",
      "This profile is already connected to another workspace.",
      {
        code: "ERR-B06",
        reason: "already_registered" satisfies BrandSourceFailureReason,
        sourceType: params.sourceType,
      },
    );
  }

  return {
    id: params.id,
    companyId: params.companyId,
    sourceType: params.sourceType,
    handle: params.handle,
    canonicalUrl: params.canonicalUrl,
    displayName: params.displayName,
    // La primera fuente es la primaria. Un workspace sin primaria haría que
    // `FR-011.6` no pudiera desempatar nada.
    isPrimary: params.existingCount === 0,
    status: "pending",
    analysisCount: 0,
    createdAt: params.now,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Análisis
// ───────────────────────────────────────────────────────────────────────────

/**
 * Límite de re-análisis por fuente y día — `ERR-B11`, `FR-020`.
 *
 * **Ambigüedad del PRD, resuelta acá.** Dice "N por fuente y **día**" sin
 * decir si el día es natural o una ventana móvil. Se implementa como ventana
 * **móvil de 24 h desde el primer análisis de la ventana**, porque el día
 * natural permite 3 a las 23:59 y 3 más a las 00:01 — seis análisis en dos
 * minutos, que es precisamente lo que el límite existe para impedir. El
 * mensaje necesita las horas que faltan, y una ventana móvil las sabe; un día
 * natural también, así que la elección no se paga en copy.
 */
export function assertCanReanalyse(source: BrandSource, now: Date): void {
  const windowStart = source.analysisWindowStartedAt;
  if (windowStart === undefined) return;

  const windowEnd = windowStart.getTime() + REANALYSIS_WINDOW_HOURS * 3_600_000;
  if (now.getTime() >= windowEnd) return; // ventana vencida: contador a cero

  if (source.analysisCount >= HARD_CAPS.reanalysesPerSourcePerDay) {
    const hours = Math.max(1, Math.ceil((windowEnd - now.getTime()) / 3_600_000));
    throw new DomainError(
      "out_of_range",
      `You've refreshed this source recently. Try again in ${hours} hours.`,
      {
        code: "ERR-B11",
        sourceId: source.id,
        retryAfterHours: hours,
        cap: HARD_CAPS.reanalysesPerSourcePerDay,
      },
    );
  }
}

/** `pending | ready | partial | failed | stale` → `analyzing`. */
export function startAnalysis(source: BrandSource, now: Date): BrandSource {
  if (source.status === "analyzing") {
    throw new DomainError("conflict", "This source is already being analysed.", {
      sourceId: source.id,
    });
  }
  assertCanReanalyse(source, now);

  const windowStart = source.analysisWindowStartedAt;
  const windowExpired =
    windowStart === undefined ||
    now.getTime() >= windowStart.getTime() + REANALYSIS_WINDOW_HOURS * 3_600_000;

  return {
    ...source,
    status: "analyzing",
    failureReason: undefined,
    analysisCount: windowExpired ? 1 : source.analysisCount + 1,
    analysisWindowStartedAt: windowExpired ? now : windowStart,
  };
}

/**
 * `failed | ready | partial | stale | pending` → `analyzing`, **con el texto que
 * pegó el usuario** (tier D, `P1-BRAND-014`).
 *
 * A diferencia de {@link startAnalysis}, no aplica el cupo de re-análisis ni lo
 * consume: `ERR-B11` existe para no martillar a la plataforma con lecturas, y
 * acá no se lee ninguna plataforma. Lo que cuesta es una llamada al LLM, la
 * misma que en el alta. Sólo `social`: pegar la bio de una web no tiene sentido
 * (la web se lee sola) y `manual` es otra rama.
 */
export function startAssistedAnalysis(source: BrandSource): BrandSource {
  if (source.status === "analyzing") {
    throw new DomainError("conflict", "This source is already being analysed.", {
      sourceId: source.id,
    });
  }
  if (!(SOCIAL_SOURCE_TYPES as readonly string[]).includes(source.sourceType)) {
    throw new DomainError(
      "invalid_state",
      "Pasting your bio is only for social profiles.",
      { sourceId: source.id, sourceType: source.sourceType },
    );
  }
  return { ...source, status: "analyzing", failureReason: undefined };
}

export interface AnalysisOutcome {
  /**
   * `true` si el OCR (o el ASR en Fase 2) falló. **Degrada a `partial`, no
   * aborta** — `AI-016`.
   */
  readonly enrichmentFailed?: boolean | undefined;
  /**
   * `false` cuando quedaron campos sin señal suficiente. Produce `partial` y
   * dispara las preguntas de cierre de huecos (`ERR-B09`).
   */
  readonly allFieldsCovered: boolean;
}

/** `analyzing` → `ready` | `partial`. */
export function completeAnalysis(
  source: BrandSource,
  outcome: AnalysisOutcome,
  now: Date,
): BrandSource {
  if (source.status !== "analyzing") {
    throw new DomainError("invalid_state", "This source isn't being analysed.", {
      sourceId: source.id,
      status: source.status,
    });
  }
  const degraded = outcome.enrichmentFailed === true || !outcome.allFieldsCovered;
  return {
    ...source,
    status: degraded ? "partial" : "ready",
    failureReason: undefined,
    lastAnalysedAt: now,
  };
}

/**
 * `analyzing` → `failed`.
 *
 * Que una fuente falle **no** toca el `CompanyProfile`: `FR-011.11` dice que
 * el perfil de marca sobrevive a una cuenta suspendida o borrada, porque ya es
 * dato materializado del cliente. Por eso esta función sólo devuelve la
 * fuente y no tiene forma de tocar el perfil.
 */
export function failAnalysis(
  source: BrandSource,
  reason: BrandSourceFailureReason,
  now: Date,
): BrandSource {
  return { ...source, status: "failed", failureReason: reason, lastAnalysedAt: now };
}

// ───────────────────────────────────────────────────────────────────────────
// Staleness
// ───────────────────────────────────────────────────────────────────────────

export function isStale(source: BrandSource, now: Date): boolean {
  if (source.lastAnalysedAt === undefined) return false;
  if (source.status !== "ready" && source.status !== "partial") return false;
  return now.getTime() - source.lastAnalysedAt.getTime() >= STALE_AFTER_DAYS * DAY_MS;
}

/** El barrido de §9.5 #19. Idempotente: pasarlo dos veces no cambia nada. */
export function markStaleIfNeeded(source: BrandSource, now: Date): BrandSource {
  return isStale(source, now) ? { ...source, status: "stale" } : source;
}

// ───────────────────────────────────────────────────────────────────────────
// Primaria
// ───────────────────────────────────────────────────────────────────────────

/**
 * Cambia la primaria. Devuelve **todas** las fuentes: el invariante es del
 * conjunto, no de una fila, y por eso la firma no permite marcar una sin
 * desmarcar la otra.
 */
export function setPrimarySource(
  sources: readonly BrandSource[],
  primaryId: string,
): readonly BrandSource[] {
  if (!sources.some((s) => s.id === primaryId)) {
    throw new DomainError("not_found", "Brand source not found.", { primaryId });
  }
  return sources.map((s) => ({ ...s, isPrimary: s.id === primaryId }));
}

/** `FR-011.10`: sólo el owner puede eliminar la fuente primaria. */
export function assertCanRemoveSource(
  source: BrandSource,
  actorRole: "owner" | "member",
): void {
  if (source.isPrimary && actorRole !== "owner") {
    throw new DomainError(
      "invalid_state",
      "Only the workspace owner can remove the primary brand source.",
      { sourceId: source.id },
    );
  }
}
