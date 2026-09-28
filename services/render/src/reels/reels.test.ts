import { describe, expect, it } from "vitest";
import path from "node:path";
import { tmpdir } from "node:os";
import { NullCacheStore } from "../cache/store.js";
import { parsePrefixList, type MediaPolicyConfig } from "../media/urlPolicy.js";
import { buildServer } from "../http/server.js";
import { sampleReel } from "./__fixtures__/spec.js";
import { parseParakeetJson, parseWhisperJson, tokensToWords } from "./asr.js";
import { keyerArgs } from "./chroma.js";
import { outputProblems, reelCacheKey } from "./engine.js";
import { SerialQueue } from "./routes.js";
import { reelSpecSchema } from "./spec.js";
import { toReelTime } from "./assets.js";

describe("spec (espejo del contrato)", () => {
  it("acepta el reel de referencia y rechaza lo mismo que el contrato", () => {
    expect(reelSpecSchema.safeParse(sampleReel()).success).toBe(true);
    const bad = { ...sampleReel(), durationSec: 61 };
    expect(reelSpecSchema.safeParse(bad).success).toBe(false);
    const dup = sampleReel();
    dup.layers.push(dup.layers[3]!);
    expect(reelSpecSchema.safeParse(dup).success).toBe(false);
  });
});

describe("asr", () => {
  it("une sub-palabras de parakeet y pega la puntuación suelta", () => {
    const tokens = parseParakeetJson({
      sentences: [
        {
          tokens: [
            { text: " St", start: 0, end: 0.24 },
            { text: "op", start: 0.24, end: 0.48 },
            { text: " sc", start: 0.48, end: 0.64 },
            { text: "rolling", start: 0.64, end: 1.12 },
            { text: ".", start: 1.12, end: 1.44 },
          ],
        },
      ],
    });
    expect(tokensToWords(tokens)).toEqual([
      { text: "Stop", start: 0, end: 0.48 },
      { text: "scrolling.", start: 0.48, end: 1.44 },
    ]);
  });

  it("lee el JSON completo de whisper-cli y saca los tokens especiales", () => {
    const tokens = parseWhisperJson({
      transcription: [
        {
          tokens: [
            { text: "[_BEG_]", offsets: { from: 0, to: 0 } },
            { text: " Hola", offsets: { from: 0, to: 400 } },
            { text: " mun", offsets: { from: 400, to: 600 } },
            { text: "do", offsets: { from: 600, to: 800 } },
            { text: "[_TT_40]", offsets: { from: 800, to: 800 } },
          ],
        },
      ],
    });
    expect(tokensToWords(tokens)).toEqual([
      { text: "Hola", start: 0, end: 0.4 },
      { text: "mundo", start: 0.4, end: 0.8 },
    ]);
  });

  it("pasa tiempos del archivo a tiempos del reel dentro de la capa", () => {
    const clip = sampleReel().layers.find((l) => l.id === "clip")!;
    const words = toReelTime(
      [
        { text: "a", start: 0.2, end: 0.5 },
        { text: "b", start: 12, end: 12.5 },
      ],
      clip,
      15,
    );
    expect(words).toEqual([{ text: "a", start: 1.2, end: 1.5 }]);
  });
});

describe("croma", () => {
  const caps = {
    hasChromakey: true,
    hasColorkey: true,
    filters: new Set(["chromakey", "despill"]),
  };
  it("usa los parámetros del keyer del render FFmpeg + despill, a VP9 con alfa", () => {
    const args = keyerArgs(
      "in.mp4",
      "out.webm",
      "green",
      { width: 1920, hasAlpha: false, alphaDecoder: null },
      caps,
    );
    expect(args[args.indexOf("-vf") + 1]).toBe(
      "chromakey=0x00FF00:0.18:0.1,despill=type=green,scale=1080:-2,format=yuva420p",
    );
    expect(args).toEqual(
      expect.arrayContaining(["libvpx-vp9", "yuva420p", "alpha_mode=1"]),
    );
  });

  it("un clip ya con alfa se decodifica con libvpx antes del -i (trampa 55) y no se recorta", () => {
    const args = keyerArgs(
      "in.webm",
      "out.webm",
      "alpha",
      { width: 720, hasAlpha: true, alphaDecoder: "libvpx-vp9" },
      caps,
    );
    expect(args.slice(4, 8)).toEqual(["-c:v", "libvpx-vp9", "-i", "in.webm"]);
    expect(args[args.indexOf("-vf") + 1]).toBe("format=yuva420p");
  });
});

describe("salida", () => {
  const spec = reelSpecSchema.parse(sampleReel());
  it("exige 1080×1920, 30 fps, la duración y audio si lo hay", () => {
    const ok = {
      width: 1080,
      height: 1920,
      fps: "30/1",
      durationSec: 15.01,
      hasAudio: true,
    };
    expect(outputProblems(ok, spec, true)).toEqual([]);
    expect(
      outputProblems(
        { ...ok, fps: "25/1", hasAudio: false, durationSec: 14 },
        spec,
        true,
      ),
    ).toEqual(["fps 25/1", "duration 14", "no audio stream"]);
  });

  it("la clave de cache es estable y cambia con la calidad", () => {
    expect(reelCacheKey(spec, "draft", "e1")).toBe(
      reelCacheKey(reelSpecSchema.parse(sampleReel()), "draft", "e1"),
    );
    expect(reelCacheKey(spec, "draft", "e1")).not.toBe(
      reelCacheKey(spec, "delivery", "e1"),
    );
  });
});

describe("cola", () => {
  it("corre de a uno, en orden", async () => {
    const queue = new SerialQueue(5);
    const log: string[] = [];
    const task = (name: string, ms: number) => () =>
      new Promise<string>((resolve) => {
        log.push(`start ${name}`);
        setTimeout(() => {
          log.push(`end ${name}`);
          resolve(name);
        }, ms);
      });
    const signal = new AbortController().signal;
    await Promise.all([
      queue.run(task("a", 20), signal),
      queue.run(task("b", 1), signal),
    ]);
    expect(log).toEqual(["start a", "end a", "start b", "end b"]);
  });

  it("rechaza con la cola llena y no corre lo que venció esperando", async () => {
    const queue = new SerialQueue(1);
    const signal = new AbortController().signal;
    let release!: () => void;
    const first = queue.run(() => new Promise<void>((r) => (release = r)), signal);
    const aborted = new AbortController();
    const second = queue.run(async () => "ran", aborted.signal);
    await expect(queue.run(async () => "x", signal)).rejects.toMatchObject({
      code: "render_timeout",
    });
    aborted.abort();
    release();
    await first;
    await expect(second).rejects.toMatchObject({
      details: { reason: "queued_too_long" },
    });
  });
});

describe("rutas", () => {
  function policy(): MediaPolicyConfig {
    return {
      mediaPrefixes: parsePrefixList("https://media.example/"),
      sharedPrefixes: parsePrefixList("https://library.example/"),
      grantSecret: null,
      requireGrant: false,
      now: Date.now,
    };
  }
  const app = () =>
    buildServer({
      logger: false,
      engine: {
        cache: new NullCacheStore(path.join(tmpdir(), "fastgram-reel-test")),
        policy: policy(),
        fonts: { fontDir: null, strict: false },
        resolveMedia: async () => {
          throw new Error("no debería bajar nada");
        },
        normalizeInputs: false,
        allowUntonemappedHdr: false,
      },
      reel: {
        asr: { engine: "none", bin: "x", model: null, timeoutMs: 1 },
        timeoutMs: 1000,
        queueMax: 1,
        workers: 1,
        previewInlineMaxBytes: 1,
      },
    });

  it("un spec inválido es 400 bad_request", async () => {
    const res = await app().inject({
      method: "POST",
      url: "/reels/render",
      payload: { spec: { version: 2 } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("bad_request");
  });

  it("una URL ajena se rechaza antes de bajar nada (FR-070)", async () => {
    const spec = sampleReel();
    spec.layers = spec.layers.map((l) =>
      l.kind === "clip" ? { ...l, url: "https://evil.example/x.mp4" } : l,
    );
    for (const url of ["/reels/render", "/reels/preview-html"]) {
      const res = await app().inject({ method: "POST", url, payload: { spec } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("media_url_not_allowed");
    }
  });

  it("la música fuera de la biblioteca también", async () => {
    const spec = sampleReel();
    spec.layers = spec.layers.map((l) =>
      l.kind === "audio" ? { ...l, url: "https://media.example/m.mp3" } : l,
    );
    const res = await app().inject({
      method: "POST",
      url: "/reels/render",
      payload: { spec },
    });
    expect(res.json().error.details.reason).toBe("audio_fuera_de_libreria");
  });
});
