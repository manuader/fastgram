/**
 * Síntesis del perfil de marca — PRD `AI-016`, `FR-011.2`, `FR-011.3`, `FR-011.6`.
 *
 * **El guardarraíl más importante de toda la extensión**, literal de `AI-016`:
 *
 *   "**Nunca inventar.** Un campo sin señal suficiente queda **vacío** y
 *    genera una pregunta al usuario, no un relleno plausible. Un
 *    `PRODUCT OFFERING` inventado contamina cada pieza de contenido que el
 *    sistema genere después."
 *
 * Por qué es tan grave y por qué se defiende en el dominio y no en el prompt.
 * El perfil de marca no es un dato que el usuario lea una vez: es el contexto
 * de **todas** las generaciones futuras. Un `PRODUCT OFFERING` plausible pero
 * falso no se nota al revisarlo —para eso es plausible— y a partir de ahí cada
 * caption, cada hook y cada ángulo hablan de un negocio que no existe. El
 * usuario ve que "el contenido no me representa" y no tiene forma de llegar a
 * la causa. Pedirle al modelo que no invente es necesario y no es suficiente:
 * acá la regla es estructural, **un valor sin extracto que lo respalde no se
 * materializa**, y ningún prompt puede saltársela.
 *
 * La otra mitad de la regla es `FR-011.3`: el hueco **se pregunta**. Un campo
 * vacío sin pregunta es el mismo problema con otra cara — el usuario nunca se
 * entera de que falta.
 */
import { DomainError } from "../errors.js";
import {
  DEFAULT_CONTENT_ITEMS,
  LINK_IN_BIO_MAX_DESTINATIONS,
  type BrandSourceType,
} from "@fastgram/ports";
import { HARD_CAPS } from "../quota/plans.js";
import type { CoreBrandSourceType } from "./source-input.js";

/** Campos del `CompanyProfile` que `AI-016` deriva (`FR-011.3`, mapa normativo). */
export const BRAND_PROFILE_FIELDS = [
  "coreIdentity",
  "productOffering",
  "uniqueBenefits",
  "problemSolution",
  "marketAndCompetition",
  "toneOfVoice",
  "targetAudience",
  "businessCategories",
] as const;
export type BrandProfileField = (typeof BRAND_PROFILE_FIELDS)[number];

export type FieldConfidence = "high" | "medium" | "low";

/**
 * Preguntas de cierre de huecos.
 *
 * Las dos primeras son **literales del PRD** (`FR-011.3`). El resto es copy
 * **propuesto**: el PRD no lo especifica, y dejar el campo sin pregunta
 * rompería la otra mitad del guardarraíl (el hueco tiene que preguntarse).
 * Queda marcado para que nadie lo confunda con texto verificado.
 */
export const GAP_QUESTIONS: Readonly<Record<BrandProfileField, string>> = {
  /** Literal del PRD. */
  productOffering: "In one line: what do you actually sell?",
  /** Literal del PRD. */
  problemSolution: "What problem does someone have right before they find you?",
  // ── copy propuesto, no literal del PRD ──────────────────────────────────
  coreIdentity: "In one line: who are you and what do you stand for?",
  uniqueBenefits: "What do people get from you that they can't get elsewhere?",
  marketAndCompetition: "Who else does something similar, and how are you different?",
  toneOfVoice: "How should we sound when we write for you?",
  targetAudience: "Who are you trying to reach?",
  businessCategories: "Which categories does your business belong to?",
} as const;

/**
 * Lo que la síntesis propone para un campo, antes de materializarse.
 *
 * `excerpt` es **la evidencia**: el fragmento exacto del snapshot del que
 * salió el valor. Sin él, el valor es una afirmación sin respaldo, y ése es
 * justamente el caso que el guardarraíl atrapa.
 */
export interface DerivedField {
  readonly field: BrandProfileField;
  readonly value: string;
  readonly confidence: FieldConfidence;
  /**
   * Quién midió la confianza.
   *
   * `AI-016` es explícito: «La confianza por campo la produce `JV-4`, no el
   * LLM de síntesis: **quien deriva un valor no es buen juez de su propia
   * evidencia**». Cuando la confianza viene del propio sintetizador se
   * **recorta a `low`**: no se descarta el valor —hay extracto—, pero entra
   * a revisión en vez de darse por bueno. Es una decisión de diseño, no una
   * regla literal del PRD; ver el informe.
   */
  readonly confidenceSource: "verifier" | "synthesizer";
  readonly excerpt?: string | undefined;
  readonly sourceId: string;
  readonly sourceType: CoreBrandSourceType;
}

export interface MaterializedField {
  readonly field: BrandProfileField;
  readonly status: "materialized" | "needs_review" | "empty";
  /** Vacío cuando `status` es `empty`. **Nunca** un relleno plausible. */
  readonly value: string;
  readonly confidence: FieldConfidence;
  readonly sourceId?: string | undefined;
  readonly excerpt?: string | undefined;
  /** La pregunta que hay que hacerle al usuario, o `null` si no hace falta. */
  readonly question: string | null;
}

/**
 * Aplica el guardarraíl a **un** campo.
 *
 * Un campo se queda vacío si no hay extracto o si el valor está en blanco —
 * sin importar qué confianza declare el modelo. Un `high` sin extracto es
 * exactamente el caso peligroso: un modelo seguro de algo que no puede citar.
 */
export function materializeField(derived: DerivedField): MaterializedField {
  const value = derived.value.trim();
  const excerpt = derived.excerpt?.trim();

  if (value.length === 0 || excerpt === undefined || excerpt.length === 0) {
    return {
      field: derived.field,
      status: "empty",
      value: "",
      confidence: "low",
      question: GAP_QUESTIONS[derived.field],
    };
  }

  const confidence: FieldConfidence =
    derived.confidenceSource === "verifier" ? derived.confidence : "low";

  if (confidence === "low") {
    // `FR-011.2`: los `low` se agrupan arriba bajo `Worth a quick check`. El
    // valor **se muestra** —hay evidencia— pero se ofrece la pregunta.
    return {
      field: derived.field,
      status: "needs_review",
      value,
      confidence,
      sourceId: derived.sourceId,
      excerpt,
      question: GAP_QUESTIONS[derived.field],
    };
  }

  return {
    field: derived.field,
    status: "materialized",
    value,
    confidence,
    sourceId: derived.sourceId,
    excerpt,
    question: null,
  };
}

/** Los campos que el alta tiene que preguntar, en el paso de detalles. */
export function gapQuestions(fields: readonly MaterializedField[]): readonly string[] {
  return fields.filter((f) => f.question !== null).map((f) => f.question as string);
}

/**
 * El usuario dejó el hueco sin responder.
 *
 * `FR-011.3`: «Si el usuario los deja vacíos, el campo queda vacío y el motor
 * de generación opera sin él (y `mentionBusinessPercentage` se recomienda bajo
 * hasta que se complete)». Es decir: no se rellena con nada, y el producto
 * baja la frecuencia con la que menciona el negocio porque no sabe qué decir.
 */
export interface UnansweredGapAdvice {
  readonly emptyFields: readonly BrandProfileField[];
  readonly recommendLowMentionBusiness: boolean;
}

export function adviseOnUnansweredGaps(
  fields: readonly MaterializedField[],
): UnansweredGapAdvice {
  const emptyFields = fields.filter((f) => f.status === "empty").map((f) => f.field);
  return {
    emptyFields,
    // El campo que decide esto es el de la oferta: si no sabemos qué vende,
    // mencionarlo seguido produce contenido que habla de nada.
    recommendLowMentionBusiness:
      emptyFields.includes("productOffering") || emptyFields.includes("coreIdentity"),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Fusión de varias fuentes — FR-011.6
// ───────────────────────────────────────────────────────────────────────────

/**
 * Precedencia por defecto, literal de `FR-011.6`:
 *
 *   `website > linkedin > instagram ≈ tiktok > youtube > x > other_url > manual`
 *
 * El `≈` entre instagram y tiktok es del PRD: empatan, y el empate lo rompe la
 * fuente primaria. Se modela con el **mismo número**, no con un orden
 * arbitrario, para que el empate sea explícito y lo resuelva quien debe.
 */
const PRECEDENCE: Readonly<Record<CoreBrandSourceType, number>> = {
  website: 7,
  linkedin: 6,
  instagram: 5,
  tiktok: 5,
  youtube: 4,
  x: 3,
  other_url: 2,
  manual: 1,
};

/**
 * Para `toneOfVoice` la precedencia se **invierte**: los orígenes sociales
 * ganan a la web.
 *
 * No es un capricho: la web dice cómo la marca se presenta; el feed dice cómo
 * la marca **habla** en el canal donde vamos a publicar. `FR-011.3` lo marca
 * como «la mayor ventaja del origen social sobre la web».
 */
const TONE_PRECEDENCE: Readonly<Record<CoreBrandSourceType, number>> = {
  instagram: 7,
  tiktok: 7,
  x: 6,
  youtube: 6,
  linkedin: 5,
  website: 3,
  other_url: 2,
  manual: 1,
};

export interface FieldConflict {
  readonly field: BrandProfileField;
  readonly chosenSourceId: string;
  readonly otherSourceIds: readonly string[];
}

export interface MergeContext {
  /** Id de la fuente `isPrimary`. Gana **siempre** en empate (`FR-011.6`). */
  readonly primarySourceId: string | null;
  /** `true` si el usuario ya editó este campo a mano (`fieldMeta.editedByUser`). */
  readonly editedByUser?: boolean | undefined;
}

export interface MergeResult {
  readonly field: MaterializedField;
  readonly conflict: FieldConflict | null;
  /**
   * `true` cuando hay una propuesta que el usuario tiene que aceptar antes de
   * pisar su edición manual (`ERR-B14`: `This source suggests a different
   * answer — replace?`).
   */
  readonly awaitingUserDecision: boolean;
}

/**
 * Fusiona las propuestas de varias fuentes para **un** campo.
 *
 * Tres reglas, todas de `FR-011.6`:
 *  1. gana la de mayor precedencia; la primaria rompe el empate;
 *  2. si dos se contradicen, el campo queda **con confianza `medium` como
 *     máximo** y el conflicto se guarda — para que aparezca en la revisión en
 *     vez de irse en silencio;
 *  3. un campo con `editedByUser` **no se pisa**: se propone y se espera.
 */
export function mergeFieldCandidates(
  field: BrandProfileField,
  candidates: readonly DerivedField[],
  context: MergeContext,
): MergeResult {
  const usable = candidates
    .filter((c) => c.field === field)
    .map((c) => ({ derived: c, materialized: materializeField(c) }))
    .filter((c) => c.materialized.status !== "empty");

  if (usable.length === 0) {
    return {
      field: {
        field,
        status: "empty",
        value: "",
        confidence: "low",
        question: GAP_QUESTIONS[field],
      },
      conflict: null,
      awaitingUserDecision: false,
    };
  }

  const table = field === "toneOfVoice" ? TONE_PRECEDENCE : PRECEDENCE;
  const score = (c: (typeof usable)[number]) => {
    const base = table[c.derived.sourceType] * 10;
    // La primaria gana el empate, y sólo el empate: suma menos que un escalón
    // de precedencia.
    return base + (c.derived.sourceId === context.primarySourceId ? 1 : 0);
  };

  const sorted = [...usable].sort((a, b) => score(b) - score(a));
  const winner = sorted[0] as (typeof usable)[number];
  const losers = sorted.slice(1);

  const contradicting = losers.filter(
    (l) => l.materialized.value !== winner.materialized.value,
  );

  const conflict: FieldConflict | null =
    contradicting.length > 0
      ? {
          field,
          chosenSourceId: winner.derived.sourceId,
          otherSourceIds: contradicting.map((l) => l.derived.sourceId),
        }
      : null;

  // Regla 2: con conflicto, `medium` es el techo. Un `high` sobre un campo en
  // el que dos fuentes no se ponen de acuerdo es una confianza que no existe.
  const confidence: FieldConfidence =
    conflict !== null && winner.materialized.confidence === "high"
      ? "medium"
      : winner.materialized.confidence;

  const merged: MaterializedField = {
    ...winner.materialized,
    confidence,
    // Bajar a `medium` no convierte un campo revisable en uno cerrado: si
    // estaba en revisión, sigue.
    status: winner.materialized.status,
    question: winner.materialized.question,
  };

  if (context.editedByUser === true) {
    // Regla 3. No se devuelve el valor nuevo como si fuera el actual: se
    // avisa de que hay una propuesta. Quien decide es el usuario.
    return { field: merged, conflict, awaitingUserDecision: true };
  }

  return { field: merged, conflict, awaitingUserDecision: false };
}

// ───────────────────────────────────────────────────────────────────────────
// Límites de la etapa de recolección y enriquecimiento — AI-016, INT-018
// ───────────────────────────────────────────────────────────────────────────

/** 24 ítems por análisis, configurable (`AI-016`, `FR-011.3`, §9.14). */
export function resolveItemsPerAnalysis(configured?: number | undefined): number {
  const value = configured ?? HARD_CAPS.itemsPerBrandAnalysis;
  if (!Number.isInteger(value) || value < 1) {
    throw new DomainError("out_of_range", "Items per analysis must be at least 1.", {
      value,
    });
  }
  // El techo duro existe por coste: cada ítem es una descarga más un OCR.
  const ceiling = Math.max(HARD_CAPS.itemsPerBrandAnalysis, DEFAULT_CONTENT_ITEMS);
  if (value > ceiling) {
    throw new DomainError(
      "out_of_range",
      `Up to ${ceiling} items can be analysed per source.`,
      { value, ceiling },
    );
  }
  return value;
}

/**
 * Link-in-bio: **un** nivel, **cinco** destinos, sin recursión
 * (`FR-011.11`, `INT-018`, `LINK_IN_BIO_MAX_DESTINATIONS`).
 *
 * "Sin recursión" es la parte que importa: un Linktree que apunta a otro
 * Linktree, seguido en profundidad, es un rastreador de la web entera pegado
 * al alta de un usuario. Un nivel, cinco destinos, y se corta.
 */
export function planLinkFollowing(links: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const link of links) {
    const key = link.trim().toLowerCase();
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    out.push(link.trim());
    if (out.length === LINK_IN_BIO_MAX_DESTINATIONS) break;
  }
  return out;
}

/** Sólo para el badge de origen de `FR-011.2`. */
export function isSocialSourceType(t: CoreBrandSourceType): t is BrandSourceType {
  return t !== "manual" && t !== "website" && t !== "other_url";
}
