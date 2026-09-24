/**
 * `pnpm start --tunnel` — URL pública para la media (`PU-RUN-005`, PRD D-17).
 *
 * Instagram y las fotos de TikTok **traen la media por URL** y MinIO en
 * `localhost` no es público. Esto levanta dos procesos más:
 *
 *  1. `public-media` (`apps/api/src/public-media/main.ts`) en 127.0.0.1: sirve
 *     sólo `GET /public-media/<token firmado>`; todo lo demás es 404.
 *  2. `cloudflared`, apuntando **sólo** a ese proceso. Ni la API ni la web ni
 *     el bucket quedan expuestos.
 *
 * ## Dos modos
 *
 * **Quick tunnel (default, sin cuenta).** `cloudflared tunnel --url <origen>`
 * imprime una URL `https://<aleatorio>.trycloudflare.com` que cambia en cada
 * corrida. Límites que documenta Cloudflare («TryCloudflare»): tope de **200
 * requests en vuelo**, sin SSE, «intended for testing and development only»,
 * sin SLA, y **no funciona si hay un `config.yaml` en `~/.cloudflared`**.
 * Alcanza para Instagram. **No alcanza para TikTok**: `PULL_FROM_URL` exige un
 * dominio verificado por DNS, y `trycloudflare.com` no es tuyo.
 *
 * **Named tunnel (con cuenta de Cloudflare y dominio propio).** Se crea el
 * túnel en el dashboard, con una ruta pública `<host>` → `http://localhost:<PUBLIC_MEDIA_PORT>`
 * (Cloudflare no reescribe la ruta: no le pongas path). Después:
 * `TUNNEL_TOKEN=<token del dashboard>` y `FASTGRAM_PUBLIC_URL=https://<host>`
 * en `.env.local`. Acá corre `cloudflared tunnel --no-autoupdate run` con el
 * token **sólo** en el entorno de ese hijo. El hostname es fijo, así que se
 * puede verificar en TikTok.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { log, spawnTracked } from "./supervisor.mjs";

export const DEFAULT_PUBLIC_MEDIA_PORT = 3003;

/** La URL que imprime un quick tunnel. Exportado para el test. */
export const QUICK_TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

/**
 * La primera URL de quick tunnel en una línea, o `null`. `api.trycloudflare.com`
 * es el endpoint al que cloudflared le pide el túnel y aparece en los errores:
 * no es la URL del túnel.
 *
 * @param {string} line
 */
export function quickTunnelUrlFrom(line) {
  const m = QUICK_TUNNEL_URL.exec(line);
  if (m === null) return null;
  return m[0] === "https://api.trycloudflare.com" ? null : m[0];
}

/** @returns {Promise<string | null>} la versión, o null si no está instalado */
export function cloudflaredVersion() {
  return new Promise((done) => {
    let out = "";
    const child = spawn("cloudflared", ["--version"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c) => (out += c));
    child.once("error", () => done(null));
    child.once("close", (code) => done(code === 0 ? out.trim() : null));
  });
}

/**
 * Lee las líneas de cloudflared hasta tener la URL (en modo quick) **y** una
 * conexión registrada. Un solo listener para las dos cosas: con dos esperas
 * seguidas, la línea de «registered» podría llegar en el hueco entre una y
 * otra y perderse.
 *
 * @param {import("./supervisor.mjs").Tracked} t
 * @param {{ wantUrl: boolean, timeoutMs: number, checkAbort: () => void }} options
 * @returns {Promise<string | null>}
 */
async function waitForTunnel(t, { wantUrl, timeoutMs, checkAbort }) {
  /** @type {string | null} */
  let url = null;
  let registered = false;
  /** @param {string} line */
  const listener = (line) => {
    url ??= quickTunnelUrlFrom(line);
    if (line.includes("Registered tunnel connection")) registered = true;
  };
  t.lineListeners.add(listener);
  try {
    const deadline = Date.now() + timeoutMs;
    while (!(registered && (!wantUrl || url !== null))) {
      checkAbort();
      if (t.exited) {
        throw new Error(`${t.name} murió antes de estar listo (código ${t.code ?? "?"})`);
      }
      if (Date.now() > deadline) {
        throw new Error(
          `${t.name} no ${wantUrl && url === null ? "mostró la URL trycloudflare" : "registró ninguna conexión"} en ${timeoutMs / 1000}s`,
        );
      }
      await sleep(200);
    }
    return url;
  } finally {
    t.lineListeners.delete(listener);
  }
}

/** Lo mínimo que cloudflared necesita del entorno: ni S3, ni LLM, ni nada nuestro. */
const TUNNEL_ENV_KEYS = [
  "PATH",
  "HOME",
  "TMPDIR",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy",
];

/**
 * Levanta `public-media` y `cloudflared`. Devuelve la URL pública.
 *
 * @param {{
 *   root: string,
 *   env: NodeJS.ProcessEnv,
 *   port: number,
 *   tunnelToken: string | undefined,
 *   tsxArgs: string[],
 *   watchDeath: (t: import("./supervisor.mjs").Tracked) => void,
 *   waitForLine: (t: import("./supervisor.mjs").Tracked, match: (l: string) => boolean, ms: number, what: string) => Promise<void>,
 *   checkAbort: () => void,
 * }} options
 * @returns {Promise<{ publicUrl: string, mode: "quick" | "named" }>}
 */
export async function startTunnel({
  root,
  env,
  port,
  tunnelToken,
  tsxArgs,
  watchDeath,
  waitForLine,
  checkAbort,
}) {
  const version = await cloudflaredVersion();
  if (version === null) {
    throw new Error(
      "--tunnel necesita `cloudflared` y no está en el PATH. En macOS: `brew install cloudflared`. " +
        "Sin túnel, arrancá sin --tunnel (y sin FASTGRAM_TUNNEL=1): todo anda salvo publicar por URL.",
    );
  }
  log("start", `túnel: ${version}`);

  const token = tunnelToken?.trim() ?? "";
  const mode = token !== "" ? "named" : "quick";
  /** @type {string | null} */
  let namedUrl = null;
  if (mode === "named") {
    namedUrl = (env.FASTGRAM_PUBLIC_URL ?? "").trim().replace(/\/+$/, "");
    if (!/^https:\/\/[^/?#]+$/.test(namedUrl)) {
      throw new Error(
        "con TUNNEL_TOKEN (named tunnel) hace falta FASTGRAM_PUBLIC_URL=https://<hostname del túnel>, " +
          "sin ruta: es el hostname público que configuraste en Cloudflare.",
      );
    }
  } else if (
    existsSync(join(homedir(), ".cloudflared", "config.yaml")) ||
    existsSync(join(homedir(), ".cloudflared", "config.yml"))
  ) {
    // Documentado por Cloudflare: con config.yaml el quick tunnel no anda.
    throw new Error(
      "hay un ~/.cloudflared/config.yaml y los quick tunnels no funcionan con él " +
        "(TryCloudflare). Movelo, o usá un named tunnel con TUNNEL_TOKEN + FASTGRAM_PUBLIC_URL.",
    );
  }

  // 1. El proceso que el túnel expone.
  checkAbort();
  const media = spawnTracked(
    "media",
    "pnpm",
    [...tsxArgs.slice(0, -1), "src/public-media/main.ts"],
    {
      cwd: join(root, "apps/api"),
      env: { ...env, PUBLIC_MEDIA_PORT: String(port) },
    },
  );
  watchDeath(media);
  await waitForLine(
    media,
    (l) => l.includes("public-media arriba"),
    60_000,
    "public-media arriba",
  );
  log("start", `public-media listo en 127.0.0.1:${port}`);

  // 2. cloudflared. `--no-autoupdate`: que no se reemplace el binario de
  // Homebrew por su cuenta a mitad de una corrida.
  checkAbort();
  const origin = `http://127.0.0.1:${port}`;
  /** @type {NodeJS.ProcessEnv} */
  const tunnelEnv = {};
  for (const k of TUNNEL_ENV_KEYS) if (env[k] !== undefined) tunnelEnv[k] = env[k];
  const tunnel =
    mode === "named"
      ? spawnTracked("tunnel", "cloudflared", ["tunnel", "--no-autoupdate", "run"], {
          cwd: root,
          // El token viaja SÓLO acá y nunca se imprime.
          env: { ...tunnelEnv, TUNNEL_TOKEN: token },
        })
      : spawnTracked(
          "tunnel",
          "cloudflared",
          ["tunnel", "--no-autoupdate", "--url", origin],
          {
            cwd: root,
            env: tunnelEnv,
          },
        );
  watchDeath(tunnel);

  const printed = await waitForTunnel(tunnel, {
    wantUrl: mode === "quick",
    timeoutMs: 60_000,
    checkAbort,
  });
  const publicUrl = /** @type {string} */ (mode === "quick" ? printed : namedUrl);
  log("start", `túnel (${mode}) arriba → ${publicUrl} (sólo /public-media/*)`);
  return { publicUrl, mode };
}
