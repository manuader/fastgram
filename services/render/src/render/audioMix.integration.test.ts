/**
 * Sprint 7 — la música de la marca llega al video. Contra el ffmpeg real, con
 * un MP3 generado acá mismo (`libmp3lame`), y con la política de producción:
 * sin prefijos por configuración, sólo el grant firmado que arma el worker
 * (`media/{companyId}/` + la biblioteca `audio/{companyId}/`).
 *
 * Lo que se mide, y cómo:
 *
 *  · **La música está en la salida**: el clip suena a 440 Hz y la música a
 *    3 kHz. Un pasa-altos en 2 kHz deja sólo la música; `volumedetect` sobre
 *    eso da un nivel audible con música y silencio sin ella.
 *  · **El clip sigue estando** (mezcla, no reemplazo): pasa-bajos en 700 Hz.
 *  · **La música se repite hasta el final del video**: una pista de 1,5 s en
 *    un video de 4 s. Antes (sin `-stream_loop`) el video salía de 1,5 s.
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FileCacheStore } from "../cache/store.js";
import { FFMPEG_BIN, probeCapabilities } from "../ffmpeg/capabilities.js";
import { probeMedia } from "../ffmpeg/probe.js";
import { signGrantBody, type MediaPolicyConfig } from "../media/urlPolicy.js";
import { renderBuild, type RenderEngineConfig } from "./engine.js";

const execFileAsync = promisify(execFile);
const caps = await probeCapabilities();
const canRun =
  caps.available && caps.encoders.has("libmp3lame") && caps.filters.has("amix");
const suite = canRun ? describe : describe.skip;

const SECRET = "secreto-de-test-de-al-menos-32-caracteres";
const BUCKET = "http://localhost:9000/fastgram";
const MEDIA = `${BUCKET}/media/ws-1/`;
const LIBRARY = `${BUCKET}/audio/ws-1/`;
const CANVAS = { width: 360, height: 640 };
const VIDEO_SECONDS = 4;

let workDir = "";
const files = new Map<string, string>();

async function ffmpeg(args: string[]): Promise<{ stderr: string }> {
  const { stderr } = await execFileAsync(
    FFMPEG_BIN,
    ["-nostdin", "-hide_banner", ...args],
    { maxBuffer: 16_000_000 },
  );
  return { stderr };
}

/** `mean_volume` en dB de la pista de audio después de `filter`. */
async function meanVolume(file: string, filter: string, from = 0): Promise<number> {
  const { stderr } = await ffmpeg([
    "-ss",
    String(from),
    "-i",
    file,
    "-vn",
    "-af",
    `${filter},volumedetect`,
    "-f",
    "null",
    "-",
  ]);
  const match = /mean_volume:\s*(-?[\d.]+|-inf) dB/.exec(stderr);
  if (match === null) throw new Error(`volumedetect no respondió:\n${stderr}`);
  return match[1] === "-inf" ? -Infinity : Number(match[1]);
}

beforeAll(async () => {
  if (!canRun) return;
  workDir = await mkdtemp(path.join(tmpdir(), "fastgram-audio-it-"));
  const quiet = ["-loglevel", "error", "-y"];

  // Clip de croma con voz (440 Hz) y uno mudo, los dos de 4 s.
  const clipWithAudio = path.join(workDir, "clip-audio.mp4");
  await ffmpeg([
    ...quiet,
    "-f",
    "lavfi",
    "-i",
    `color=c=0x00FF00:size=320x480:rate=30:duration=${VIDEO_SECONDS}`,
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=440:duration=${VIDEO_SECONDS}`,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    clipWithAudio,
  ]);
  const clipMute = path.join(workDir, "clip-mute.mp4");
  await ffmpeg([
    ...quiet,
    "-f",
    "lavfi",
    "-i",
    `color=c=0x00FF00:size=320x480:rate=30:duration=${VIDEO_SECONDS}`,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    clipMute,
  ]);
  // Fondo del wall-of-text: 4 s, sin audio.
  const wall = path.join(workDir, "wall.mp4");
  await ffmpeg([
    ...quiet,
    "-f",
    "lavfi",
    "-i",
    `testsrc=size=320x480:rate=30:duration=${VIDEO_SECONDS}`,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    wall,
  ]);
  // La música: un MP3 real de 1,5 s a 3 kHz.
  const music = path.join(workDir, "music.mp3");
  await ffmpeg([
    ...quiet,
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=3000:duration=1.5",
    "-c:a",
    "libmp3lame",
    "-b:a",
    "128k",
    music,
  ]);
  const bg = path.join(workDir, "bg.png");
  await writeFile(
    bg,
    await sharp({
      create: {
        width: 400,
        height: 700,
        channels: 3,
        background: { r: 30, g: 30, b: 90 },
      },
    })
      .png()
      .toBuffer(),
  );

  files.set(`${MEDIA}clip-audio.mp4`, clipWithAudio);
  files.set(`${MEDIA}clip-mute.mp4`, clipMute);
  files.set(`${MEDIA}wall.mp4`, wall);
  files.set(`${MEDIA}bg.png`, bg);
  files.set(`${LIBRARY}music.mp3`, music);
}, 120_000);

afterAll(async () => {
  if (workDir !== "") await rm(workDir, { recursive: true, force: true });
});

/** La política de `pnpm start`: nada por configuración, todo por grant. */
const policy: MediaPolicyConfig = {
  mediaPrefixes: [],
  sharedPrefixes: [],
  grantSecret: SECRET,
  requireGrant: true,
  now: Date.now,
};

function engineConfig(cacheDir: string): RenderEngineConfig {
  return {
    cache: new FileCacheStore(cacheDir),
    policy,
    fonts: { fontDir: null, strict: false },
    resolveMedia: async (url) => {
      const local = files.get(url);
      if (local === undefined) throw new Error(`url no mapeada en el test: ${url}`);
      return local;
    },
    normalizeInputs: false,
    allowUntonemappedHdr: false,
  };
}

/** El grant que firma el worker (`workspaceMediaAuthorization`). */
function grantFor(urls: readonly string[]) {
  const body = {
    companyId: "ws-1",
    issuedAt: Date.now() - 1000,
    expiresAt: Date.now() + 600_000,
    mediaPrefixes: [MEDIA],
    sharedPrefixes: [LIBRARY],
    urls: [...urls],
  };
  return { body, signature: signGrantBody(body, SECRET) };
}

const texts = [
  {
    id: "t1",
    text: "con música",
    position: { x: 50, y: 20 },
    widthPercent: 80,
    align: "center",
    font: { family: "inter", weight: 700, size: 28 },
    color: "#FFFFFF",
    stroke: { width: 3, color: "#000000" },
    background: null,
  },
];

async function render(payload: Record<string, unknown>, urls: string[], name: string) {
  const result = await renderBuild(
    { payload, grant: grantFor(urls) },
    engineConfig(path.join(workDir, `cache-${name}`)),
  );
  const artifact = result.artifacts[0];
  if (artifact === undefined) throw new Error("sin artefacto");
  return artifact.path;
}

/**
 * Filtros de dos polos en cascada: un pasa-altos de un polo deja pasar el
 * 440 Hz a -42 dB y no separa nada. Medido con estos: el tono propio da
 * ~-23 dB (la música al 30 %, ~-33 dB) y el ajeno < -70 dB.
 */
const HIGH = "highpass=f=2000:poles=2,highpass=f=2000:poles=2";
const LOW = "lowpass=f=700:poles=2,lowpass=f=700:poles=2";
const AUDIBLE_DB = -50;

suite("música de la marca contra ffmpeg real (sprint 7)", () => {
  it("green-screen: la música se mezcla con el audio del clip, no lo reemplaza", async () => {
    const clip = `${MEDIA}clip-audio.mp4`;
    const music = `${LIBRARY}music.mp3`;
    const out = await render(
      {
        type: "green-screen",
        canvas: CANVAS,
        image: { url: `${MEDIA}bg.png` },
        video: { url: clip },
        audio: { url: music },
        texts,
      },
      [`${MEDIA}bg.png`, clip, music],
      "gs-mix",
    );
    const info = await probeMedia(out);
    expect(info.hasAudio).toBe(true);
    expect(info.durationSeconds ?? 0).toBeGreaterThan(VIDEO_SECONDS - 0.3);

    // La música (3 kHz) está, también después de que la pista de 1,5 s terminó.
    expect(await meanVolume(out, HIGH)).toBeGreaterThan(AUDIBLE_DB);
    expect(await meanVolume(out, HIGH, 2.5)).toBeGreaterThan(AUDIBLE_DB);
    // Y el clip (440 Hz) también: es una mezcla.
    expect(await meanVolume(out, LOW)).toBeGreaterThan(AUDIBLE_DB);
  }, 120_000);

  it("green-screen sin música: sólo el clip (control del test de arriba)", async () => {
    const clip = `${MEDIA}clip-audio.mp4`;
    const out = await render(
      {
        type: "green-screen",
        canvas: CANVAS,
        image: { url: `${MEDIA}bg.png` },
        video: { url: clip },
        texts,
      },
      [`${MEDIA}bg.png`, clip],
      "gs-nomusic",
    );
    expect(await meanVolume(out, HIGH)).toBeLessThan(AUDIBLE_DB);
    expect(await meanVolume(out, LOW)).toBeGreaterThan(AUDIBLE_DB);
  }, 120_000);

  it("green-screen con clip mudo: la música va sola", async () => {
    const clip = `${MEDIA}clip-mute.mp4`;
    const music = `${LIBRARY}music.mp3`;
    const out = await render(
      {
        type: "green-screen",
        canvas: CANVAS,
        image: { url: `${MEDIA}bg.png` },
        video: { url: clip },
        audio: { url: music },
        texts,
      },
      [`${MEDIA}bg.png`, clip, music],
      "gs-only",
    );
    const info = await probeMedia(out);
    expect(info.hasAudio).toBe(true);
    expect(info.durationSeconds ?? 0).toBeGreaterThan(VIDEO_SECONDS - 0.3);
    expect(await meanVolume(out, HIGH, 2.5)).toBeGreaterThan(AUDIBLE_DB);
  }, 120_000);

  it("wall-of-text: una pista más corta que el video ya no lo corta (loop)", async () => {
    const wall = `${MEDIA}wall.mp4`;
    const music = `${LIBRARY}music.mp3`;
    const out = await render(
      {
        type: "wall-of-text",
        canvas: CANVAS,
        video: { url: wall },
        audio: { url: music },
        texts,
      },
      [wall, music],
      "wot",
    );
    const info = await probeMedia(out);
    expect(info.hasAudio).toBe(true);
    // Sin el loop, esto daba 1,5 s.
    expect(info.durationSeconds ?? 0).toBeGreaterThan(VIDEO_SECONDS - 0.3);
    expect(await meanVolume(out, HIGH, 2.5)).toBeGreaterThan(AUDIBLE_DB);
  }, 120_000);

  it("una pista fuera de la biblioteca de la marca se rechaza antes de tocar ffmpeg", async () => {
    const wall = `${MEDIA}wall.mp4`;
    const foreign = `${BUCKET}/audio/ws-2/music.mp3`;
    await expect(
      render(
        {
          type: "wall-of-text",
          canvas: CANVAS,
          video: { url: wall },
          audio: { url: foreign },
          texts,
        },
        [wall, foreign],
        "foreign",
      ),
    ).rejects.toMatchObject({ code: "media_url_not_allowed" });
  }, 120_000);
});
