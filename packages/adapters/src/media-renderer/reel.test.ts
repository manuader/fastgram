import { describe, expect, it } from "vitest";
import { isPortError, type MediaAuthorization } from "@fastgram/ports";
import { FixedClock } from "../clock/index.js";
import {
  HttpMediaRenderer,
  parseReelRenderResponse,
  REEL_TIMEOUT_MS,
  type RenderFetch,
} from "./http-media-renderer.js";

const AUTH: MediaAuthorization = {
  companyId: "com_prueba",
  mediaPrefixes: ["https://media.test/"],
  sharedPrefixes: ["https://library.test/"],
};

const SPEC = { version: 1, durationSec: 10, layers: [] };

function renderer(handler: (url: string, init: Parameters<RenderFetch>[1]) => Response) {
  const calls: { url: string; body: unknown }[] = [];
  const fetch: RenderFetch = async (url, init) => {
    calls.push({
      url,
      body: init.body === undefined ? undefined : JSON.parse(init.body),
    });
    return handler(url, init);
  };
  const r = new HttpMediaRenderer({
    baseUrl: "http://render.test",
    engineVersion: "e1",
    fetch,
    clock: new FixedClock(1_000_000),
    grantSecret: "x".repeat(40),
  });
  return { r, calls };
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("HttpMediaRenderer · reels", () => {
  it("POST /reels/render con el spec, la calidad y el grant firmado; baja el MP4 por el href", async () => {
    const mp4 = new Uint8Array([1, 2, 3, 4]);
    const { r, calls } = renderer((url) =>
      url.endsWith("/reels/render")
        ? json({
            type: "reel",
            href: "/artifact/abc.mp4",
            bytes: 4,
            warnings: [],
            captions: { subs: [{ text: "hi", start: 1, end: 1.2 }] },
          })
        : new Response(mp4, {
            headers: { "content-type": "video/mp4", "content-length": "4" },
          }),
    );
    const build = await r.renderReel({ spec: SPEC, quality: "draft" }, AUTH);
    expect(calls[0]?.url).toBe("http://render.test/reels/render");
    expect(calls[0]?.body).toMatchObject({
      spec: SPEC,
      quality: "draft",
      grant: { body: { companyId: "com_prueba" } },
    });
    expect(build.captions).toEqual({ subs: [{ text: "hi", start: 1, end: 1.2 }] });
    const media = await build.artifact.open();
    expect(media).toMatchObject({
      contentType: "video/mp4",
      sizeBytes: 4,
      width: 1080,
      height: 1920,
    });
    const chunks: number[] = [];
    for await (const c of media.body) chunks.push(...c);
    expect(chunks).toEqual([1, 2, 3, 4]);
    expect(calls[1]?.url).toBe("http://render.test/artifact/abc.mp4");
  });

  it("traduce el error del servicio a un código estable", async () => {
    const { r } = renderer(() =>
      json({ error: { code: "media_url_not_allowed", message: "x", details: {} } }, 400),
    );
    const error = await r
      .renderReel({ spec: SPEC, quality: "delivery" }, AUTH)
      .catch((e: unknown) => e);
    expect(isPortError(error)).toBe(true);
  });

  it("preview devuelve el HTML y valida la forma", async () => {
    const { r, calls } = renderer(() =>
      json({ html: "<!doctype html>", durationSec: 10, warnings: ["w"] }),
    );
    await expect(r.previewReel(SPEC, AUTH)).resolves.toEqual({
      html: "<!doctype html>",
      durationSec: 10,
      warnings: ["w"],
    });
    expect(calls[0]?.url).toBe("http://render.test/reels/preview-html");
    const bad = renderer(() => json({ nope: true })).r;
    await expect(bad.previewReel(SPEC, AUTH)).rejects.toMatchObject({
      code: "provider_contract_violation",
    });
  });

  it("parsea la respuesta: sin href o de otro tipo es violación; palabras rotas se descartan", () => {
    expect(() =>
      parseReelRenderResponse({ type: "slideshow", href: "/a", bytes: 1 }),
    ).toThrow();
    expect(() => parseReelRenderResponse({ type: "reel", bytes: 1 })).toThrow();
    expect(
      parseReelRenderResponse({
        type: "reel",
        href: "/artifact/a.mp4",
        bytes: 9,
        captions: { c: [{ text: "ok", start: 0, end: 1 }, { text: 3 }] },
      }).captions,
    ).toEqual({ c: [{ text: "ok", start: 0, end: 1 }] });
  });

  it("espera más que un /render: el servicio corre de a uno con cola", () => {
    expect(REEL_TIMEOUT_MS).toBe(660_000);
  });
});
