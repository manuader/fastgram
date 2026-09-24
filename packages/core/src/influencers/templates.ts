/**
 * Templates de prompt, imagen base por texto y video del personaje —
 * sprint 7 (agente G), `P4-INFL-003`, `P4-INFL-009`, `P4-INFL-010`,
 * `FR-081`, `FR-082`, `F-093`, `F-099`.
 *
 * ## Templates (`FR-081`: select `✨ Template`)
 *
 * El PRD muestra el select pero no su contenido. Estos seis son **nuestros**
 * (FastGram), no de Fastlane, y son editables por marca: la lista guardada
 * reemplaza a la de fábrica (`~/.fastgram/influencer-templates/<marca>/`).
 * `{subject}` se reemplaza por «her», «him» o «them» según el género.
 *
 * ## Imagen base por texto (`F-091`, `F-093`)
 *
 * Con Higgsfield el personaje se entrena desde fotos (Soul ID). La imagen base
 * por texto es una generación de imagen normal (el modelo de imagen de
 * Settings → Models) con un prompt armado desde la descripción; el personaje
 * se crea después **desde esa foto**. «Regenerate» es otra generación: una
 * persona nueva, no una edición (literal de `FR-080`).
 */
import type { GenAspectRatio } from "@fastgram/ports";

export interface InfluencerPromptTemplate {
  readonly id: string;
  readonly label: string;
  /** Con `{subject}`. */
  readonly prompt: string;
}

/** Carpeta de los templates por marca dentro de `FASTGRAM_HOME`. */
export const INFLUENCER_TEMPLATES_DIR_NAME = "influencer-templates";

export const INFLUENCER_TEMPLATE_LIMITS = {
  maxTemplates: 30,
  labelMax: 40,
  promptMax: 500,
} as const;

export const DEFAULT_INFLUENCER_TEMPLATES: readonly InfluencerPromptTemplate[] = [
  {
    id: "coffee-shop",
    label: "Coffee shop",
    prompt: "{subject} sitting in a cozy coffee shop holding a latte, soft window light",
  },
  {
    id: "beach",
    label: "Beach day",
    prompt: "{subject} walking on a sunny beach at golden hour, candid photo",
  },
  {
    id: "gym",
    label: "Gym mirror selfie",
    prompt: "{subject} taking a mirror selfie at the gym in athletic wear",
  },
  {
    id: "city",
    label: "City street",
    prompt: "{subject} walking down a busy city street at dusk, street photography",
  },
  {
    id: "desk",
    label: "Home office",
    prompt: "{subject} working on a laptop at a tidy home desk, morning light",
  },
  {
    id: "product",
    label: "Holding a product",
    prompt: "{subject} holding a product up to the camera and smiling, plain background",
  },
];

/** «her», «him» o «them». El género es texto libre (`DATA-013`). */
export function subjectPronoun(gender: string | null | undefined): string {
  const g = (gender ?? "").trim().toLowerCase();
  if (g === "female" || g === "woman") return "her";
  if (g === "male" || g === "man") return "him";
  return "them";
}

export function applyTemplate(
  template: Pick<InfluencerPromptTemplate, "prompt">,
  gender: string | null | undefined,
): string {
  return template.prompt.replace(/\{subject\}/g, subjectPronoun(gender));
}

const TEMPLATE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

export type TemplateListCheck =
  | { readonly ok: true; readonly templates: InfluencerPromptTemplate[] }
  | { readonly ok: false; readonly message: string };

/** Valida y normaliza una lista entera (lo que guarda `PUT`). */
export function checkTemplateList(input: readonly unknown[]): TemplateListCheck {
  const { maxTemplates, labelMax, promptMax } = INFLUENCER_TEMPLATE_LIMITS;
  if (input.length > maxTemplates) {
    return { ok: false, message: `Keep it to ${String(maxTemplates)} templates.` };
  }
  const out: InfluencerPromptTemplate[] = [];
  const ids = new Set<string>();
  for (const raw of input) {
    if (typeof raw !== "object" || raw === null) {
      return { ok: false, message: "A template is malformed." };
    }
    const r = raw as Record<string, unknown>;
    const id = typeof r["id"] === "string" ? r["id"] : "";
    const label = typeof r["label"] === "string" ? r["label"].trim() : "";
    const prompt = typeof r["prompt"] === "string" ? r["prompt"].trim() : "";
    if (!TEMPLATE_ID.test(id) || ids.has(id)) {
      return { ok: false, message: "Each template needs a unique id." };
    }
    if (label === "" || label.length > labelMax) {
      return {
        ok: false,
        message: `Template names are 1–${String(labelMax)} characters.`,
      };
    }
    if (prompt === "" || prompt.length > promptMax) {
      return {
        ok: false,
        message: `Template prompts are 1–${String(promptMax)} characters.`,
      };
    }
    ids.add(id);
    out.push({ id, label, prompt });
  }
  return { ok: true, templates: out };
}

/** El archivo de la marca → la lista, o `null` si no hay (o no se entiende). */
export function parseStoredTemplates(value: unknown): InfluencerPromptTemplate[] | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v["version"] !== 1 || !Array.isArray(v["templates"])) return null;
  const checked = checkTemplateList(v["templates"]);
  return checked.ok ? checked.templates : null;
}

/* ------------------------------------------------------------------------ *
 * Imagen base por texto
 * ------------------------------------------------------------------------ */

export interface BaseCharacterDescription {
  readonly gender?: string | null | undefined;
  readonly age?: number | null | undefined;
  readonly ethnicity?: string | null | undefined;
  readonly details?: string | null | undefined;
  /** «Regeneration instructions» (`FR-080` paso 2). */
  readonly instructions?: string | null | undefined;
}

/** La base es vertical (`FR-080` paso 2: «Imagen base generada (9:16)»). */
export const BASE_IMAGE_ASPECT_RATIO: GenAspectRatio = "9:16";

const oneLine = (s: string | null | undefined): string =>
  (s ?? "").replace(/\s+/g, " ").trim();

/**
 * El prompt de la imagen base: **una** persona, de frente, fondo simple (es
 * lo que mejor entrena un personaje). `null` si no hay nada que describir.
 */
export function composeBaseCharacterPrompt(d: BaseCharacterDescription): string | null {
  const gender = oneLine(d.gender);
  const ethnicity = oneLine(d.ethnicity);
  const details = oneLine(d.details);
  const instructions = oneLine(d.instructions);
  const age =
    typeof d.age === "number" && Number.isFinite(d.age) ? Math.round(d.age) : null;
  if (
    gender === "" &&
    ethnicity === "" &&
    details === "" &&
    instructions === "" &&
    age === null
  ) {
    return null;
  }
  const who = [
    age === null ? null : `${String(age)}-year-old`,
    ethnicity === "" ? null : ethnicity,
    gender === "" ? "person" : gender,
  ]
    .filter((x): x is string => x !== null)
    .join(" ");
  const extras = [details, instructions].filter((x) => x !== "").join(", ");
  return [
    `Photorealistic vertical portrait photo of a single ${who}`,
    extras === "" ? null : extras,
    "looking at the camera, natural light, simple background, sharp focus, high detail",
  ]
    .filter((x): x is string => x !== null)
    .join(", ")
    .slice(0, 1000);
}

/* ------------------------------------------------------------------------ *
 * Video del personaje («Animate this image», `F-099`)
 * ------------------------------------------------------------------------ */

/** Tope del prompt de movimiento (`FR-082`: «describe the motion (optional…)»). */
export const INFLUENCER_VIDEO_PROMPT_MAX = 1000;

/** Clave determinista del video: una reentrega no duplica objetos ni filas. */
export function influencerVideoStorageKey(input: {
  readonly companyId: string;
  readonly influencerId: string;
  readonly generationId: string;
  readonly ext: string;
}): string {
  return `media/${input.companyId}/influencers/${input.influencerId}/${input.generationId}-video.${input.ext}`;
}

/** El set de videos del influencer (`FR-083`: video sets), que lee Blitz. */
export function influencerVideoSetName(influencerName: string): string {
  return `${influencerName} · videos`;
}
