/**
 * Servicio de render — ADR-007 (FFmpeg + sharp, no Remotion).
 *
 * Sin estado, escala por CPU. El texto NUNCA se compone con `drawtext`: ver
 * `ffmpeg/capabilities.ts` para la verificación y el porqué.
 */
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  cacheDirFromEnv,
  fontOptionsFromEnv,
  loadRenderEnv,
  maxBytesFor,
  mediaPolicyFromEnv,
} from "./config.js";
import { codeVersion } from "./domain/codeVersion.js";
import { FileCacheStore } from "./cache/store.js";
import { createHttpMediaResolver } from "./media/httpResolver.js";
import { buildServer } from "./http/server.js";

const env = loadRenderEnv();

// `P2-RENDER-016`: la versión del motor se deriva del árbol de código y entra en
// todas las claves de cache. Se fuerza acá, al arrancar, para que una instalación
// desde la que no se pueda leer el propio código sea un proceso que no levanta y
// no un 500 en el primer render. No hay fallback: un valor inventado devolvería
// artefactos viejos en silencio, que es justo lo que esto arregla.
codeVersion();

const cacheDir = cacheDirFromEnv(env);
const downloadDir = path.join(tmpdir(), "fastgram-render-downloads");
await mkdir(cacheDir, { recursive: true });
await mkdir(downloadDir, { recursive: true });

const app = buildServer({
  logger: true,
  engine: {
    cache: new FileCacheStore(cacheDir),
    policy: mediaPolicyFromEnv(env),
    fonts: fontOptionsFromEnv(env),
    resolveMedia: createHttpMediaResolver({
      downloadDir,
      maxBytes: (role) => maxBytesFor(env, role),
      timeoutMs: env.RENDER_DOWNLOAD_TIMEOUT_MS,
    }),
    normalizeInputs: env.RENDER_NORMALIZE_INPUTS,
    allowUntonemappedHdr: env.RENDER_ALLOW_UNTONEMAPPED_HDR,
  },
});

app.listen({ port: env.RENDER_PORT, host: "0.0.0.0" }).catch((err: unknown) => {
  app.log.error(err);
  process.exit(1);
});
