/**
 * El grant del build autoriza la biblioteca de audio **de la marca** (sprint 7).
 *
 * Antes `sharedPrefixes` iba vacío y todo build con música moría en el render
 * con `audio_fuera_de_libreria`. El cruce con la política real del servicio
 * está en `services/render/src/media/urlPolicy.test.ts` ("biblioteca de la
 * marca"); acá se fija lo que el worker firma.
 */
import { FixedClock, MemoryStorage, canonicalObjectUrl } from "@fastgram/adapters";
import { brandAudioKeyPrefix } from "@fastgram/contracts";
import type { RenderJob } from "@fastgram/ports";
import { describe, expect, it } from "vitest";

import { mediaUrlsOf, workspaceMediaAuthorization } from "./media-authorization.js";

const CO = "11111111-1111-4111-8111-111111111111";

const text = {
  content: "hola",
  x: 540,
  y: 960,
  width: 900,
  fontSize: 64,
  color: "#FFFFFF",
  textAlign: "center",
} as const;
const box = { drawX: 0, drawY: 0, drawW: 1080, drawH: 1920 };
const canvas = { width: 1080, height: 1920 };

describe("workspaceMediaAuthorization · biblioteca de audio de la marca", () => {
  it("firma `audio/{companyId}/` como librería, y nada más", async () => {
    const storage = new MemoryStorage(new FixedClock());
    const grant = await workspaceMediaAuthorization(storage, {
      companyId: CO,
      objectPrefix: "content",
      urls: [],
    });
    expect(grant.sharedPrefixes).toEqual([
      await canonicalObjectUrl(storage, `${brandAudioKeyPrefix(CO)}/`),
    ]);
    // El prefijo de audio no se cuela entre los del Media Bank.
    expect(grant.mediaPrefixes).not.toContain(grant.sharedPrefixes[0]);
  });
});

describe("mediaUrlsOf · la música entra en la lista exacta", () => {
  const audio = { url: "https://bucket.test/audio/co/m.mp3" };

  it("green-screen con música la lista (sprint 7)", () => {
    const job: RenderJob = {
      format: "green-screen",
      canvas,
      image: { url: "https://bucket.test/media/co/bg.jpg", ...box },
      video: { url: "https://bucket.test/media/co/meme.mp4", ...box },
      audio,
      text,
    };
    expect(mediaUrlsOf(job)).toContain(audio.url);
  });

  it("green-screen sin música no inventa una URL", () => {
    const job: RenderJob = {
      format: "green-screen",
      canvas,
      image: { url: "https://bucket.test/media/co/bg.jpg", ...box },
      video: { url: "https://bucket.test/media/co/meme.mp4", ...box },
      text,
    };
    expect(mediaUrlsOf(job)).toHaveLength(2);
  });

  it("wall-of-text y video-hook la siguen listando", () => {
    const wall: RenderJob = {
      format: "wall-of-text",
      canvas,
      video: { url: "https://bucket.test/media/co/v.mp4", ...box },
      audio,
      text,
    };
    expect(mediaUrlsOf(wall)).toContain(audio.url);
  });
});

describe("sprint 9 (S) · fuentes de marca, logo y biblioteca global en el grant", () => {
  const job: RenderJob = {
    format: "green-screen",
    canvas,
    image: { url: "https://bucket.test/media/co/bg.jpg", ...box },
    video: { url: "https://bucket.test/media/co/meme.mp4", ...box },
    text: { ...text, fontFamily: "brand:rotis" },
    brand: {
      fonts: [
        {
          id: "rotis",
          weight: 700,
          style: "normal",
          url: "https://bucket.test/fonts/co/r.otf",
        },
      ],
      logo: {
        images: [{ url: "https://bucket.test/media/co/design-system/d/logo/a.png" }],
        corner: "top-right",
        size: "small",
        opacity: 1,
      },
    },
  };

  it("mediaUrlsOf lista las caras y las variantes del logo", () => {
    expect(mediaUrlsOf(job)).toEqual([
      "https://bucket.test/media/co/bg.jpg",
      "https://bucket.test/media/co/meme.mp4",
      "https://bucket.test/fonts/co/r.otf",
      "https://bucket.test/media/co/design-system/d/logo/a.png",
    ]);
  });

  it("el grant cubre `fonts/{companyId}/` (y no el de otra marca)", async () => {
    const storage = new MemoryStorage(new FixedClock());
    const grant = await workspaceMediaAuthorization(storage, {
      companyId: CO,
      objectPrefix: "content",
      urls: [],
    });
    const fonts = await canonicalObjectUrl(storage, `fonts/${CO}/`);
    expect(grant.mediaPrefixes).toContain(fonts);
    expect(grant.mediaPrefixes).not.toContain(
      await canonicalObjectUrl(storage, "fonts/"),
    );
  });

  it("con un asset `library/…` suma la biblioteca global; sin él, no", async () => {
    const storage = new MemoryStorage(new FixedClock());
    const library = await canonicalObjectUrl(storage, "library/");
    const mine = await canonicalObjectUrl(storage, `media/${CO}/a.jpg`);
    const without = await workspaceMediaAuthorization(storage, {
      companyId: CO,
      objectPrefix: "content",
      urls: [mine],
    });
    expect(without.sharedPrefixes).not.toContain(library);

    const clip = await canonicalObjectUrl(storage, "library/commons/clip.mp4");
    const withLib = await workspaceMediaAuthorization(storage, {
      companyId: CO,
      objectPrefix: "content",
      urls: [mine, clip],
    });
    expect(withLib.sharedPrefixes).toContain(library);
    // La URL exacta sigue siendo el cierre: el grant no abre la biblioteca entera.
    expect(withLib.urls).toEqual([mine, clip]);
  });
});
