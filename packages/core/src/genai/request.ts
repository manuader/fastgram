/**
 * Un pedido de AI Studio contra la ficha del modelo, el payload del job y el
 * ritmo del polling — `PU-LATER-005`, `PU-MODEL-003`/`004`.
 *
 * La ficha (`GenModelSpec`) la publica el adaptador; acá se valida **antes**
 * de estimar o reservar, para que la UI reciba el campo que está mal y no un
 * error del proveedor.
 */
import type { GenAspectRatio, GenMediaKind, GenModelSpec } from "@fastgram/ports";

/** Tope de sanidad, no del producto: ningún prompt útil se acerca. */
export const MAX_GENERATION_PROMPT_LENGTH = 2000;

export interface GenerationInput {
  readonly kind: GenMediaKind;
  readonly model: string;
  readonly prompt: string;
  readonly aspectRatio: GenAspectRatio;
  readonly count: number;
  readonly durationSeconds?: number | undefined;
  readonly imageUrl?: string | undefined;
}

export type GenerationInputField =
  "model" | "prompt" | "aspectRatio" | "count" | "durationSeconds" | "imageUrl";

export type GenerationInputCheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly field: GenerationInputField;
      readonly message: string;
    };

const fail = (field: GenerationInputField, message: string): GenerationInputCheck => ({
  ok: false,
  field,
  message,
});

export interface GenerationInputOptions {
  /**
   * El proveedor corre en esta máquina y la imagen de entrada la baja el
   * adaptador (ComfyUI, `PU-LATER-003`), no un tercero desde internet: vale
   * también `http://` (el MinIO local). Default `false`.
   */
  readonly localImageFetch?: boolean;
}

export function checkGenerationInput(
  spec: GenModelSpec | undefined,
  input: GenerationInput,
  options: GenerationInputOptions = {},
): GenerationInputCheck {
  if (spec === undefined) {
    return fail("model", "That model is not available for this provider.");
  }
  if (spec.kind !== input.kind) {
    return fail(
      "model",
      `That is not ${input.kind === "image" ? "an image" : "a video"} model.`,
    );
  }
  const prompt = input.prompt.trim();
  if (spec.promptRequired && prompt.length === 0)
    return fail("prompt", "Write a prompt.");
  if (prompt.length > MAX_GENERATION_PROMPT_LENGTH) {
    return fail("prompt", "The prompt is too long.");
  }
  if (!spec.aspectFromImage && !spec.aspectRatios.includes(input.aspectRatio)) {
    return fail("aspectRatio", `This model supports ${spec.aspectRatios.join(", ")}.`);
  }
  if (!spec.counts.includes(input.count)) {
    return fail("count", `This model makes ${spec.counts.join(" or ")} per request.`);
  }
  if (input.kind === "video") {
    const d = input.durationSeconds;
    if (d === undefined || !spec.durationsSeconds.includes(d)) {
      return fail(
        "durationSeconds",
        `Pick a duration: ${spec.durationsSeconds.join(", ")} seconds.`,
      );
    }
  }
  const image = input.imageUrl?.trim() ?? "";
  if (spec.imageInput === "required" && image === "") {
    return fail("imageUrl", "This model animates a start image: paste its public URL.");
  }
  if (spec.imageInput === "none" && image !== "") {
    return fail("imageUrl", "This model does not take a start image.");
  }
  if (image !== "") {
    let url: URL;
    try {
      url = new URL(image);
    } catch {
      return fail("imageUrl", "Use a full https:// URL.");
    }
    // El proveedor la descarga desde internet: tiene que ser pública. Con un
    // proveedor local la baja el adaptador, y `http://` (MinIO local) sirve.
    const protocolOk =
      url.protocol === "https:" ||
      (options.localImageFetch === true && url.protocol === "http:");
    if (!protocolOk || url.username !== "" || url.password !== "") {
      return fail("imageUrl", "Use a public https:// URL the provider can download.");
    }
  }
  return { ok: true };
}

/* ------------------------------------------------------------------------ *
 * El job
 * ------------------------------------------------------------------------ */

/** Payload de `ai-studio-generation`. Todo lo demás está en el registro. */
export interface AiStudioGenerationJob {
  readonly companyId: string;
  readonly generationId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseAiStudioGenerationJob(
  payload: unknown,
): { ok: true; payload: AiStudioGenerationJob } | { ok: false; reason: string } {
  if (typeof payload !== "object" || payload === null) {
    return { ok: false, reason: "payload is not an object" };
  }
  const { companyId, generationId } = payload as Record<string, unknown>;
  if (typeof companyId !== "string" || !UUID.test(companyId)) {
    return { ok: false, reason: "companyId is not a uuid" };
  }
  if (typeof generationId !== "string" || !UUID.test(generationId)) {
    return { ok: false, reason: "generationId is not a uuid" };
  }
  return { ok: true, payload: { companyId, generationId } };
}

export function aiStudioSingletonKey(job: AiStudioGenerationJob): string {
  return `ai-studio:${job.companyId}:${job.generationId}`;
}

/* ------------------------------------------------------------------------ *
 * Polling
 * ------------------------------------------------------------------------ */

/**
 * La espera antes del poll número `attempt` (0 = el primero), en ms. Es la
 * receta de docs.higgsfield.ai/docs/concepts/polling: arrancar en 2 s,
 * multiplicar por 1,5 hasta 10 s y sumar hasta 0,5 s de jitter. Sirve igual
 * para fal (su doc no fija un ritmo).
 */
export function pollDelayMs(attempt: number, random: number): number {
  const base = Math.min(2000 * 1.5 ** Math.max(0, attempt), 10_000);
  const jitter = Math.max(0, Math.min(1, random)) * 500;
  return Math.round(base + jitter);
}
