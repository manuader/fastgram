/**
 * Generación de content angles — `AI-005`, `P2-ANGLE-005`, y la semilla desde
 * lo que mejor rinde — `P1-BRAND-023` (`AI-016` Outputs: «una propuesta de
 * semilla de content angles derivada de los temas recurrentes ordenados por
 * engagement»).
 *
 * Lógica pura: el pedido al modelo y la lectura de la respuesta. El LLM lo pone
 * la API (`apps/api/src/routes/v1/angles.ts`, modelo `text` del registro).
 *
 * ## Qué va como dato y qué no
 *
 * Todo el contexto —perfil, títulos existentes, captions que mejor rindieron—
 * viaja en `untrusted` por `containUntrusted`: el perfil lo deriva `AI-016` de
 * bios de terceros, y un caption es texto de terceros. La instrucción del
 * sistema no lleva ni un carácter de eso (§9.14).
 *
 * ## La semilla
 *
 * Con métricas (engagement en los snapshots de las fuentes, o métricas de los
 * posts propios), los textos que mejor rindieron entran **primero y marcados**,
 * y la instrucción pide anclar el ángulo en un tema que se repite ahí. Sin
 * métricas, el generador trabaja sólo con el perfil, como pide `AI-005`.
 */
import type { JsonSchema, LlmMessage, UntrustedBlock } from "@fastgram/ports";

import { containUntrusted, type UntrustedText } from "../sanitization/untrusted-text.js";
import { looksLikeLeakedInstruction } from "../sanitization/untrusted-text.js";

/** Límites de `FR-056` (los mismos de `contracts`: `ANGLE_*_MAX`). */
export const GENERATED_ANGLE_LIMITS = {
  title: 200,
  description: 2000,
  targetAudience: 500,
} as const;

/** Cuántos textos de «lo que mejor rindió» entran. No es un número del PRD. */
export const ANGLE_SEED_MAX_ITEMS = 8;
/** Cuántos títulos existentes se listan para no repetir. */
export const ANGLE_EXISTING_TITLES_MAX = 50;

export interface PerformingText {
  readonly text: string;
  /** Suma de likes + comentarios + vistas + compartidos. */
  readonly engagement: number;
}

export interface AngleGenerationContext {
  readonly businessName?: string | undefined;
  readonly profile: Readonly<{
    coreIdentity?: string | null | undefined;
    productOffering?: string | null | undefined;
    uniqueBenefits?: string | null | undefined;
    problemSolution?: string | null | undefined;
    targetAudience?: string | null | undefined;
    toneOfVoice?: string | null | undefined;
  }>;
  readonly existingTitles: readonly string[];
  readonly topPerforming: readonly PerformingText[];
}

/**
 * Los textos con más engagement, deduplicados y con engagement > 0. Acepta los
 * ítems tal como están guardados en `DATA-032.contentItems` (forma libre) y las
 * filas de métricas de los posts propios.
 */
export function topPerformingTexts(
  items: readonly unknown[],
  max: number = ANGLE_SEED_MAX_ITEMS,
): readonly PerformingText[] {
  const seen = new Set<string>();
  const out: PerformingText[] = [];
  const num = (v: unknown): number =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
  for (const raw of items) {
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const text = [r["title"], r["caption"]]
      .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
      .join(" — ")
      .trim();
    if (text.length === 0) continue;
    const e =
      typeof r["engagement"] === "object" && r["engagement"] !== null
        ? (r["engagement"] as Record<string, unknown>)
        : r;
    const engagement =
      num(e["likes"]) + num(e["comments"]) + num(e["views"]) + num(e["shares"]);
    if (engagement === 0) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ text, engagement });
  }
  return out.sort((a, b) => b.engagement - a.engagement).slice(0, max);
}

export const ANGLE_GENERATION_SCHEMA_NAME = "content_angle";

export const ANGLE_GENERATION_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    description: { type: "string" },
    targetAudience: { type: "string" },
  },
  required: ["title", "description", "targetAudience"],
  additionalProperties: false,
};

export function angleGenerationSystemPrompt(seeded: boolean): string {
  return [
    "You write ONE new content angle for a brand's short-form social media.",
    "A content angle is a recurring theme or point of view the brand can post about many times.",
    "Use only what the brand data says. Never invent products, prices, claims or facts.",
    "Do not repeat or rephrase any of the existing angle titles.",
    seeded
      ? "The data includes the brand's best-performing posts, ordered by engagement: anchor the angle in a theme that recurs among them."
      : "Base the angle on the brand profile.",
    `Return JSON: title (max ${GENERATED_ANGLE_LIMITS.title} chars, short), description (1-3 sentences on what posts under this angle talk about and why it fits the brand), targetAudience (who it speaks to, one line).`,
    "Write in the same language as the brand data.",
  ].join("\n");
}

export interface AngleGenerationRequest {
  readonly messages: readonly LlmMessage[];
  readonly untrusted: readonly UntrustedBlock[];
  readonly schema: JsonSchema;
  readonly schemaName: string;
  readonly seeded: boolean;
}

export function buildAngleGenerationRequest(
  context: AngleGenerationContext,
  fence: string,
): AngleGenerationRequest {
  const fragments: UntrustedText[] = [];
  const push = (source: UntrustedText["source"], label: string, v: unknown): void => {
    if (typeof v !== "string") return;
    const t = v.trim();
    if (t.length > 0) fragments.push({ source, text: `${label}: ${t}` });
  };
  push("business_name", "Business name", context.businessName);
  const p = context.profile;
  push("brand_profile", "Core identity", p.coreIdentity);
  push("brand_profile", "Product offering", p.productOffering);
  push("brand_profile", "Unique benefits", p.uniqueBenefits);
  push("brand_profile", "Problem solved", p.problemSolution);
  push("brand_profile", "Target audience", p.targetAudience);
  push("brand_profile", "Tone of voice", p.toneOfVoice);
  const seeded = context.topPerforming.length > 0;
  context.topPerforming.forEach((item, i) => {
    push(
      "post_caption",
      `Best-performing post #${i + 1} (engagement ${Math.round(item.engagement)})`,
      item.text,
    );
  });
  for (const title of context.existingTitles.slice(0, ANGLE_EXISTING_TITLES_MAX)) {
    push("content_angle", "Existing angle title", title);
  }
  const contained = containUntrusted(fragments, fence);
  return {
    messages: [{ role: "system", content: angleGenerationSystemPrompt(seeded) }],
    untrusted: [{ label: "brand_data", content: contained.prompt }],
    schema: ANGLE_GENERATION_SCHEMA,
    schemaName: ANGLE_GENERATION_SCHEMA_NAME,
    seeded,
  };
}

export interface GeneratedAngle {
  readonly title: string;
  readonly description: string;
  readonly targetAudience: string;
}

export type ParsedGeneratedAngle =
  | { readonly ok: true; readonly angle: GeneratedAngle }
  | { readonly ok: false; readonly reason: string };

function clip(value: string, max: number): string {
  const t = value.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max).trimEnd() : t;
}

/**
 * La respuesta del modelo → un ángulo dentro de los límites de `FR-056`, o el
 * motivo por el que no sirve. Un título repetido (sin distinguir mayúsculas)
 * o que parece una instrucción filtrada se rechaza.
 */
export function parseGeneratedAngle(
  value: unknown,
  existingTitles: readonly string[],
): ParsedGeneratedAngle {
  if (typeof value !== "object" || value === null) {
    return { ok: false, reason: "response is not an object" };
  }
  const v = value as Record<string, unknown>;
  const title =
    typeof v["title"] === "string" ? clip(v["title"], GENERATED_ANGLE_LIMITS.title) : "";
  const description =
    typeof v["description"] === "string"
      ? clip(v["description"], GENERATED_ANGLE_LIMITS.description)
      : "";
  const targetAudience =
    typeof v["targetAudience"] === "string"
      ? clip(v["targetAudience"], GENERATED_ANGLE_LIMITS.targetAudience)
      : "";
  if (title === "" || description === "" || targetAudience === "") {
    return { ok: false, reason: "a field is empty" };
  }
  if ([title, description, targetAudience].some(looksLikeLeakedInstruction)) {
    return { ok: false, reason: "leaked instruction" };
  }
  const lower = title.toLowerCase();
  if (existingTitles.some((t) => t.trim().toLowerCase() === lower)) {
    return { ok: false, reason: "duplicate title" };
  }
  return { ok: true, angle: { title, description, targetAudience } };
}
