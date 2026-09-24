#!/usr/bin/env node
/**
 * `pnpm start` — la app entera con un comando, y abajo con un Ctrl+C.
 * `PU-RUN-001` y `PU-RUN-003`.
 *
 * Hace, en este orden (el orden importa, ver `docs/ESTADO-DEL-PROYECTO.md` §6):
 *
 *  1. Entorno: lo exportado gana; después `.env.local` del root; después los
 *     defaults **no secretos** de `.env.example` (MinIO y Postgres locales).
 *  2. `docker compose up -d` y espera a Postgres y MinIO `healthy`.
 *  3. Build de los paquetes que consumen render, API, worker y web (turbo,
 *     cacheado). **Antes** de migrar: `db:migrate` corre con tsx pero importa
 *     paquetes del workspace, que se resuelven por su `dist` (trampa 31).
 *  4. `pnpm db:migrate`.
 *  5. Fuentes en `RENDER_FONT_DIR` / `FASTGRAM_FONT_DIR` / `~/fastgram-fonts`;
 *     si no hay ningún `.ttf`, las baja.
 *  6. `RENDER_MEDIA_GRANT_SECRET` efímero (si no vino del entorno), el mismo
 *     valor para render y worker. Nunca se imprime ni se escribe.
 *  7. render → API → worker → key de la web → web, cada uno esperando al
 *     anterior. La key va **sólo** por el entorno del proceso de la web.
 *
 * Si un servicio muere, baja todo y sale con 1 diciendo cuál. Ctrl+C baja todo
 * (un segundo Ctrl+C mata sin esperar).
 *
 * Los servicios corren con `tsx` **sin watch** (la web sí, con `next dev`):
 * con `tsx watch` un proceso que se cae se queda esperando cambios en vez de
 * salir, y este script no se enteraría. Para desarrollar con recarga, `--watch`.
 *
 * Flags: `--no-web`, `--no-worker`, `--watch`, `--tunnel`.
 *
 * `--tunnel` (o `FASTGRAM_TUNNEL=1`, `PU-RUN-005`): antes del render levanta
 * el proceso de media pública y `cloudflared` (ver `lib/tunnel.mjs`), y exporta
 * la URL del túnel como `FASTGRAM_PUBLIC_URL` a render, API, worker y web. Sin
 * túnel, `FASTGRAM_PUBLIC_URL` se borra del entorno de los hijos: una URL de un
 * túnel que no está corriendo firmaría links muertos.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { DEFAULT_DATABASE_URL, issueDevWorkspaceKey } from "./lib/dev-workspace.mjs";
import { readEnvFile } from "./lib/env-file.mjs";
import { DEFAULT_PUBLIC_MEDIA_PORT, startTunnel } from "./lib/tunnel.mjs";
import {
  killAllNow,
  log,
  prefix,
  runStep,
  spawnTracked,
  stopAll,
} from "./lib/supervisor.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ── Flags ────────────────────────────────────────────────────────────────
const KNOWN_FLAGS = new Set([
  "--no-web",
  "--no-worker",
  "--watch",
  "--tunnel",
  "--help",
  "-h",
]);
const flags = new Set(process.argv.slice(2));
const unknown = [...flags].filter((f) => !KNOWN_FLAGS.has(f));
for (const f of unknown) process.stderr.write(`flag desconocido: ${f}\n`);
if (unknown.length > 0 || flags.has("--help") || flags.has("-h")) {
  process.stdout.write(
    [
      "uso: node scripts/start.mjs [--no-web] [--no-worker] [--watch] [--tunnel]",
      "",
      "  --no-web     no levanta apps/web (ni emite su key)",
      "  --no-worker  no levanta apps/worker",
      "  --watch      render, API y worker con `tsx watch` (recarga al editar;",
      "               un proceso caído NO se detecta: tsx espera cambios)",
      "  --tunnel     URL pública https para la media (Cloudflare Tunnel): la",
      "               necesitan Instagram y TikTok para publicar. Igual que",
      "               FASTGRAM_TUNNEL=1. Sin cuenta: quick tunnel trycloudflare;",
      "               con TUNNEL_TOKEN + FASTGRAM_PUBLIC_URL: named tunnel",
      "",
    ].join("\n"),
  );
  process.exit(unknown.length > 0 ? 2 : 0);
}
const WITH_WEB = !flags.has("--no-web");
const WITH_WORKER = !flags.has("--no-worker");
const WATCH = flags.has("--watch");

// ── Entorno ──────────────────────────────────────────────────────────────
/**
 * Los únicos valores de `.env.example` que se toman como default: los que
 * apuntan a la infraestructura local de `docker-compose.yml`. Todo lo demás
 * (secretos, LLM, números que el PRD no da) queda sin default a propósito.
 */
const EXAMPLE_DEFAULT_KEYS = [
  "NODE_ENV",
  "LOG_LEVEL",
  "DATABASE_URL",
  "S3_ENDPOINT",
  "S3_REGION",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY", // credencial del MinIO local, no un secreto
  "S3_PUBLIC_URL",
  "API_PORT",
  "API_PUBLIC_URL",
  "WEB_PUBLIC_URL",
  "FASTGRAM_API_URL",
  "RENDER_PORT",
  "RENDER_FONT_STRICT",
  "RENDER_REQUIRE_GRANT",
];

/** @type {NodeJS.ProcessEnv} */
const env = { ...process.env };
const local = readEnvFile(join(ROOT, ".env.local"));
if (local !== null) {
  let n = 0;
  for (const [k, v] of Object.entries(local)) {
    if (env[k] === undefined) {
      env[k] = v;
      n++;
    }
  }
  log("start", `.env.local: ${n} variables (las exportadas ganan)`);
}
const example = readEnvFile(join(ROOT, ".env.example")) ?? {};
for (const k of EXAMPLE_DEFAULT_KEYS) {
  const v = example[k];
  if ((env[k] === undefined || env[k] === "") && v !== undefined && v !== "") env[k] = v;
}
env.DATABASE_URL ||= DEFAULT_DATABASE_URL;

/**
 * Análisis de marca desde la web, en uso personal.
 *
 * El worker no le pone default a ninguno de estos números a propósito (sesión
 * 2026-09-23: "ningún número que el PRD no da tiene default"). Pero sin ellos la
 * cola `brand-source-analysis` no se monta y una marca nueva nunca se analiza.
 * Para `pnpm start` en una Mac personal los elige el coordinador (2026-09-24):
 * son límites de higiene para bajar UNA web, no cuotas. Cualquiera se pisa desde
 * el entorno o `.env.local`.
 */
const PERSONAL_BRAND_DEFAULTS = {
  BRAND_WEBSITE_TIMEOUT_MS: "15000",
  BRAND_WEBSITE_MAX_BODY_BYTES: "3000000",
  BRAND_WEBSITE_MAX_REDIRECTS: "5",
  BRAND_WEBSITE_MAX_SECONDARY_PAGES: "4",
  BRAND_WEBSITE_MAX_TEXT_CHARS: "40000",
  BRAND_WEBSITE_USER_AGENT: "FastGram/0.1 (personal brand analysis)",
  BRAND_WEBSITE_ALLOWED_PORTS: "80,443",
  BRAND_SNAPSHOT_RAW_RETENTION_DAYS: "30",
};
for (const [k, v] of Object.entries(PERSONAL_BRAND_DEFAULTS)) {
  if (env[k] === undefined || env[k] === "") env[k] = v;
}

/**
 * X sin login (PU-SCRAPE-001, D-13): FxTwitter expone perfil y posts públicos
 * sin credenciales (`GET /2/profile/{handle}`, OpenAPI de FxEmbed). Es un
 * servicio público de terceros; se pisa con `X_EXTRACTOR_URL=` vacío… o con otro.
 */
if (env.X_EXTRACTOR_URL === undefined) env.X_EXTRACTOR_URL = "https://api.fxtwitter.com";

/** Vacío cuenta como ausente: `.env.example` trae muchas `KEY=` sin valor. */
/** @param {string} k */
const envValue = (k) => (env[k] === undefined || env[k] === "" ? undefined : env[k]);

/**
 * Túnel (`PU-RUN-005`). El token de un named tunnel se saca del entorno
 * compartido acá mismo: sólo lo ve el proceso de `cloudflared`.
 */
const WITH_TUNNEL = flags.has("--tunnel") || envValue("FASTGRAM_TUNNEL") === "1";
const TUNNEL_TOKEN = envValue("TUNNEL_TOKEN");
delete env.TUNNEL_TOKEN;
const PUBLIC_MEDIA_PORT = Number(
  envValue("PUBLIC_MEDIA_PORT") ?? DEFAULT_PUBLIC_MEDIA_PORT,
);

const RENDER_PORT = Number(envValue("RENDER_PORT") ?? 3002);
const VISION_PORT = Number(envValue("VISION_PORT") ?? 3004);
const API_PORT = Number(envValue("API_PORT") ?? 3001);
const WEB_PORT = 3000; // fijo en `apps/web/package.json` (`next dev -p 3000`)

// ── Apagado ──────────────────────────────────────────────────────────────
let shuttingDown = false;

/** @param {number} code */
async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  await stopAll();
  log("start", code === 0 ? "todo abajo." : `todo abajo (salida ${code}).`);
  process.exit(code);
}

for (const signal of /** @type {const} */ (["SIGINT", "SIGTERM"])) {
  process.on(signal, () => {
    if (shuttingDown) {
      log("start", "segundo aviso: SIGKILL a todo.");
      killAllNow();
      process.exit(130);
    }
    process.stdout.write("\n");
    log("start", `${signal}: bajando todo (otro Ctrl+C mata sin esperar)…`);
    void shutdown(0);
  });
}
process.on("exit", () => killAllNow());

class Aborted extends Error {}
function checkAbort() {
  if (shuttingDown) throw new Aborted();
}

// ── Espera ───────────────────────────────────────────────────────────────
/**
 * @param {import("./lib/supervisor.mjs").Tracked} t
 */
function deathMessage(t) {
  return `${t.name} murió antes de estar listo (código ${t.code ?? "?"}${
    t.signal ? `, señal ${t.signal}` : ""
  })`;
}

/**
 * Espera a que `url` conteste algo que `accept` apruebe, o a que `t` muera.
 *
 * @param {import("./lib/supervisor.mjs").Tracked} t
 * @param {string} url
 * @param {{ timeoutMs: number, accept: (res: Response) => boolean }} options
 */
async function waitForHttp(t, url, { timeoutMs, accept }) {
  const deadline = Date.now() + timeoutMs;
  let last = "sin respuesta";
  while (Date.now() < deadline) {
    checkAbort();
    if (t.exited) throw new Error(deathMessage(t));
    try {
      const res = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(
          Math.min(30_000, Math.max(1_000, deadline - Date.now())),
        ),
      });
      await res.arrayBuffer().catch(() => undefined);
      if (accept(res)) return;
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await sleep(500);
  }
  throw new Error(`${t.name} no estuvo listo en ${timeoutMs / 1000}s (${url}: ${last})`);
}

/**
 * @param {import("./lib/supervisor.mjs").Tracked} t
 * @param {(line: string) => boolean} match
 * @param {number} timeoutMs
 * @param {string} what
 */
async function waitForLine(t, match, timeoutMs, what) {
  let seen = false;
  /** @param {string} line */
  const listener = (line) => {
    if (match(line)) seen = true;
  };
  t.lineListeners.add(listener);
  try {
    const deadline = Date.now() + timeoutMs;
    while (!seen) {
      checkAbort();
      if (t.exited) throw new Error(deathMessage(t));
      if (Date.now() > deadline) {
        throw new Error(`${t.name} no logueó "${what}" en ${timeoutMs / 1000}s`);
      }
      await sleep(200);
    }
  } finally {
    t.lineListeners.delete(listener);
  }
}

/** @param {number} port */
function portTaken(port) {
  return new Promise((done) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      done(true);
    });
    socket.once("error", () => done(false));
    socket.setTimeout(1_000, () => {
      socket.destroy();
      done(false);
    });
  });
}

/**
 * Un servicio que vive hasta el apagado: si muere antes, baja todo.
 *
 * @param {import("./lib/supervisor.mjs").Tracked} t
 */
function watchDeath(t) {
  void t.done.then(() => {
    if (shuttingDown) return;
    log(
      "start",
      `${t.name} se cayó (código ${t.code ?? "?"}${t.signal ? `, señal ${t.signal}` : ""}): bajando todo.`,
    );
    void shutdown(1);
  });
}

/** @param {string} p */
function expandHome(p) {
  return p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p;
}

/** @param {string} dir */
function countFonts(dir) {
  try {
    return readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".ttf")).length;
  } catch {
    return 0;
  }
}

/**
 * @param {string} name
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} [childEnv]
 */
async function step(name, args, childEnv = env) {
  checkAbort();
  log("start", `▸ ${name}`);
  const code = await runStep("setup", args[0], args.slice(1), {
    cwd: ROOT,
    env: childEnv,
  });
  checkAbort();
  return code;
}

/** @param {string} container */
async function containerHealth(container) {
  let out = "";
  const child = spawn(
    "docker",
    [
      "inspect",
      "-f",
      "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}",
      container,
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (c) => (out += c));
  await new Promise((r) => child.once("close", r));
  return out.trim();
}

// ── Principal ────────────────────────────────────────────────────────────
async function main() {
  // Antes de nada: un puerto ocupado haría que el health check le pegue a OTRO
  // proceso y dé verde. Mejor fallar acá con el nombre del puerto.
  const ports = [
    ["render", RENDER_PORT],
    ["api", API_PORT],
    ...(WITH_WEB ? [["web", WEB_PORT]] : []),
    ...(WITH_TUNNEL ? [["public-media", PUBLIC_MEDIA_PORT]] : []),
  ];
  for (const [name, port] of /** @type {[string, number][]} */ (ports)) {
    if (await portTaken(port)) {
      throw new Error(
        `el puerto ${port} (${name}) ya está en uso. ¿Otro \`pnpm start\` o un \`pnpm dev\` suelto? ` +
          `Mirá: lsof -iTCP:${port} -sTCP:LISTEN -nP`,
      );
    }
  }

  // 2. Infra
  if ((await step("docker compose up -d", ["docker", "compose", "up", "-d"])) !== 0) {
    throw new Error("`docker compose up -d` falló. ¿Está corriendo Docker?");
  }
  const infraDeadline = Date.now() + 120_000;
  for (const container of ["fastgram-postgres", "fastgram-minio"]) {
    let status = "";
    while ((status = await containerHealth(container)) !== "healthy") {
      checkAbort();
      if (Date.now() > infraDeadline) {
        throw new Error(
          `${container} no quedó healthy en 120s (estado: ${status || "?"})`,
        );
      }
      await sleep(1_000);
    }
    log("start", `${container}: healthy`);
  }

  // 3. Build (trampa 31: los paquetes se consumen por `dist`).
  const filters = [
    "--filter=@fastgram/render-service^...",
    "--filter=@fastgram/api^...",
    "--filter=@fastgram/worker^...",
    ...(WITH_WEB ? ["--filter=@fastgram/web^..."] : []),
  ];
  if (
    (await step("build de paquetes (turbo)", [
      "pnpm",
      "turbo",
      "run",
      "build",
      ...filters,
    ])) !== 0
  ) {
    throw new Error("el build de los paquetes falló (ver [setup] arriba)");
  }

  // 4. Migraciones
  if ((await step("migraciones", ["pnpm", "db:migrate"])) !== 0) {
    throw new Error("`pnpm db:migrate` falló (ver [setup] arriba)");
  }

  // 5. Fuentes
  const fontDir = resolve(
    expandHome(
      envValue("RENDER_FONT_DIR") ??
        envValue("FASTGRAM_FONT_DIR") ??
        join(homedir(), "fastgram-fonts"),
    ),
  );
  let fonts = countFonts(fontDir);
  // 37 = los .ttf de las 11 familias OFL (42 menos los 5 pesos de snapchat).
  // Con menos, falta alguna: p. ej. una instalación de antes del 2026-09-24,
  // cuando `tiktok` todavía no era TikTok Sans.
  if (fonts < 37) {
    mkdirSync(fontDir, { recursive: true });
    const code = await step(`bajando fuentes a ${fontDir}`, [
      "pnpm",
      "--filter",
      "@fastgram/render-service",
      "fonts:fetch",
      fontDir,
    ]);
    fonts = countFonts(fontDir);
    if (fonts === 0) {
      throw new Error(
        `no se bajó ninguna fuente a ${fontDir} (fonts:fetch salió con ${code})`,
      );
    }
    if (code !== 0) {
      log(
        "start",
        `fonts:fetch salió con ${code}: esperado por snapchat (P2-RENDER-008, sin fuente libre). Hay ${fonts} .ttf.`,
      );
    }
  }
  log("start", `fuentes: ${fonts} .ttf en ${fontDir}`);

  // 6. Secreto compartido render ↔ worker. Nunca se imprime.
  const grantSecret =
    envValue("RENDER_MEDIA_GRANT_SECRET") ?? randomBytes(32).toString("base64");
  log(
    "start",
    envValue("RENDER_MEDIA_GRANT_SECRET")
      ? "RENDER_MEDIA_GRANT_SECRET: del entorno"
      : "RENDER_MEDIA_GRANT_SECRET: efímero, generado para esta corrida",
  );
  const mode = envValue("FASTGRAM_MODE") ?? "personal";
  const tsxArgs = WATCH
    ? ["exec", "tsx", "watch", "src/main.ts"]
    : ["exec", "tsx", "src/main.ts"];

  // 6b. Túnel (opcional). Antes que todo lo demás: la URL va en el entorno
  // de cada hijo, y un proceso no se entera de una variable que cambia después.
  /** @type {string | null} */
  let publicUrl = null;
  if (WITH_TUNNEL) {
    const tunnel = await startTunnel({
      root: ROOT,
      env,
      port: PUBLIC_MEDIA_PORT,
      tunnelToken: TUNNEL_TOKEN,
      tsxArgs,
      watchDeath,
      waitForLine,
      checkAbort,
    });
    publicUrl = tunnel.publicUrl;
    env.FASTGRAM_PUBLIC_URL = publicUrl;
  } else {
    if (envValue("FASTGRAM_PUBLIC_URL")) {
      log(
        "start",
        "FASTGRAM_PUBLIC_URL se ignora sin --tunnel: publicar por URL queda apagado en esta corrida",
      );
    }
    delete env.FASTGRAM_PUBLIC_URL;
  }

  // 7a. Render
  checkAbort();
  const render = spawnTracked("render", "pnpm", tsxArgs, {
    cwd: join(ROOT, "services/render"),
    env: {
      ...env,
      RENDER_PORT: String(RENDER_PORT),
      RENDER_FONT_DIR: fontDir,
      RENDER_MEDIA_GRANT_SECRET: grantSecret,
      NODE_OPTIONS: [env.NODE_OPTIONS, "--experimental-ffi"].filter(Boolean).join(" "),
    },
  });
  watchDeath(render);
  await waitForHttp(render, `http://127.0.0.1:${RENDER_PORT}/health`, {
    timeoutMs: 60_000,
    accept: (res) => res.ok,
  });
  log("start", `render listo en :${RENDER_PORT}`);

  // 7b. Visión (opcional) — el extractor anónimo de Instagram (PU-SCRAPE-001)
  // y el OCR de capturas del tier D (`POST /brand/ocr`, sprint 7). Va ANTES de
  // la API para que ésta herede `VISION_SERVICE_URL`.
  // vive en `services/vision` (instaloader). Se levanta sólo si su venv existe
  // (`cd services/vision && uv pip install -e ".[dev,social]"`); si no, las
  // fuentes de Instagram caen a tier D (pegar la bio) y se avisa.
  const visionUvicorn = join(ROOT, "services/vision/.venv/bin/uvicorn");
  if (existsSync(visionUvicorn) && envValue("INSTAGRAM_EXTRACTOR_URL") === undefined) {
    checkAbort();
    const vision = spawnTracked(
      "vision",
      visionUvicorn,
      ["app.main:app", "--host", "127.0.0.1", "--port", String(VISION_PORT)],
      { cwd: join(ROOT, "services/vision"), env: { ...env } },
    );
    watchDeath(vision);
    await waitForHttp(vision, `http://127.0.0.1:${VISION_PORT}/health`, {
      timeoutMs: 60_000,
      accept: (res) => res.ok,
    });
    env.INSTAGRAM_EXTRACTOR_URL = `http://127.0.0.1:${VISION_PORT}`;
    env.VISION_SERVICE_URL ||= `http://127.0.0.1:${VISION_PORT}`;
    log("start", `visión lista en :${VISION_PORT} (extractor anónimo de Instagram)`);
  } else if (envValue("INSTAGRAM_EXTRACTOR_URL") === undefined) {
    log(
      "start",
      "sin services/vision/.venv: Instagram cae a pegar la bio a mano (ver docs/GUIA-DE-USO.md)",
    );
  }

  // 7b'. API — `/health` es readiness: 200 con `ok` o `degraded`, 503 sin Postgres.
  checkAbort();
  const api = spawnTracked("api", "pnpm", tsxArgs, {
    cwd: join(ROOT, "apps/api"),
    env: { ...env, API_PORT: String(API_PORT), FASTGRAM_MODE: mode },
  });
  watchDeath(api);
  await waitForHttp(api, `http://127.0.0.1:${API_PORT}/health`, {
    timeoutMs: 90_000,
    accept: (res) => res.status === 200,
  });
  log("start", `api lista en :${API_PORT}`);

  // 7c. Worker — no abre puerto por defecto; "worker arriba" es su última línea
  // de arranque, después de pedirle `/capabilities` al render.
  if (WITH_WORKER) {
    checkAbort();
    const worker = spawnTracked("worker", "pnpm", tsxArgs, {
      cwd: join(ROOT, "apps/worker"),
      env: {
        ...env,
        RENDER_SERVICE_URL: `http://localhost:${RENDER_PORT}`,
        RENDER_MEDIA_GRANT_SECRET: grantSecret,
        FASTGRAM_MODE: mode,
      },
    });
    watchDeath(worker);
    await waitForLine(
      worker,
      (l) => l.includes("worker arriba"),
      90_000,
      "worker arriba",
    );
    log("start", "worker listo");
  }

  // 7d. Web, con su key por el entorno del hijo (PU-RUN-003). Nunca a disco.
  if (WITH_WEB) {
    checkAbort();
    if (envValue("FASTGRAM_API_KEY")) {
      log(
        "start",
        "FASTGRAM_API_KEY del entorno se ignora: se emite una nueva para esta corrida",
      );
    }
    const { token } = await issueDevWorkspaceKey({ databaseUrl: env.DATABASE_URL });
    log("start", "key de la web emitida (sólo vive en el entorno del proceso de la web)");
    checkAbort();
    const web = spawnTracked("web", "pnpm", ["run", "dev"], {
      cwd: join(ROOT, "apps/web"),
      env: {
        ...env,
        FASTGRAM_API_URL:
          envValue("FASTGRAM_API_URL") ?? `http://localhost:${API_PORT}/api/v1`,
        FASTGRAM_API_KEY: token,
        FASTGRAM_MODE: mode,
      },
    });
    watchDeath(web);
    // Cualquier respuesta < 500: `/` puede redirigir. Un 500 es un error de
    // compilación, y eso no es "listo".
    await waitForHttp(web, `http://127.0.0.1:${WEB_PORT}/`, {
      timeoutMs: 180_000,
      accept: (res) => res.status < 500,
    });
  }

  // 9. LLM local disponible
  if (!envValue("LLM_BASE_URL")) {
    try {
      const res = await fetch("http://localhost:11434/api/version", {
        signal: AbortSignal.timeout(1_000),
      });
      if (res.ok) {
        const { version } = /** @type {{ version?: string }} */ (await res.json());
        log(
          "start",
          `hay un Ollama escuchando en localhost:11434 (v${version ?? "?"}). ` +
            "Configuralo desde /settings/models; sin LLM la cola de Blitz queda vacía.",
        );
      }
    } catch {
      // Sin Ollama: nada que avisar.
    }
  }

  checkAbort();
  const url = WITH_WEB ? `http://localhost:${WEB_PORT}` : `http://localhost:${API_PORT}`;
  const line = "─".repeat(44);
  process.stdout.write(
    `\n${prefix("start")} ${line}\n${prefix("start")}   FastGram listo → ${url}\n` +
      (publicUrl === null
        ? ""
        : `${prefix("start")}   media pública → ${publicUrl}/public-media/…\n`) +
      `${prefix("start")}   modo ${mode} · Ctrl+C para bajar todo\n${prefix("start")} ${line}\n\n`,
  );
}

main().catch((err) => {
  if (err instanceof Aborted) return; // el apagado ya está en curso
  log("start", `ERROR: ${err instanceof Error ? err.message : String(err)}`);
  void shutdown(1);
});
