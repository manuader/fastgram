/**
 * Los 22 formatos del Content Studio · F-070/F-084 (PRD:528-553).
 *
 * `label` y `description` son **literales del PRD**: la tabla está marcada
 * "labels y descripciones literales, CONFIRMED [APP]". No se editan aquí sin
 * editar el PRD.
 *
 * El orden es el de la tabla del PRD, que no es alfabético: empieza por los
 * cuatro formatos de la generación A (los que el Content Studio legacy tenía
 * como tabs, PRD §3.3) y sigue por los añadidos después. Ese orden es
 * información —dice cuáles son los formatos "de siempre"— y por eso se conserva.
 */

export interface ContentFormat {
  /** `id` del PRD. Es también el segmento de `/content/<id>`. */
  readonly id: string;
  readonly label: string;
  readonly description: string;
}

export const CONTENT_FORMATS = [
  {
    id: "slideshow",
    label: "Slideshow",
    description: "Multi-image carousel with captions",
  },
  {
    id: "wall-of-text",
    label: "Wall of Text",
    description: "Bold text on a plain background",
  },
  {
    id: "video-hook-and-demo",
    label: "Video Hook & Demo",
    description: "Hook clip + app demo stitched together",
  },
  {
    id: "green-screen-meme",
    label: "Green Screen Meme",
    description: "Trending video with your background image",
  },
  { id: "custom", label: "Custom", description: "Upload your own video or image" },
  {
    id: "speaking-hook",
    label: "Speaking Hook & Demo",
    description: "Someone says the hook out loud, then your demo",
  },
  {
    id: "talking-head-ugc",
    label: "Talking Head UGC",
    description: "AI avatar speaks a script to camera",
  },
  {
    id: "talking-head-green-screen",
    label: "Talking Head Green Screen",
    description: "AI avatar composited into the corner of a demo video",
  },
  {
    id: "notes-green-screen",
    label: "Notes Green Screen",
    description: "A presenter with a mic talks over an iOS Notes list",
  },
  {
    id: "green-screen-mobile-app",
    label: "Green Screen Mobile with App",
    description: "A presenter holding a phone with your app on screen",
  },
  {
    id: "product-spokesperson",
    label: "Product Spokesperson",
    description: "A character holds your product and talks about it",
  },
  {
    id: "street-interview",
    label: "Street Interview",
    description: "Impromptu street vox-pop that looks like unedited iPhone footage",
  },
  {
    id: "news-anchor",
    label: "AI News Anchor",
    description: "A news anchor breaks your customer's problem as tonight's top story",
  },
  {
    id: "talking-objects",
    label: "Talking Objects",
    description: "A niche object talks straight at the viewer to drive the point home",
  },
  {
    id: "on-a-walk",
    label: "On a Walk",
    description: "Your text over a generated walking selfie",
  },
  {
    id: "cutting-fruit",
    label: "Cutting Fruit",
    description: "Your text over a generated kitchen clip",
  },
  {
    id: "netflix-documentary",
    label: "Netflix Documentary",
    description: "Your text over a generated interview clip",
  },
  {
    id: "claymation",
    label: "Claymation",
    description: "Stop-motion clay ad with narration and captions",
  },
  {
    id: "lego",
    label: "Lego",
    description: "Stop-motion Lego brick ad with narration and captions",
  },
  {
    id: "felt",
    label: "Felt",
    description: "Stop-motion felt ad with narration and captions",
  },
  {
    id: "skeleton",
    label: "Skeleton",
    description: "Educational skeleton video with narration and captions",
  },
  {
    id: "character-swap",
    label: "Character Swap",
    description: "Swap the character in a video using AI",
  },
] as const satisfies readonly ContentFormat[];

export type ContentFormatId = (typeof CONTENT_FORMATS)[number]["id"];

const BY_ID = new Map<string, ContentFormat>(
  CONTENT_FORMATS.map((format) => [format.id, format]),
);

/** `undefined` para cualquier segmento que no sea uno de los 22 → la página hace `notFound()`. */
/**
 * Formatos del PRD que **no se ofrecen** (decisión del dueño, 2026-09-24: "los
 * modelos que no existen en Higgsfield o similares no los agregues"). No hay
 * endpoint verificado que anime un objeto (OmniHuman es para figuras humanas)
 * ni que reemplace la pantalla de un teléfono dentro de un video. Siguen en la
 * lista de arriba porque son literales del PRD; el hub y las rutas los ocultan.
 */
export const EXCLUDED_FORMAT_IDS: ReadonlySet<string> = new Set([
  "talking-objects",
  "green-screen-mobile-app",
]);

export function findContentFormat(id: string): ContentFormat | undefined {
  return BY_ID.get(id);
}
