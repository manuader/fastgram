/**
 * `BlitzPreferences` — PRD `FR-055`, `DATA-006`.
 *
 * Es el panel de control del motor de generación, y casi todo lo que valida
 * este archivo son reglas de **conjunto**, no de campo. Ésa es la parte que se
 * implementa mal: validar `slideshowWeight ∈ [0,100]` es fácil y no sirve de
 * nada, porque el error real es que los cuatro sumen 97.
 *
 * Dos reglas del PRD que parecen detalles y no lo son:
 *
 * 1. **Los cuatro pesos van juntos o ninguno**, y suman exactamente 100. Un
 *    PATCH parcial —"subime slideshow a 60"— es `400`. Si se aceptara, el
 *    servidor tendría que decidir a quién le quita los 15 puntos, y esa
 *    decisión no es suya: el usuario acabaría con un mix que no eligió.
 *
 * 2. **`influencerChance` es una tirada independiente por generación, no un
 *    ratio objetivo sobre un lote.** Con 50 % y diez sugerencias, cinco con
 *    influencer es lo esperado, no lo garantizado. Implementarlo como cuota
 *    ("van 4 de 10, fuerzo la quinta") produce un comportamiento que el
 *    usuario percibe como aleatorio de todas formas y que además hace que la
 *    sugerencia N dependa de la N-1 — con lo cual dos refills concurrentes
 *    dejan de ser equivalentes a uno secuencial.
 */
import { DomainError } from "../errors.js";
import { assertValidAngleWeights, type AngleWeights } from "../angles/angles.js";

/** Presets de estilo de caption — `FR-055`, valores válidos literales. */
export const TEXT_STYLE_PRESETS = [
  "tiktok-classic",
  "bold-impact",
  "snapchat",
  "white-box",
  "yellow-pop",
  "clean-karaoke",
  "script-playful",
] as const;
export type TextStylePreset = (typeof TEXT_STYLE_PRESETS)[number];

/** Los cuatro pesos del content mix. Van juntos o ninguno. */
export const CONTENT_MIX_WEIGHTS = [
  "slideshowWeight",
  "wallOfTextWeight",
  "greenScreenWeight",
  "videoHookWeight",
] as const;
export type ContentMixWeight = (typeof CONTENT_MIX_WEIGHTS)[number];

/** `FR-055`: `man` | `woman` | `null` en las preferencias. */
export type GenderFilter = "man" | "woman" | null;

/**
 * `Influencer.gender` usa **otro vocabulario** (`male` / `female`).
 *
 * El PRD lo aclara expresamente: no es una contradicción, son dos campos
 * distintos, y los dos literales se conservan porque los dos son observados.
 * La correspondencia la hace esta tabla, que es el único sitio donde los dos
 * vocabularios se tocan.
 */
export const GENDER_FILTER_TO_INFLUENCER: Readonly<Record<"man" | "woman", string>> = {
  man: "male",
  woman: "female",
};

export interface BlitzPreferences {
  readonly slideshowWeight: number;
  readonly wallOfTextWeight: number;
  readonly greenScreenWeight: number;
  readonly videoHookWeight: number;
  readonly remixPercentage: number;
  readonly ownMediaPercentage: number;
  readonly mentionBusinessPercentage: number;
  /** 0–100, **decimales aceptados**, default 50. */
  readonly influencerChance: number;
  readonly smartTextPositioning: boolean;
  readonly genderFilter: GenderFilter;
  readonly angleWeights: AngleWeights;
  /** `{}` desactiva el mix de estilos. */
  readonly textStyleWeights: Readonly<Record<string, number>>;
}

export const DEFAULT_INFLUENCER_CHANCE = 50;
export const DEFAULT_SMART_TEXT_POSITIONING = true;
/** `settingsApplication.targetQueuedItems` — §AI-002: la cola objetivo. */
export const TARGET_QUEUED_ITEMS = 5;

/**
 * Defaults sintetizados — `DATA-006`: *"Sintetiza defaults si no existe fila"*.
 *
 * **Sólo dos de estos números están en el PRD**: `influencerChance` 50
 * (`FR-055`) y `smartTextPositioning` true (`AI-014`). Los demás son asunciones
 * documentadas:
 *  - los cuatro pesos de formato van 25/25/25/25 porque la única restricción del
 *    PRD es que sumen 100, y el reparto par es la única elección que no
 *    privilegia un formato sin que nadie lo haya pedido;
 *  - los tres porcentajes arrancan en 0 porque son opt-in: remixar contenido
 *    ajeno o mencionar el negocio son decisiones del usuario, no defaults
 *    razonables.
 *
 * **Están acá y no en la ruta porque hay dos consumidores, no uno.** La API los
 * necesita para responder `GET /blitz/preferences` sin fila, y el worker para
 * poder rellenar la cola de un workspace recién creado — que es justo el que
 * todavía no tiene fila, y el que más necesita que la cola no esté vacía. Un
 * proceso no puede importar del otro, así que el único sitio donde la lista
 * existe una sola vez es `core`.
 *
 * `angleWeights` y `textStyleWeights` **no** están acá: el primero depende de
 * los ángulos activos del workspace (se arma con `reconcileAngleWeights`) y el
 * segundo vacío significa "mix desactivado", que es el default y ya lo dice el
 * tipo.
 */
export const DEFAULT_BLITZ_PREFERENCES = {
  slideshowWeight: 25,
  wallOfTextWeight: 25,
  greenScreenWeight: 25,
  videoHookWeight: 25,
  remixPercentage: 0,
  ownMediaPercentage: 0,
  mentionBusinessPercentage: 0,
  influencerChance: DEFAULT_INFLUENCER_CHANCE,
  smartTextPositioning: DEFAULT_SMART_TEXT_POSITIONING,
  genderFilter: null,
} as const satisfies Omit<BlitzPreferences, "angleWeights" | "textStyleWeights">;

/**
 * Campos que **sólo** aparecen en la respuesta. Mandarlos en un PATCH es `400`.
 *
 * `FR-055` regla 7 lo dice de `settingsApplication`. Rechazarlo en vez de
 * ignorarlo es lo que evita que un cliente crea que está fijando
 * `targetQueuedItems` y no esté fijando nada.
 */
export const RESPONSE_ONLY_FIELDS = ["settingsApplication"] as const;

const PATCHABLE_FIELDS: readonly string[] = [
  ...CONTENT_MIX_WEIGHTS,
  "remixPercentage",
  "ownMediaPercentage",
  "mentionBusinessPercentage",
  "influencerChance",
  "smartTextPositioning",
  "genderFilter",
  "angleWeights",
  "textStyleWeights",
];

function assertPercentage(value: unknown, field: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new DomainError("out_of_range", `${field} must be between 0 and 100.`, {
      field,
      value,
    });
  }
}

/**
 * Valida un PATCH de preferencias.
 *
 * `patch` es un objeto parcial. Devuelve nada: como el resto del dominio,
 * valida sin mutar y quien llama aplica.
 */
export function assertValidPreferencesPatch(
  patch: Readonly<Record<string, unknown>>,
  activeAngleIds: readonly string[],
): void {
  const keys = Object.keys(patch);

  // `FR-055`, Validation: «Body vacío `{}` → 400».
  if (keys.length === 0) {
    throw new DomainError("out_of_range", "Nothing to change.", {});
  }

  for (const field of RESPONSE_ONLY_FIELDS) {
    if (field in patch) {
      throw new DomainError("out_of_range", `${field} is read-only.`, { field });
    }
  }

  for (const key of keys) {
    if (!PATCHABLE_FIELDS.includes(key)) {
      throw new DomainError("out_of_range", `Unknown field "${key}".`, { field: key });
    }
  }

  // Regla 1: los cuatro pesos, juntos o ninguno.
  const present = CONTENT_MIX_WEIGHTS.filter((w) => w in patch);
  if (present.length > 0) {
    if (present.length !== CONTENT_MIX_WEIGHTS.length) {
      throw new DomainError(
        "out_of_range",
        "Send all four content mix weights together, or none of them.",
        { given: present, expected: CONTENT_MIX_WEIGHTS },
      );
    }
    let sum = 0;
    for (const w of CONTENT_MIX_WEIGHTS) {
      assertPercentage(patch[w], w);
      sum += patch[w] as number;
    }
    if (sum !== 100) {
      throw new DomainError(
        "out_of_range",
        `The content mix must add up to 100, got ${sum}.`,
        { sum },
      );
    }
  }

  for (const field of [
    "remixPercentage",
    "ownMediaPercentage",
    "mentionBusinessPercentage",
    "influencerChance",
  ]) {
    if (field in patch) assertPercentage(patch[field], field);
  }

  if (
    "smartTextPositioning" in patch &&
    typeof patch.smartTextPositioning !== "boolean"
  ) {
    throw new DomainError("out_of_range", "smartTextPositioning must be true or false.", {
      value: patch.smartTextPositioning,
    });
  }

  if ("genderFilter" in patch) {
    const g = patch.genderFilter;
    if (g !== null && g !== "man" && g !== "woman") {
      throw new DomainError("out_of_range", "genderFilter must be man, woman or null.", {
        value: g,
      });
    }
  }

  if ("angleWeights" in patch) {
    assertValidAngleWeights(patch.angleWeights as AngleWeights, activeAngleIds);
  }

  if ("textStyleWeights" in patch) {
    assertValidTextStyleWeights(patch.textStyleWeights as Record<string, number>);
  }
}

/**
 * `textStyleWeights`: mapa `{presetId: peso entero}` que suma 100, **o `{}`
 * para desactivar**.
 *
 * El `{}` es lo que hay que no romper: un mapa vacío no es "inválido, no suma
 * 100", es "no uses mix de estilos". Tratarlo como error deja al usuario sin
 * forma de volver al comportamiento por defecto.
 */
export function assertValidTextStyleWeights(
  weights: Readonly<Record<string, number>>,
): void {
  const entries = Object.entries(weights);
  if (entries.length === 0) return;

  let sum = 0;
  for (const [preset, weight] of entries) {
    if (!(TEXT_STYLE_PRESETS as readonly string[]).includes(preset)) {
      throw new DomainError("out_of_range", `"${preset}" is not a caption style.`, {
        preset,
        allowed: TEXT_STYLE_PRESETS,
      });
    }
    if (!Number.isInteger(weight) || weight < 0) {
      throw new DomainError(
        "out_of_range",
        "Each caption style weight must be a whole number ≥ 0.",
        { preset, weight },
      );
    }
    sum += weight;
  }
  if (sum !== 100) {
    throw new DomainError(
      "out_of_range",
      `Caption style weights must add up to 100, got ${sum}.`,
      { sum },
    );
  }
}

/**
 * Qué hace un cambio de preferencias con la cola.
 *
 * `FR-055` regla 1 y criterio 1: **todos los cambios aplican sólo a
 * generaciones futuras; guardar NUNCA vacía ni resetea la cola**. Se devuelve
 * como dato en vez de dejarlo implícito porque la tentación de "limpiar la
 * cola para que el cambio se note" es real, y cumplirla le borra al usuario
 * cinco piezas ya generadas —que costaron dinero— por mover un slider.
 */
export interface SettingsApplication {
  readonly mode: "future_generations";
  readonly targetQueuedItems: number;
  readonly clearsExistingQueue: false;
}

export function settingsApplication(): SettingsApplication {
  return {
    mode: "future_generations",
    targetQueuedItems: TARGET_QUEUED_ITEMS,
    clearsExistingQueue: false,
  };
}
