import { describe, expect, it } from "vitest";
import { MEDIA_IMPORT_FAILURE_CODES, type ModelRegistrySnapshot } from "@fastgram/ports";

import {
  FAL_BIREFNET_VIDEO_ENDPOINT,
  FAL_QUEUE_BASE_URL,
  GREEN_SCREEN_CATEGORY,
  categoriesForOriginal,
  checkImportUrl,
  importStatusKey,
  isMediaImportFailureCode,
  mediaMetaKey,
  parseMediaImportJob,
  parseMediaImportStatus,
  resolveBackgroundRemovalConfig,
  wantsForeground,
} from "./media-import.js";
import { greenScreenVerdict, isGreenSample } from "./green-screen.js";
import { extractJsonObject, parseClipTags } from "./clip-tags.js";

const C = "11111111-1111-4111-8111-111111111111";
const I = "22222222-2222-4222-8222-222222222222";
const M = "33333333-3333-4333-8333-333333333333";

describe("checkImportUrl", () => {
  it("acepta http y https y normaliza", () => {
    expect(checkImportUrl("  https://www.youtube.com/watch?v=abc ")).toEqual({
      ok: true,
      url: "https://www.youtube.com/watch?v=abc",
    });
    expect(checkImportUrl("http://commons.wikimedia.org/x.webm").ok).toBe(true);
  });

  it.each([
    ["file:///etc/passwd"],
    ["ftp://example.com/a.mp4"],
    ["javascript:alert(1)"],
    ["data:video/mp4;base64,AAAA"],
    ["no es una url"],
    [""],
    ["https://user:pass@example.com/v"],
    ["http://localhost:3001/api"],
    ["http://127.0.0.1/"],
    ["http://2130706433/"],
    ["http://10.0.0.5/v.mp4"],
    ["http://192.168.1.10/v.mp4"],
    ["http://169.254.169.254/latest/meta-data"],
    ["http://[::1]/"],
    ["http://[::ffff:127.0.0.1]/"],
    ["http://minio.local/bucket/x"],
    ["http://intranet/"],
  ])("rechaza %s con unsupported_url", (raw) => {
    const r = checkImportUrl(raw);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.code).toBe("unsupported_url");
  });

  it("rechaza una URL gigante", () => {
    expect(checkImportUrl(`https://example.com/${"a".repeat(2100)}`).ok).toBe(false);
  });
});

describe("códigos de fallo", () => {
  it("son exactamente los cuatro estables", () => {
    expect([...MEDIA_IMPORT_FAILURE_CODES]).toEqual([
      "unsupported_url",
      "too_long",
      "too_large",
      "download_failed",
    ]);
    expect(isMediaImportFailureCode("too_long")).toBe(true);
    expect(isMediaImportFailureCode("ERROR: [youtube] abc: Video unavailable")).toBe(
      false,
    );
  });
});

describe("parseMediaImportJob", () => {
  const ok = {
    companyId: C,
    importId: I,
    mediaId: M,
    url: "https://x.example/v",
    kind: "video",
  };

  it("acepta el payload y completa categorías", () => {
    expect(parseMediaImportJob(ok)).toEqual({ ok: true, job: { ...ok, categories: [] } });
  });

  it("rechaza ids que no son uuid y kinds desconocidos", () => {
    expect(parseMediaImportJob({ ...ok, mediaId: "x" }).ok).toBe(false);
    expect(parseMediaImportJob({ ...ok, kind: "image" }).ok).toBe(false);
    expect(parseMediaImportJob({ ...ok, categories: [1] }).ok).toBe(false);
    expect(parseMediaImportJob(null).ok).toBe(false);
  });
});

describe("claves de storage", () => {
  it("llevan el companyId en el prefijo (el scope)", () => {
    expect(importStatusKey(C, I)).toBe(`media-imports/${C}/${I}.json`);
    expect(mediaMetaKey(C, M)).toBe(`media-meta/${C}/${M}.json`);
  });

  it("un estado roto o con un error inventado se lee como inexistente", () => {
    const base = {
      importId: I,
      kind: "video",
      state: "failed",
      sourceUrl: "https://x.example",
      updatedAt: 1,
    };
    expect(parseMediaImportStatus({ ...base, error: "too_long" })).not.toBeNull();
    expect(parseMediaImportStatus({ ...base, error: "stderr crudo" })).toBeNull();
    expect(parseMediaImportStatus({ ...base, state: "done" })).toBeNull();
    expect(parseMediaImportStatus("x")).toBeNull();
  });
});

describe("categorías según lo medido", () => {
  it("un clip verde suma green-screen-video aunque no se pidiera", () => {
    expect(categoriesForOriginal(["hook-video"], true)).toEqual([
      "hook-video",
      GREEN_SCREEN_CATEGORY,
    ]);
  });

  it("un clip no verde pierde green-screen-video: el croma lo rompería", () => {
    expect(categoriesForOriginal([GREEN_SCREEN_CATEGORY, "hook-video"], false)).toEqual([
      "hook-video",
    ]);
    expect(wantsForeground([GREEN_SCREEN_CATEGORY])).toBe(true);
    expect(wantsForeground(["hook-video"])).toBe(false);
  });
});

describe("resolveBackgroundRemovalConfig", () => {
  const snap = (
    entry: ModelRegistrySnapshot["tasks"]["background_removal"],
  ): ModelRegistrySnapshot => ({
    tasks: entry === undefined ? {} : { background_removal: entry },
  });

  it("sin entrada: unset", () => {
    expect(resolveBackgroundRemovalConfig(snap(undefined), {})).toEqual({
      ok: false,
      why: "unset",
    });
  });

  it("fal con key y modelo vacío usa el endpoint verificado de BiRefNet video", () => {
    const r = resolveBackgroundRemovalConfig(
      snap({
        provider: "custom",
        baseUrl: "https://queue.fal.run",
        model: "",
        apiKey: "k-123",
      }),
      {},
    );
    expect(r).toEqual({
      ok: true,
      config: {
        baseUrl: FAL_QUEUE_BASE_URL,
        endpoint: FAL_BIREFNET_VIDEO_ENDPOINT,
        apiKey: "k-123",
      },
    });
  });

  it("la key puede venir del entorno", () => {
    const r = resolveBackgroundRemovalConfig(
      snap({
        provider: "custom",
        baseUrl: "https://queue.fal.run/",
        model: "fal-ai/birefnet/v2/video",
        apiKeyEnv: "FAL_KEY",
      }),
      { FAL_KEY: "from-env" },
    );
    expect(r.ok && r.config.apiKey).toBe("from-env");
  });

  it("otro host no recibe la key de fal", () => {
    expect(
      resolveBackgroundRemovalConfig(
        snap({
          provider: "custom",
          baseUrl: "https://evil.example",
          model: "m",
          apiKey: "k",
        }),
        {},
      ),
    ).toEqual({ ok: false, why: "unsupported_endpoint" });
    expect(
      resolveBackgroundRemovalConfig(
        snap({
          provider: "custom",
          baseUrl: "http://queue.fal.run",
          model: "m/x",
          apiKey: "k",
        }),
        {},
      ),
    ).toEqual({ ok: false, why: "unsupported_endpoint" });
  });

  it("un modelo con forma de ruta rara se rechaza (va en la URL)", () => {
    expect(
      resolveBackgroundRemovalConfig(
        snap({
          provider: "custom",
          baseUrl: FAL_QUEUE_BASE_URL,
          model: "../x",
          apiKey: "k",
        }),
        {},
      ).ok,
    ).toBe(false);
  });

  it("sin key: no_key", () => {
    expect(
      resolveBackgroundRemovalConfig(
        snap({ provider: "custom", baseUrl: FAL_QUEUE_BASE_URL, model: "a/b" }),
        {},
      ),
    ).toEqual({ ok: false, why: "no_key" });
  });
});

describe("greenScreenVerdict", () => {
  const green = { r: 0, g: 255, b: 0 };
  const chroma = { r: 0, g: 177, b: 64 };
  const skin = { r: 220, g: 170, b: 140 };
  const gray = { r: 120, g: 120, b: 120 };

  it("verde puro y verde croma cuentan; piel y gris no", () => {
    expect(isGreenSample(green)).toBe(true);
    expect(isGreenSample(chroma)).toBe(true);
    expect(isGreenSample(skin)).toBe(false);
    expect(isGreenSample(gray)).toBe(false);
    expect(isGreenSample({ r: 0, g: 60, b: 0 })).toBe(false);
  });

  it("verde si al menos 60 % del borde es verde, con el color promedio", () => {
    const v = greenScreenVerdict([green, green, green, skin]);
    expect(v.isGreen).toBe(true);
    expect(v.keyColor).toBe("#00FF00");
    expect(greenScreenVerdict([green, skin, gray]).isGreen).toBe(false);
    expect(greenScreenVerdict([])).toEqual({ isGreen: false, share: 0, keyColor: null });
  });
});

describe("parseClipTags", () => {
  it("acepta la forma pedida y normaliza", () => {
    expect(
      parseClipTags({
        emotion: " Shocked ",
        situation: "a man\nsees the bill",
        people: 1.4,
        tags: ["Money", "money", "reaction", "", 3],
      }),
    ).toEqual({
      emotion: "Shocked",
      situation: "a man sees the bill",
      people: 1,
      tags: ["money", "reaction"],
    });
  });

  it("rechaza lo que no tiene la forma", () => {
    expect(
      parseClipTags({ emotion: "x", situation: "y", people: "2", tags: [] }),
    ).toBeNull();
    expect(
      parseClipTags({ emotion: "", situation: "y", people: 0, tags: [] }),
    ).toBeNull();
    expect(parseClipTags([])).toBeNull();
  });

  it("recorta y acota: una salida hostil no crece sin límite", () => {
    const t = parseClipTags({
      emotion: "a".repeat(500),
      situation: "b",
      people: 9999,
      tags: Array.from({ length: 50 }, (_, i) => `t${i}`),
    });
    expect(t?.emotion.length).toBe(60);
    expect(t?.people).toBe(50);
    expect(t?.tags.length).toBe(10);
  });
});

describe("extractJsonObject", () => {
  it("saca el objeto de un bloque ```json", () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJsonObject('Sure! {"a":2} hope it helps')).toEqual({ a: 2 });
    expect(extractJsonObject("nada")).toBeNull();
  });
});
