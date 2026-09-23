/**
 * Proceso hijo de `fontActivation.integration.test.ts`.
 *
 * Existe porque la activación sólo vale **en un proceso que todavía no dibujó
 * texto** (ver `fontActivation.ts`), y un worker de vitest no garantiza eso.
 * Cada corrida es un proceso nuevo, así que el experimento compara «con
 * activación» contra «sin» variando sólo eso — el control que le faltó al
 * experimento de Georgia (trampa 40 del HANDOFF).
 *
 * Uso: `node [--experimental-ffi] --import tsx <este archivo> <activate|control>
 *       <fontDir> <workDir>`. Imprime un JSON en la última línea.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { FileCacheStore } from "../../cache/store.js";
import { isRenderError } from "../../errors.js";
import { FFMPEG_BIN } from "../../ffmpeg/capabilities.js";
import { probeMedia } from "../../ffmpeg/probe.js";
import { parsePrefixList } from "../../media/urlPolicy.js";
import { renderBuild } from "../engine.js";
import { activateFontDir } from "../fontActivation.js";
import { fontAvailability, resolveFont } from "../fontLoader.js";
import { renderTextOverlay } from "../textLayer.js";

const [mode, fontDir, workDir] = process.argv.slice(2);
if ((mode !== "activate" && mode !== "control") || !fontDir || !workDir) {
  throw new Error("uso: <activate|control> <fontDir> <workDir>");
}

const MEDIA = "https://cdn.test.local/media/ws-1/";
const CANVAS = { width: 540, height: 960 };

const activation =
  mode === "activate" ? await activateFontDir(fontDir, { tmpRoot: workDir }) : null;

const anton = await resolveFont("anton", 400, 40, { fontDir, strict: false });
const status = await fontAvailability({ fontDir, strict: true });

const box = {
  id: "t1",
  text: "Anton se ve así",
  position: { x: 50, y: 50 },
  widthPercent: 80,
  align: "center" as const,
  font: { family: "anton" as const, weight: 400, size: 48 },
  color: "#FFFFFF",
  stroke: { width: 3, color: "#000000" },
  background: null,
};
const overlay = await renderTextOverlay([box], CANVAS, { fontDir, strict: false });

// Un wall-of-text de verdad, con ffmpeg y en ESTRICTO: sin activación tiene
// que fallar `font_unavailable`; con activación, salir.
const out = path.join(workDir, mode);
await mkdir(out, { recursive: true });
const video = path.join(out, "video.mp4");
await promisify(execFile)(FFMPEG_BIN, [
  "-nostdin",
  "-hide_banner",
  "-loglevel",
  "error",
  "-y",
  "-f",
  "lavfi",
  "-i",
  "testsrc=size=640x360:rate=30:duration=1",
  "-c:v",
  "libx264",
  "-pix_fmt",
  "yuv420p",
  video,
]);

let render:
  | { ok: true; width: number; height: number; warnings: readonly string[] }
  | {
      ok: false;
      code: string;
    };
try {
  const result = await renderBuild(
    {
      payload: {
        type: "wall-of-text",
        canvas: CANVAS,
        video: { url: `${MEDIA}video.mp4` },
        texts: [box],
      },
    },
    {
      cache: new FileCacheStore(path.join(out, "cache")),
      policy: {
        mediaPrefixes: parsePrefixList(MEDIA),
        sharedPrefixes: [],
        grantSecret: null,
        requireGrant: false,
        now: Date.now,
      },
      fonts: { fontDir, strict: true },
      resolveMedia: () => Promise.resolve(video),
      normalizeInputs: false,
      allowUntonemappedHdr: false,
    },
  );
  const artifact = result.artifacts[0];
  if (artifact === undefined) throw new Error("sin artefacto");
  const info = await probeMedia(artifact.path);
  render = {
    ok: true,
    width: info.width ?? 0,
    height: info.height ?? 0,
    warnings: result.warnings,
  };
} catch (error) {
  render = { ok: false, code: isRenderError(error) ? error.code : String(error) };
}

process.stdout.write(
  `${JSON.stringify({
    mode,
    activation:
      activation === null
        ? null
        : {
            backend: activation.backend,
            applied: activation.applied,
            registered: activation.registered,
            reason: activation.reason,
          },
    anton: { verified: anton.verified, description: anton.pangoDescription },
    verified: status
      .filter((s) => s.verified)
      .map((s) => `${s.family}-${String(s.weight)}`),
    files: status.filter((s) => s.file).length,
    overlaySha: createHash("sha256").update(overlay.png).digest("hex"),
    render,
  })}\n`,
);
