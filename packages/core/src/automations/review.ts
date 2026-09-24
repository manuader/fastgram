/**
 * Revisión de una campaña — `F-214`, `F-215`, `FR-150` (Revisión, Re-roll).
 *
 * Tres grupos de edición **independientes** sobre un slot `READY` con la
 * campaña en `REVIEW`:
 *
 * 1. los textos de la pieza (`suggestionData` + `generatedText`, que van
 *    juntos: el cliente manda los textos y `generatedText` se deriva);
 * 2. `captionsByPlatform`, que **reemplaza el mapa completo**: una plataforma
 *    omitida se borra;
 * 3. `scheduledAtUtc`.
 *
 * Para YouTube `caption` es el título y `description` el cuerpo; LinkedIn sólo
 * acepta `caption`. Los topes por red son los de `PLATFORM_FIELD_LIMITS`
 * (`scheduling/schedule-post.ts`), los mismos con los que `FR-060` programa.
 */
import { DomainError } from "../errors.js";
import type { BlitzContentType } from "../content/content.js";
import {
  generatedTextOf,
  parseSuggestionBuildPlan,
  type SuggestionBuildPlan,
} from "../discovery/blitz-build.js";
import { PLATFORM_FIELD_LIMITS } from "../scheduling/schedule-post.js";
import { TEXT_BOX_LIMITS } from "../content/text-boxes.js";
import type { AutomationPlatform } from "./model.js";

export interface PlatformCaption {
  readonly caption: string;
  readonly description?: string | undefined;
}

export type CaptionsByPlatform = Readonly<
  Partial<Record<AutomationPlatform, PlatformCaption>>
>;

function codePoints(text: string): number {
  return [...text].length;
}

function clip(text: string, max: number): string {
  const points = [...text];
  if (points.length <= max) return text;
  return `${points
    .slice(0, Math.max(0, max - 1))
    .join("")
    .trimEnd()}…`;
}

/** La primera frase o línea: el título de YouTube / TikTok. */
function headline(text: string): string {
  const first = text.split(/\n+/u)[0] ?? text;
  const sentence = /^(.+?[.!?])(\s|$)/u.exec(first);
  return (sentence?.[1] ?? first).trim();
}

/**
 * Captions por defecto a partir de la copy: una por red destino, recortada al
 * tope de la red. Donde la red tiene título + cuerpo (YouTube, TikTok), el
 * título es la primera frase y el cuerpo, la copy entera.
 */
export function defaultCaptions(
  generatedText: string,
  platforms: readonly AutomationPlatform[],
): CaptionsByPlatform {
  const text = generatedText.trim();
  const out: Partial<Record<AutomationPlatform, PlatformCaption>> = {};
  for (const platform of platforms) {
    const limits = PLATFORM_FIELD_LIMITS[platform];
    const captionMax = limits.caption ?? 2_200;
    if (limits.description !== null) {
      out[platform] = {
        caption: clip(headline(text), captionMax),
        description: clip(text, limits.description),
      };
    } else {
      out[platform] = { caption: clip(text, captionMax) };
    }
  }
  return out;
}

export type CaptionProblem =
  | { readonly platform: string; readonly kind: "not_a_destination" }
  | { readonly platform: string; readonly kind: "caption_too_long"; readonly max: number }
  | { readonly platform: string; readonly kind: "caption_empty" }
  | { readonly platform: string; readonly kind: "description_not_supported" }
  | {
      readonly platform: string;
      readonly kind: "description_too_long";
      readonly max: number;
    };

/** Lo que está mal en un mapa de captions para estos destinos. */
export function captionProblems(
  captions: Readonly<Record<string, PlatformCaption>>,
  platforms: readonly AutomationPlatform[],
): CaptionProblem[] {
  const problems: CaptionProblem[] = [];
  for (const [platform, value] of Object.entries(captions)) {
    if (!(platforms as readonly string[]).includes(platform)) {
      problems.push({ platform, kind: "not_a_destination" });
      continue;
    }
    const limits = PLATFORM_FIELD_LIMITS[platform as AutomationPlatform];
    if (value.caption.trim() === "") problems.push({ platform, kind: "caption_empty" });
    if (limits.caption !== null && codePoints(value.caption) > limits.caption)
      problems.push({ platform, kind: "caption_too_long", max: limits.caption });
    if (value.description !== undefined) {
      if (limits.description === null)
        problems.push({ platform, kind: "description_not_supported" });
      else if (codePoints(value.description) > limits.description)
        problems.push({
          platform,
          kind: "description_too_long",
          max: limits.description,
        });
    }
  }
  return problems;
}

// ───────────────────────────────────────────────────────────────────────────
// `suggestionData` de un slot
// ───────────────────────────────────────────────────────────────────────────

/**
 * Lo que un slot `READY` guarda en `suggestionData` (`DATA-022`: *"forma
 * variable por tipo"*): el mismo `build_plan` que una sugerencia de Blitz, más
 * lo que el deck muestra y el dedup dejó.
 */
export interface AutomationSuggestionData {
  readonly buildPlan: SuggestionBuildPlan;
  readonly aiExplanation: string;
  readonly angleId: string | null;
  readonly influencerId: string | null;
  readonly textStylePresetId: string | null;
  readonly topic: string | null;
  readonly dedup: { readonly fingerprint: string; readonly score: number };
}

export type ParsedSuggestionData =
  | { readonly ok: true; readonly data: AutomationSuggestionData }
  | { readonly ok: false; readonly reason: string };

export function parseSuggestionData(
  raw: unknown,
  contentType: BlitzContentType,
): ParsedSuggestionData {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    return { ok: false, reason: "suggestionData is not an object" };
  const r = raw as Record<string, unknown>;
  const plan = parseSuggestionBuildPlan(r["buildPlan"], contentType);
  if (!plan.ok) return { ok: false, reason: plan.reason };
  const str = (k: string): string | null => {
    const v = r[k];
    return typeof v === "string" && v !== "" ? v : null;
  };
  const dedupRaw = r["dedup"];
  const dedup =
    dedupRaw !== null && typeof dedupRaw === "object" && !Array.isArray(dedupRaw)
      ? (dedupRaw as Record<string, unknown>)
      : {};
  return {
    ok: true,
    data: {
      buildPlan: plan.plan,
      aiExplanation: str("aiExplanation") ?? "",
      angleId: str("angleId"),
      influencerId: str("influencerId"),
      textStylePresetId: str("textStylePresetId"),
      topic: str("topic"),
      dedup: {
        fingerprint: typeof dedup["fingerprint"] === "string" ? dedup["fingerprint"] : "",
        score: typeof dedup["score"] === "number" ? dedup["score"] : 0,
      },
    },
  };
}

/**
 * Grupo (1): nuevos textos de la pieza. La cantidad es la del plan (un
 * slideshow tiene tantos slides como textos, y la media ya está elegida).
 * Devuelve los datos nuevos y el `generatedText` que va con ellos.
 */
export function applyTextEdit(
  data: AutomationSuggestionData,
  texts: readonly string[],
): { readonly data: AutomationSuggestionData; readonly generatedText: string } {
  const current = data.buildPlan.texts.length;
  if (texts.length !== current) {
    throw new DomainError(
      "out_of_range",
      `This post has ${String(current)} text${current === 1 ? "" : "s"}; send exactly that many.`,
      { field: "texts" },
    );
  }
  for (const t of texts) {
    if (t.trim() === "" || t.length > TEXT_BOX_LIMITS.textMaxChars) {
      throw new DomainError(
        "out_of_range",
        `Each text must be 1–${String(TEXT_BOX_LIMITS.textMaxChars)} characters.`,
        { field: "texts" },
      );
    }
  }
  const trimmed = texts.map((t) => t.trim());
  return {
    data: { ...data, buildPlan: { ...data.buildPlan, texts: trimmed } },
    generatedText: generatedTextOf(trimmed),
  };
}
