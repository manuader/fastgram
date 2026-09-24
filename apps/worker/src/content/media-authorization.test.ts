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
