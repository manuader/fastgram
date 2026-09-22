/**
 * El catálogo de formatos del Content Studio · `F-070`/`F-084` (PRD:528-553).
 *
 * ## Por qué este archivo es una copia de la tabla del PRD
 *
 * `formats.ts` dice en su cabecera que `label` y `description` son **literales
 * del PRD** y que el orden es información. Nada lo comprobaba: hasta hoy el
 * catálogo podía perder una fila, ganar una, o cambiar un texto, y lo único que
 * cambiaba era la pantalla.
 *
 * Por eso la tabla de abajo está escrita a mano desde `PRD.md:531-553` en vez
 * de derivarse de `CONTENT_FORMATS`. Un test que hiciera
 * `expect(CONTENT_FORMATS).toHaveLength(CONTENT_FORMATS.length)` pasa siempre y
 * no mide nada; éste falla el día que el código y el PRD dejen de decir lo
 * mismo, que es justo el día en que hay que decidir cuál de los dos está mal.
 *
 * Y el **22** va escrito como número, no como `PRD_FORMATS.length`: el PRD lo
 * nombra ("Catálogo de 22 formatos", PRD:512) y `F-084` cuenta 17 generativos
 * sobre los 5 originales. Si alguien borra una fila de las dos listas a la vez,
 * el número lo atrapa igual.
 */
import { describe, expect, it } from "vitest";
import { CONTENT_FORMATS, findContentFormat } from "./formats";

/** `[id, label, description, path]`, copiado de la tabla de PRD:531-553. */
const PRD_FORMATS: readonly (readonly [string, string, string, string])[] = [
  ["slideshow", "Slideshow", "Multi-image carousel with captions", "/content/slideshow"],
  [
    "wall-of-text",
    "Wall of Text",
    "Bold text on a plain background",
    "/content/wall-of-text",
  ],
  [
    "video-hook-and-demo",
    "Video Hook & Demo",
    "Hook clip + app demo stitched together",
    "/content/video-hook-and-demo",
  ],
  [
    "green-screen-meme",
    "Green Screen Meme",
    "Trending video with your background image",
    "/content/green-screen-meme",
  ],
  ["custom", "Custom", "Upload your own video or image", "/content/custom"],
  [
    "speaking-hook",
    "Speaking Hook & Demo",
    "Someone says the hook out loud, then your demo",
    "/content/speaking-hook",
  ],
  [
    "talking-head-ugc",
    "Talking Head UGC",
    "AI avatar speaks a script to camera",
    "/content/talking-head-ugc",
  ],
  [
    "talking-head-green-screen",
    "Talking Head Green Screen",
    "AI avatar composited into the corner of a demo video",
    "/content/talking-head-green-screen",
  ],
  [
    "notes-green-screen",
    "Notes Green Screen",
    "A presenter with a mic talks over an iOS Notes list",
    "/content/notes-green-screen",
  ],
  [
    "green-screen-mobile-app",
    "Green Screen Mobile with App",
    "A presenter holding a phone with your app on screen",
    "/content/green-screen-mobile-app",
  ],
  [
    "product-spokesperson",
    "Product Spokesperson",
    "A character holds your product and talks about it",
    "/content/product-spokesperson",
  ],
  [
    "street-interview",
    "Street Interview",
    "Impromptu street vox-pop that looks like unedited iPhone footage",
    "/content/street-interview",
  ],
  [
    "news-anchor",
    "AI News Anchor",
    "A news anchor breaks your customer's problem as tonight's top story",
    "/content/news-anchor",
  ],
  [
    "talking-objects",
    "Talking Objects",
    "A niche object talks straight at the viewer to drive the point home",
    "/content/talking-objects",
  ],
  [
    "on-a-walk",
    "On a Walk",
    "Your text over a generated walking selfie",
    "/content/on-a-walk",
  ],
  [
    "cutting-fruit",
    "Cutting Fruit",
    "Your text over a generated kitchen clip",
    "/content/cutting-fruit",
  ],
  [
    "netflix-documentary",
    "Netflix Documentary",
    "Your text over a generated interview clip",
    "/content/netflix-documentary",
  ],
  [
    "claymation",
    "Claymation",
    "Stop-motion clay ad with narration and captions",
    "/content/claymation",
  ],
  [
    "lego",
    "Lego",
    "Stop-motion Lego brick ad with narration and captions",
    "/content/lego",
  ],
  ["felt", "Felt", "Stop-motion felt ad with narration and captions", "/content/felt"],
  [
    "skeleton",
    "Skeleton",
    "Educational skeleton video with narration and captions",
    "/content/skeleton",
  ],
  [
    "character-swap",
    "Character Swap",
    "Swap the character in a video using AI",
    "/content/character-swap",
  ],
];

describe("el catálogo es el del PRD · F-070/F-084 (PRD:528-553)", () => {
  it("son exactamente 22 formatos", () => {
    // El número del PRD, escrito. No `PRD_FORMATS.length`.
    expect(CONTENT_FORMATS).toHaveLength(22);
    expect(PRD_FORMATS).toHaveLength(22);
  });

  it("id, label y description son los de la tabla, y en su orden", () => {
    expect(
      CONTENT_FORMATS.map((format) => [format.id, format.label, format.description]),
    ).toEqual(PRD_FORMATS.map(([id, label, description]) => [id, label, description]));
  });

  it("el `path` del PRD es `/content/<id>`: el id **es** el segmento de la ruta", () => {
    // Si algún día un formato tuviera un path que no se deriva de su id, la
    // ruta dinámica `/content/[format]` dejaría de alcanzarlo y la tarjeta del
    // hub llevaría a un 404. Esto lo detecta antes.
    for (const [id, , , path] of PRD_FORMATS) {
      expect(path).toBe(`/content/${id}`);
    }
  });

  it("no hay ids repetidos: dos tarjetas al mismo sitio serían la misma pantalla", () => {
    const ids = CONTENT_FORMATS.map((format) => format.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("resolver un segmento de `/content/<id>`", () => {
  it("los 22 ids del PRD resuelven a su formato", () => {
    for (const [id, label] of PRD_FORMATS) {
      expect(findContentFormat(id)?.label).toBe(label);
    }
  });

  it.each(["", "no-existe", "Slideshow", "slideshow ", "__proto__", "constructor"])(
    "%p no es un formato: `undefined`, que la página traduce a 404",
    (segment) => {
      // `__proto__` y `constructor` están acá por el `Map`: con un objeto plano
      // como índice, los dos devolverían algo que no es un formato y la página
      // pintaría basura en vez de un 404.
      expect(findContentFormat(segment)).toBeUndefined();
    },
  );
});
