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
 *
 * ## Sprint 8 (agente L): «ningún proveedor ofrece voz» era falso para fal
 *
 * fal documenta texto a voz (ElevenLabs Eleven v3), un talking avatar que
 * hace el lip-sync desde un retrato y un audio (OmniHuman v1.5) y el reemplazo
 * de personaje en un video (Wan 2.2 Animate Replace); ver
 * `packages/adapters/src/genai/fal-voice-catalog.ts`. Los formatos «una
 * persona dice algo» pasan a `speaking` ({@link SpeakingGenerativeFormat}) y
 * `character-swap` a `swap`. Quedan `blocked`, con el motivo exacto, los que
 * necesitan algo que ni fal ni el render dan:
 *
 * - `green-screen-mobile-app`: poner **tu app en la pantalla del teléfono**
 *   que sostiene el presentador es reemplazo de pantalla dentro del video;
 *   ningún endpoint verificado lo hace y el render no sigue un teléfono.
 * - `talking-objects`: OmniHuman está documentado para «an image of a human
 *   figure»; un objeto que habla no es eso, y no hay otro endpoint verificado.
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
  | "needs_video_to_video"
  /** Sprint 8: reemplazar la pantalla de un teléfono dentro del video. */
  | "needs_screen_replacement"
  /** Sprint 8: un avatar que habla y no es una figura humana. */
  | "needs_non_human_avatar";

/**
 * Cómo se arma la pieza de un formato con voz (sprint 8). El render ya sabe
 * cada una; ninguna pide un tipo de contenido nuevo:
 *
 * - `full`: el avatar a lienzo completo con un caption encima (`wall-of-text`).
 * - `hook-demo`: el avatar arriba diciendo el hook y un video tuyo abajo
 *   (`video-hook`: «hook arriba, demo abajo»).
 * - `corner-over-demo`: un video tuyo a lienzo completo y el avatar en una
 *   esquina, **encima** (`video-hook` con los roles invertidos: el render
 *   dibuja el segundo video sobre el primero).
 *
 * En los tres la voz entra como el bloque `audio` del payload: el render
 * descarta el audio de los videos en `wall-of-text` y `video-hook`.
 */
export type SpeakingLayout = "full" | "hook-demo" | "corner-over-demo";

export interface SpeakingGenerativeFormat {
  readonly id: GenerativeFormatId;
  readonly label: string;
  readonly description: string;
  readonly status: "speaking";
  readonly layout: SpeakingLayout;
  /** Guía al modelo de avatar (OmniHuman acepta un `prompt` opcional). En inglés. */
  readonly avatarPrompt: string;
  /** Cómo escribe el guion el modelo de texto. En inglés. */
  readonly scriptStyle: string;
  /** Qué retrato conviene, para la UI. En inglés. `null` = cualquiera. */
  readonly portraitHint: string | null;
  /** Qué video tuyo va con el avatar, para la UI. Sólo si el layout lo pide. */
  readonly demoHint: string | null;
  readonly preferredDurationSeconds: number;
}

/** `character-swap`: el retrato del modelo reemplaza a la persona de un video tuyo. */
export interface SwapGenerativeFormat {
  readonly id: GenerativeFormatId;
  readonly label: string;
  readonly description: string;
  readonly status: "swap";
}

export interface BlockedGenerativeFormat {
  readonly id: GenerativeFormatId;
  readonly label: string;
  readonly description: string;
  readonly status: "blocked";
  readonly reason: BlockedReason;
  /** En inglés, para la UI. */
  readonly why: string;
}

export type GenerativeFormat =
  | AvailableGenerativeFormat
  | BlockedGenerativeFormat
  | SpeakingGenerativeFormat
  | SwapGenerativeFormat;

const blocked = (
  id: GenerativeFormatId,
  label: string,
  description: string,
  reason: BlockedReason,
  why: string,
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

const speaking = (
  id: GenerativeFormatId,
  label: string,
  description: string,
  options: {
    readonly layout: SpeakingLayout;
    readonly avatarPrompt: string;
    readonly scriptStyle: string;
    readonly portraitHint?: string;
    readonly demoHint?: string;
    readonly preferredDurationSeconds: number;
  },
): SpeakingGenerativeFormat => ({
  id,
  label,
  description,
  status: "speaking",
  layout: options.layout,
  avatarPrompt: options.avatarPrompt,
  scriptStyle: options.scriptStyle,
  portraitHint: options.portraitHint ?? null,
  demoHint: options.demoHint ?? null,
  preferredDurationSeconds: options.preferredDurationSeconds,
});

/** En el orden de la tabla de `F-070`. */
export const GENERATIVE_FORMATS: readonly GenerativeFormat[] = [
  speaking(
    "speaking-hook",
    "Speaking Hook & Demo",
    "Someone says the hook out loud, then your demo",
    {
      layout: "hook-demo",
      avatarPrompt:
        "A person looks straight into the phone camera and says an attention-grabbing line with energy, natural hand gestures",
      scriptStyle:
        "One punchy spoken hook that makes the viewer keep watching the product demo that follows. No greeting, no hashtags.",
      demoHint:
        "Pick a screen recording or demo of your product. It plays under the speaker.",
      preferredDurationSeconds: 5,
    },
  ),
  speaking(
    "talking-head-ugc",
    "Talking Head UGC",
    "AI avatar speaks a script to camera",
    {
      layout: "full",
      avatarPrompt:
        "A person films a casual selfie-style UGC video, talking to the camera like a friend, natural expressions",
      scriptStyle:
        "A casual first-person UGC testimonial spoken to camera: hook, one concrete benefit, a soft call to action.",
      preferredDurationSeconds: 15,
    },
  ),
  speaking(
    "talking-head-green-screen",
    "Talking Head Green Screen",
    "AI avatar composited into the corner of a demo video",
    {
      layout: "corner-over-demo",
      avatarPrompt:
        "A presenter talks to the camera explaining something on screen, calm and clear",
      scriptStyle:
        "A presenter walks the viewer through what the demo on screen shows, in plain spoken language.",
      demoHint:
        "Pick the demo video to play full screen. The speaker sits in the bottom corner (as a box, not cut out).",
      preferredDurationSeconds: 15,
    },
  ),
  speaking(
    "notes-green-screen",
    "Notes Green Screen",
    "A presenter with a mic talks over an iOS Notes list",
    {
      layout: "corner-over-demo",
      avatarPrompt:
        "A presenter holding a handheld microphone talks to the camera, podcast style",
      scriptStyle:
        "A presenter with a mic reads out a short numbered list of tips, one line per item.",
      portraitHint: "A portrait of someone holding a microphone works best.",
      demoHint:
        "Pick a screen recording of your iOS Notes list. It plays full screen behind the speaker.",
      preferredDurationSeconds: 20,
    },
  ),
  blocked(
    "green-screen-mobile-app",
    "Green Screen Mobile with App",
    "A presenter holding a phone with your app on screen",
    "needs_screen_replacement",
    "Needs your app shown on the screen of the phone the presenter holds. No verified fal endpoint replaces a phone screen inside a video, and FastGram's renderer can't track one.",
  ),
  speaking(
    "product-spokesperson",
    "Product Spokesperson",
    "A character holds your product and talks about it",
    {
      layout: "full",
      avatarPrompt:
        "A spokesperson holds the product up to the camera and talks about it enthusiastically",
      scriptStyle:
        "A spokesperson presents the product they are holding: what it is, why it matters, a clear call to action.",
      portraitHint:
        "Use a photo where the character is holding your product: the video animates that photo.",
      preferredDurationSeconds: 15,
    },
  ),
  speaking(
    "street-interview",
    "Street Interview",
    "Impromptu street vox-pop that looks like unedited iPhone footage",
    {
      layout: "full",
      avatarPrompt:
        "Handheld unedited iPhone street interview footage, a passer-by answers a question on a busy sidewalk, natural daylight",
      scriptStyle:
        "An unscripted-sounding answer from a passer-by in a street interview, first person, conversational, with small hesitations.",
      portraitHint: "A photo taken outdoors on a street makes it look like real vox-pop.",
      preferredDurationSeconds: 10,
    },
  ),
  speaking(
    "news-anchor",
    "AI News Anchor",
    "A news anchor breaks your customer's problem as tonight's top story",
    {
      layout: "full",
      avatarPrompt:
        "A TV news anchor at a studio desk delivers breaking news seriously, looking into the camera",
      scriptStyle:
        "A TV news anchor breaks the customer's problem as tonight's top story, then reveals the product as the solution.",
      portraitHint: "A portrait in a newsroom or at a desk sells the anchor look.",
      preferredDurationSeconds: 15,
    },
  ),
  blocked(
    "talking-objects",
    "Talking Objects",
    "A niche object talks straight at the viewer to drive the point home",
    "needs_non_human_avatar",
    "Needs an object that talks. fal's talking-avatar model (OmniHuman v1.5) is documented for images of a human figure, and no verified endpoint animates an object's face.",
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
  {
    id: "character-swap",
    label: "Character Swap",
    description: "Swap the character in a video using AI",
    status: "swap",
  },
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

/** Sprint 8: los formatos con voz. */
export function speakingGenerativeFormats(): readonly SpeakingGenerativeFormat[] {
  return GENERATIVE_FORMATS.filter(
    (f): f is SpeakingGenerativeFormat => f.status === "speaking",
  );
}

export function findSpeakingFormat(id: string): SpeakingGenerativeFormat | undefined {
  const f = BY_ID.get(id);
  return f?.status === "speaking" ? f : undefined;
}
