/**
 * Laya en `pnpm start` — sprint 9 (O), D-18.
 *
 * Laya (Apache-2.0, `laya-serve`) es el motor de juicio local: el decisor de
 * assets y los `JV-*` corren sin costo si la tarea de juicio apunta a él en
 * Settings → Models. Es **opcional**: sin Laya, el juicio usa el LLM.
 *
 * Reglas, en este orden:
 *
 *  1. Si `/health` ya responde en el puerto configurado, se **reusa** y no se
 *     toca: ni se lanza otro ni se baja al salir (puede ser el que levantó el
 *     dueño a mano, o el de otro `pnpm start`).
 *  2. Si no está instalado (`$FASTGRAM_HOME/laya/.venv/bin/laya-serve`, lo deja
 *     `scripts/setup-laya.sh`), se sigue sin él y se dice en una línea.
 *  3. Si el puerto está ocupado por otra cosa, tampoco: se dice y se sigue.
 *  4. Si no, se lanza en `127.0.0.1` (nunca `0.0.0.0`: sin `LAYA_API_KEY`
 *     cualquiera en la red le podría preguntar) con MPS en Apple Silicon y CPU
 *     en el resto, y se espera `/health` **sin bloquear** al resto: precargar
 *     dos checkpoints tarda. Si muere, se avisa y la app sigue (no es como el
 *     render o la API: sin Laya hay fallback).
 *
 * El proceso lanzado queda en el supervisor (`spawnTracked`), así que Ctrl+C lo
 * baja con el resto, en orden inverso de arranque.
 */
import { existsSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/** El puerto del preset `laya` de Settings → Models (`core/models/presets.ts`). */
export const DEFAULT_LAYA_PORT = 3006;

/** Los checkpoints que se precargan. El router elige entre estos dos por idioma. */
export const DEFAULT_LAYA_MODELS = "english,multilingual";

/**
 * Cuánto se espera a `/health`. La primera vez baja los pesos de Hugging Face
 * (cientos de MB); después, precargar dos checkpoints en MPS lleva segundos.
 */
export const LAYA_READY_TIMEOUT_MS = 300_000;

/** @param {NodeJS.ProcessEnv} env */
export function fastgramHome(env) {
  const configured = env.FASTGRAM_HOME?.trim();
  return configured ? configured : join(homedir(), ".fastgram");
}

/** @param {NodeJS.ProcessEnv} env */
export function layaBinary(env) {
  return join(fastgramHome(env), "laya", ".venv", "bin", "laya-serve");
}

/**
 * MPS en Apple Silicon, CPU en el resto. `LAYA_DEVICE` del entorno gana (y
 * Laya igual cae a CPU solo si pide una GPU que no tiene).
 *
 * @param {NodeJS.ProcessEnv} env
 */
export function layaDevice(env) {
  const configured = env.LAYA_DEVICE?.trim();
  if (configured) return configured;
  return process.platform === "darwin" && process.arch === "arm64" ? "mps" : "cpu";
}

/**
 * ¿Hay un **Laya** sano en `url`? No alcanza con `{"status":"ok"}`: el render
 * y otros servicios del repo contestan lo mismo en `/health` (pasó probando en
 * un puerto de agente, sprint 9). La forma de `laya.serve` trae además
 * `loaded` (checkpoints residentes) y `device`.
 *
 * @param {string} url
 * @param {number} timeoutMs
 */
export async function layaHealthy(url, timeoutMs = 1_500) {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return false;
    const body = /** @type {{ status?: unknown, loaded?: unknown, device?: unknown }} */ (
      await res.json()
    );
    return (
      body.status === "ok" &&
      Array.isArray(body.loaded) &&
      typeof body.device === "string"
    );
  } catch {
    return false;
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
 * @typedef {object} LayaStart
 * @property {"reused" | "started" | "missing" | "port_taken"} status
 * @property {string} url
 * @property {Promise<boolean>} ready  `true` cuando `/health` responde; `false`
 *   si no llegó a tiempo o el proceso murió. Resuelta ya en los demás casos.
 * @property {import("./supervisor.mjs").Tracked | null} tracked
 */

/**
 * @param {{
 *   env: NodeJS.ProcessEnv,
 *   spawnTracked: typeof import("./supervisor.mjs").spawnTracked,
 *   log: (name: string, message: string) => void,
 *   isShuttingDown?: () => boolean,
 *   readyTimeoutMs?: number,
 * }} deps
 * @returns {Promise<LayaStart>}
 */
export async function startLaya(deps) {
  const { env, log } = deps;
  const port = Number(env.LAYA_PORT?.trim() || DEFAULT_LAYA_PORT);
  const url = `http://127.0.0.1:${port}`;

  if (await layaHealthy(url)) {
    log("laya", `ya corre en ${url}: lo reuso (no lo bajo al salir)`);
    return { status: "reused", url, ready: Promise.resolve(true), tracked: null };
  }
  const bin = layaBinary(env);
  if (!existsSync(bin)) {
    log(
      "laya",
      "no está instalado (scripts/setup-laya.sh): el juicio usa el LLM configurado",
    );
    return { status: "missing", url, ready: Promise.resolve(false), tracked: null };
  }
  if (await portTaken(port)) {
    log(
      "laya",
      `el puerto ${port} está ocupado por otra cosa que no es Laya: sigo sin él ` +
        `(LAYA_PORT para usar otro; mirá lsof -iTCP:${port} -sTCP:LISTEN -nP)`,
    );
    return { status: "port_taken", url, ready: Promise.resolve(false), tracked: null };
  }

  const device = layaDevice(env);
  const tracked = deps.spawnTracked("laya", bin, [], {
    cwd: fastgramHome(env),
    env: {
      ...env,
      LAYA_HOST: "127.0.0.1",
      LAYA_PORT: String(port),
      LAYA_DEVICE: device,
      LAYA_PRELOAD: env.LAYA_PRELOAD?.trim() || "1",
      LAYA_MODELS: env.LAYA_MODELS?.trim() || DEFAULT_LAYA_MODELS,
    },
  });
  log("laya", `arrancando en ${url} (${device}); el resto no lo espera`);

  const timeoutMs = deps.readyTimeoutMs ?? LAYA_READY_TIMEOUT_MS;
  const ready = (async () => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (deps.isShuttingDown?.() === true) return false;
      if (tracked.exited) {
        log(
          "laya",
          `se cayó antes de estar listo (código ${tracked.code ?? "?"}): el juicio usa el LLM`,
        );
        return false;
      }
      if (await layaHealthy(url)) {
        log("laya", `listo en ${url}`);
        // Si muere después, se avisa; la app sigue (hay fallback).
        void tracked.done.then(() => {
          if (deps.isShuttingDown?.() !== true) {
            log(
              "laya",
              `se cayó (código ${tracked.code ?? "?"}${tracked.signal ? `, señal ${tracked.signal}` : ""}): el juicio pasa al LLM`,
            );
          }
        });
        return true;
      }
      await sleep(1_000);
    }
    log("laya", `no respondió /health en ${timeoutMs / 1000}s: el juicio usa el LLM`);
    return false;
  })();
  return { status: "started", url, ready, tracked };
}
