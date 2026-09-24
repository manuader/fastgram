/**
 * Los 17 formatos generativos de `F-084` — `P4-FORMAT-001`/`002`, tabla de
 * `F-070`/`F-084` del PRD (labels y descripciones **literales**).
 *
 * ## Qué es un formato generativo acá
 *
 * Una **definición declarativa**: una escena para el modelo de video (texto a
 * video), una duración y una relación preferidas, y cómo entra el tema del
 * usuario o la marca a la escena. La pieza que sale es **el clip generado con
 * el texto de la marca encima**: el mismo payload `wall-of-text` que el render
 * ya compone (`FR-070`: `{canvas, video, text}`), sin tipo de contenido nuevo.
 *
 * ## Por qué siete sí y diez no
 *
 * Verificado contra la documentación de Higgsfield el 2026-09-24
 * (`docs.higgsfield.ai/docs/models/video-generation`, el índice de 66 modelos
 * de video) y contra los catálogos de los adaptadores construidos
 * (`packages/adapters/src/{higgsfield,fal,comfyui}`): **ningún proveedor
 * configurable documenta lip-sync, texto a voz ni un avatar que diga un guion
 * por API**. Los formatos que son «una persona que dice algo a cámara» no se
 * pueden hacer honestamente como «clip + texto» (el clip mostraría a alguien
 * moviendo la boca sin decir nada), así que quedan `blocked` con el motivo.
 *
 * Los cuatro stop-motion (`claymation`, `lego`, `felt`, `skeleton`) dicen
 * «with narration and captions»: se hacen **sin narración** (no hay voz) y con
 * el texto como caption. `narration: false` lo marca para que la UI lo diga.
 *
 * Las escenas son **nuestras** (FastGram), no copiadas de Fastlane: el PRD
 * sólo da el label y la descripción.
 */

export const GENERATIVE_FORMAT_IDS = [
  "speaking-hook",
  "talking-head-ugc",
  "talking-head-green-screen",
  "notes-green-screen",
  "green-screen-mobile-app",
  "product-spokesperson",
  "street-interview",
  "news-anchor",
  "talking-objects",
  "on-a-walk",
  "cutting-fruit",
  "netflix-documentary",
  "claymation",
  "lego",
  "felt",
  "skeleton",
  "character-swap",
] as const;
export type GenerativeFormatId = (typeof GENERATIVE_FORMAT_IDS)[number];

/**
 * Qué entra a la escena además de la escena fija:
 * - `topic`: el tema del usuario, como detalle de la escena («walking past …»).
 * - `brand`: el tema, o si no hay, lo que ofrece la marca (el producto que
 *   aparece en un stop-motion).
 */
export type SubjectMode = "topic" | "brand";

export interface AvailableGenerativeFormat {
  readonly id: GenerativeFormatId;
  readonly label: string;
  readonly description: string;
  readonly status: "available";
  /** La escena base, en inglés (los modelos de video la entienden mejor). */
  readonly scene: string;
  /** Cómo se engancha el sujeto: `{subject}` se reemplaza. */
  readonly subjectTemplate: string;
  readonly subject: SubjectMode;
  /** Duración que se pide si el modelo la acepta; si no, la más cercana. */
  readonly preferredDurationSeconds: number;
  /** Vertical: es lo que publica la app. */
  readonly aspectRatio: "9:16";
  /** El PRD la describe con narración y acá no la hay (ver cabecera). */
  readonly narration: boolean;
}

export type BlockedReason =
  /** Necesita a alguien diciendo un guion con voz y labios sincronizados. */
  | "needs_voice"
  /** Necesita editar un video existente (video a video). */
  | "needs_video_to_video";

export interface BlockedGenerativeFormat {
  readonly id: GenerativeFormatId;
  readonly label: string;
  readonly description: string;
  readonly status: "blocked";
  readonly reason: BlockedReason;
  /** En inglés, para la UI. */
  readonly why: string;
}

export type GenerativeFormat = AvailableGenerativeFormat | BlockedGenerativeFormat;

const NEEDS_VOICE =
  "Needs a person speaking a script with a synced voice. None of the video providers FastGram supports (Higgsfield, fal, ComfyUI) documents lip-sync or text-to-speech by API, so it can't be generated yet.";

const blocked = (
  id: GenerativeFormatId,
  label: string,
  description: string,
  reason: BlockedReason = "needs_voice",
  why: string = NEEDS_VOICE,
): BlockedGenerativeFormat => ({
  id,
  label,
  description,
  status: "blocked",
  reason,
  why,
});

const clip = (
  id: GenerativeFormatId,
  label: string,
  description: string,
  scene: string,
  subjectTemplate: string,
  options: {
    readonly subject?: SubjectMode;
    readonly preferredDurationSeconds?: number;
    readonly narration?: boolean;
  } = {},
): AvailableGenerativeFormat => ({
  id,
  label,
  description,
  status: "available",
  scene,
  subjectTemplate,
  subject: options.subject ?? "topic",
  preferredDurationSeconds: options.preferredDurationSeconds ?? 5,
  aspectRatio: "9:16",
  narration: options.narration ?? false,
});

/** En el orden de la tabla de `F-070`. */
export const GENERATIVE_FORMATS: readonly GenerativeFormat[] = [
  blocked(
    "speaking-hook",
    "Speaking Hook & Demo",
    "Someone says the hook out loud, then your demo",
  ),
  blocked("talking-head-ugc", "Talking Head UGC", "AI avatar speaks a script to camera"),
  blocked(
    "talking-head-green-screen",
    "Talking Head Green Screen",
    "AI avatar composited into the corner of a demo video",
  ),
  blocked(
    "notes-green-screen",
    "Notes Green Screen",
    "A presenter with a mic talks over an iOS Notes list",
  ),
  blocked(
    "green-screen-mobile-app",
    "Green Screen Mobile with App",
    "A presenter holding a phone with your app on screen",
  ),
  blocked(
    "product-spokesperson",
    "Product Spokesperson",
    "A character holds your product and talks about it",
  ),
  blocked(
    "street-interview",
    "Street Interview",
    "Impromptu street vox-pop that looks like unedited iPhone footage",
  ),
  blocked(
    "news-anchor",
    "AI News Anchor",
    "A news anchor breaks your customer's problem as tonight's top story",
  ),
  blocked(
    "talking-objects",
    "Talking Objects",
    "A niche object talks straight at the viewer to drive the point home",
  ),
  clip(
    "on-a-walk",
    "On a Walk",
    "Your text over a generated walking selfie",
    "Vertical handheld selfie video of a young adult walking outdoors on a sunny city sidewalk, looking into the phone camera with a relaxed, thoughtful expression, natural daylight, realistic smartphone footage, slight camera shake, no text on screen",
    "the surroundings hint at {subject}",
  ),
  clip(
    "cutting-fruit",
    "Cutting Fruit",
    "Your text over a generated kitchen clip",
    "Vertical close-up video of hands slicing fresh colorful fruit on a wooden cutting board in a bright home kitchen, satisfying clean cuts, soft window light, shallow depth of field, realistic, no text on screen",
    "with {subject} visible on the counter",
  ),
  clip(
    "netflix-documentary",
    "Netflix Documentary",
    "Your text over a generated interview clip",
    "Vertical cinematic documentary interview shot of a person seated in a dim room, looking slightly off camera, moody low-key lighting, shallow depth of field, film grain, slow push-in, no text on screen",
    "the setting suggests {subject}",
  ),
  clip(
    "claymation",
    "Claymation",
    "Stop-motion clay ad with narration and captions",
    "Vertical stop-motion claymation video, handmade plasticine characters and set, visible fingerprints on the clay, slightly jerky frame-by-frame motion, warm studio lighting, no text on screen",
    "the scene shows {subject}",
    { subject: "brand" },
  ),
  clip(
    "lego",
    "Lego",
    "Stop-motion Lego brick ad with narration and captions",
    "Vertical stop-motion video built entirely from plastic toy bricks and minifigures, frame-by-frame animation, bright toy colors, tabletop miniature set, no logos, no text on screen",
    "the scene shows {subject}",
    { subject: "brand" },
  ),
  clip(
    "felt",
    "Felt",
    "Stop-motion felt ad with narration and captions",
    "Vertical stop-motion video made of felt and fabric cutouts, stitched textures, handcrafted cozy look, frame-by-frame animation, soft even lighting, no text on screen",
    "the scene shows {subject}",
    { subject: "brand" },
  ),
  clip(
    "skeleton",
    "Skeleton",
    "Educational skeleton video with narration and captions",
    "Vertical educational video of a friendly cartoon-style 3D human skeleton standing in a clean classroom setting, gesturing as if explaining something, bright even lighting, no text on screen",
    "the skeleton points at {subject}",
    { subject: "brand" },
  ),
  blocked(
    "character-swap",
    "Character Swap",
    "Swap the character in a video using AI",
    "needs_video_to_video",
    "Needs video-to-video character replacement. Higgsfield lists motion-control workflows, but FastGram has no verified adapter for them yet, so it can't be generated.",
  ),
];

const BY_ID = new Map<string, GenerativeFormat>(GENERATIVE_FORMATS.map((f) => [f.id, f]));

export function isGenerativeFormatId(value: string): value is GenerativeFormatId {
  return BY_ID.has(value);
}

export function findGenerativeFormat(id: string): GenerativeFormat | undefined {
  return BY_ID.get(id);
}

export function availableGenerativeFormats(): readonly AvailableGenerativeFormat[] {
  return GENERATIVE_FORMATS.filter(
    (f): f is AvailableGenerativeFormat => f.status === "available",
  );
}

/**
 * Para «Create from prompt» de Blitz (agente C): si el texto nombra un
 * formato generativo **disponible** («a claymation about…», «on a walk»),
 * cuál. Busca el label o el id con palabras completas, sin distinguir
 * mayúsculas. `null` si no nombra ninguno o nombra uno bloqueado.
 */
export function matchGenerativeFormat(text: string): AvailableGenerativeFormat | null {
  const haystack = ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  for (const f of availableGenerativeFormats()) {
    const needles = [f.id.replace(/-/g, " "), f.label.toLowerCase()];
    if (needles.some((n) => haystack.includes(` ${n} `))) return f;
  }
  return null;
}
