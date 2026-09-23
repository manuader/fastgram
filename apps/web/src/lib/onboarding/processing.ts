/**
 * Paso 4 del onboarding — qué se sabe del análisis de cada fuente · `FR-010`
 * (PRD:748), `FR-011.2` (PRD:835), `FR-011.8`, §19.5.1. Tarea `P1-ONB-005`.
 *
 * ## Lo que la API sabe, y lo que el PRD pide que no sabe
 *
 * `FR-011.2` pide una *"lista de sub-pasos con check progresivo, específicos
 * del tipo de fuente"*. La API publica **el estado de la fuente** (`pending`,
 * `analyzing`, `ready`, `partial`, `failed`, `stale`) y nada por debajo: no hay
 * columna, campo ni endpoint con el sub-paso en curso. Así que:
 *
 * · Los sub-pasos se **listan** (son del PRD, y dicen qué va a pasar), pero
 *   **no se tildan**. Tildar `Reading profile` a los 5 s porque sí sería el
 *   progreso inventado que hace que nadie crea la barra la próxima vez.
 * · El PRD sólo da los de **Instagram** (Fase 1, D-03). Para las otras cuatro
 *   plataformas, `website` y `other_url` no hay lista, y no se escribe una.
 *
 * ## El caso real hoy: `pending` para siempre
 *
 * El handler de `brand-source-analysis` existe pero **sólo se monta** con
 * extractor, LLM y retención configurados (`apps/worker/src/handlers.ts`); sin
 * eso —hoy, en todo entorno— toda fuente creada se queda en `pending`. La pantalla no puede saber que no hay worker —sólo ve una fuente
 * encolada—, pero sí puede no mentir sobre lo que ve: pasado
 * {@link ANALYSIS_EXPECTED_MS} en `pending` dice que **no empezó**, y que se
 * puede seguir con el alta (§19.5.1: *"ninguno bloquea el alta"*). No dice
 * "seguimos trabajando", porque nadie está trabajando.
 */
import type {
  BrandSource,
  BrandSourceFailureReason,
  BrandSourceStatus,
  BrandSourceType,
  OnboardingState,
} from "@fastgram/contracts";
import type { CopyKey, MessageVars } from "../i18n/t";
import { tw } from "../i18n/t";
import { BUILD_POLL_INTERVAL_MS } from "../library/content";
import { SOURCE_TYPE_COPY } from "../brand/source-types";

/**
 * Cadencia del polling del análisis.
 *
 * **El PRD no la fija para el análisis de marca.** NFR-002 (PRD:2961) da 10 s
 * *para builds*; se reusa la misma constante —no un `10_000` suelto— para que
 * el día que alguien la cambie, cambie en las dos pantallas y no en una.
 */
export const BRAND_ANALYSIS_POLL_INTERVAL_MS = BUILD_POLL_INTERVAL_MS;

/**
 * FR-011.12 criterio 9 (PRD:987): *"El tiempo desde `Analyse` hasta perfil
 * listo es < 3 min … o devuelve `partial`"*. Pasado esto sin terminar, algo no
 * va como el PRD promete y la pantalla lo dice.
 */
export const ANALYSIS_EXPECTED_MS = 3 * 60_000;

const IN_PROGRESS: ReadonlySet<BrandSourceStatus> = new Set(["pending", "analyzing"]);

export function isInProgress(status: BrandSourceStatus): boolean {
  return IN_PROGRESS.has(status);
}

/**
 * `refetchInterval` de `GET /onboarding`: 10 s mientras alguna fuente siga en
 * curso, y nada cuando todas terminaron. Sin datos todavía, nada: la primera
 * carga la hace el montaje, no el reloj.
 */
export function onboardingPollInterval(
  state: OnboardingState | undefined,
): number | false {
  if (state === undefined) return false;
  return state.sources.some((s) => isInProgress(s.status))
    ? BRAND_ANALYSIS_POLL_INTERVAL_MS
    : false;
}

/**
 * Sub-pasos por tipo · FR-011.2 (PRD:835). Sólo Instagram tiene lista en el
 * PRD; `Transcribing videos` es de Fase 2 y no va.
 */
export const ANALYSIS_SUBSTEPS: Readonly<
  Partial<Record<BrandSourceType, readonly CopyKey[]>>
> = {
  instagram: [
    "brand.substep.readingProfile",
    "brand.substep.readingPosts",
    "brand.substep.readingOnScreenText",
    "brand.substep.buildingProfile",
  ],
};

export interface Notice {
  readonly key: CopyKey;
  readonly vars?: MessageVars;
  /** `true` si es un problema (se pinta como tal), `false` si es un aviso. */
  readonly problem: boolean;
}

/**
 * `failureReason` → copy de §19.5.1. `unsupported_platform` no tiene copy en el
 * PRD; `already_registered` usa el neutro de `ERR-B06` (ver `packages/ui`).
 *
 * `unsupported_platform` es la degradación a D de `FR-011.4` (el worker la
 * escribe con `acquisitionTier: D_assisted`), y el PRD pide ofrecer ahí la
 * ayuda asistida. **No se ofrece porque no hay endpoint que la reciba** — ver
 * la nota de la clave en `messages.ts`. Tampoco `private` e
 * `insufficient_content`: sus literales (ERR-B05, ERR-E13) ya piden «paste your
 * bio» / «describe your brand», que hoy no tienen adónde ir.
 */
const FAILURE_COPY: Readonly<Record<BrandSourceFailureReason, CopyKey>> = {
  not_found: "error.brand.handleNotFound.title", // ERR-B04
  private: "error.brand.privateProfile.title", // ERR-B05
  insufficient_content: "empty.socialSource.title", // ERR-E13 / FR-011.9
  rate_limited: "error.brand.backlogged.title", // ERR-B08
  provider_unavailable: "error.brand.platformDown.title", // ERR-B07
  unsupported_platform: "brand.failure.unsupportedPlatform", // nuevo
  already_registered: "error.brand.alreadyConnected.title", // ERR-B06
};

function varsOf(source: BrandSource): MessageVars {
  return {
    handle: source.handle ?? "",
    platform: tw(SOURCE_TYPE_COPY[source.sourceType]),
  };
}

/**
 * Qué se dice debajo de una fuente, además de su badge.
 *
 * `now` entra por parámetro para que la función sea pura: el reloj lo pone
 * quien dibuja (`useNow`), y el test lo fija.
 */
export function sourceNotice(source: BrandSource, now: number): Notice | null {
  switch (source.status) {
    case "pending":
      // `createdAt`: una fuente en `pending` no cambió desde que se creó.
      return now - source.createdAt >= ANALYSIS_EXPECTED_MS
        ? { key: "brand.pendingTooLong", problem: false }
        : null;
    case "analyzing":
      // `updatedAt`: es cuando pasó a `analyzing`. Acá sí hay alguien
      // trabajando, así que el copy de ERR-L09 es cierto.
      return now - source.updatedAt >= ANALYSIS_EXPECTED_MS
        ? { key: "loading.aiStudioSlow", problem: false }
        : null;
    case "partial":
      return { key: "error.brand.thinProfile.title", problem: false }; // ERR-B09
    case "failed": {
      const reason = source.failureReason ?? null;
      if (reason === null) return { key: "common.somethingWentWrong", problem: true };
      return { key: FAILURE_COPY[reason], vars: varsOf(source), problem: true };
    }
    case "ready":
    case "stale":
      return null;
  }
}

/**
 * El estado del paso 4 en conjunto.
 *
 * · `empty` — no hay fuentes. Con la rama manual sin endpoint, un workspace
 *   sin fuentes no llega al paso 4 (la API lo retiene en `brand_source`), pero
 *   la pantalla no se rompe si llega.
 * · `analyzing` — alguna sigue en curso: `Analyzing company profile...`.
 * · `failed` — **todas** fallaron: la copy de `FR-010` (PRD:760).
 * · `done` — ninguna en curso y al menos una con perfil.
 */
export type ProcessingPhase = "empty" | "analyzing" | "failed" | "done";

export function processingPhase(sources: readonly BrandSource[]): ProcessingPhase {
  if (sources.length === 0) return "empty";
  if (sources.some((s) => isInProgress(s.status))) return "analyzing";
  if (sources.every((s) => s.status === "failed")) return "failed";
  return "done";
}
