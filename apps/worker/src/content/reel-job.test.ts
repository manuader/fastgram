import { MemoryMediaRenderer } from "@fastgram/adapters";
import { describe, expect, it } from "vitest";
import { isReelRenderer, reelSpecOf } from "./reel-job.js";
import { reelSpec } from "../../test/helpers/reel.js";

describe("reelSpecOf", () => {
  it("el original si no hay edición; sus URLs, en orden de capa", () => {
    const spec = reelSpec("https://m.test/media/c/");
    const out = reelSpecOf({ reel: spec }, null);
    expect(out.ok && out.spec).toEqual(spec);
    expect(out.ok && out.urls).toEqual([
      "https://m.test/media/c/bg.jpg",
      "https://m.test/media/c/gs.mp4",
      "https://m.test/audio/c/m.mp3",
    ]);
  });

  it("el editado (`studioState.reel`) gana sobre el original", () => {
    const spec = reelSpec("https://m.test/media/c/");
    const edited = { ...spec, durationSec: 12 };
    const out = reelSpecOf({ reel: spec }, { reel: edited, assets: {} });
    expect(out.ok && out.spec.durationSec).toBe(12);
  });

  it("un editado inválido no se renderiza con el original: edit_not_renderable", () => {
    const spec = reelSpec("https://m.test/media/c/");
    const out = reelSpecOf({ reel: spec }, { reel: { ...spec, durationSec: 999 } });
    expect(out).toMatchObject({ ok: false, code: "edit_not_renderable" });
  });

  it("un payload que no es de reel: invalid_build_payload", () => {
    expect(reelSpecOf({ canvas: {} }, null)).toMatchObject({
      ok: false,
      code: "invalid_build_payload",
    });
  });

  it("el renderer de memoria no sabe hacer reels", () => {
    expect(isReelRenderer(new MemoryMediaRenderer())).toBe(false);
  });
});
