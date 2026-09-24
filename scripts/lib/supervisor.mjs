/**
 * Procesos hijos de `pnpm start`: prefijo de color, grupos de procesos y
 * apagado sin huérfanos.
 *
 * ## Por qué `detached: true` y `process.kill(-pid)`
 *
 * Cada servicio es una cadena `pnpm → tsx → node` (y la web, `pnpm → next →
 * workers`). Mandarle SIGTERM sólo al `pnpm` de arriba deja vivo al `node` que
 * escucha el puerto: el siguiente `pnpm start` muere con `EADDRINUSE` y el
 * culpable no aparece en ningún log. Con `detached: true` cada hijo encabeza su
 * propio grupo, y `kill(-pid)` le llega a todo el grupo.
 *
 * Y la condición de "ya bajó" es que **el grupo** no exista (`kill(-pid, 0)`
 * tira `ESRCH`), no que el líder haya salido: el `pnpm` puede terminar antes
 * que el `node` que cuelga de él.
 *
 * Efecto colateral buscado: un Ctrl+C en la terminal le llega sólo a este
 * proceso (los grupos hijos no son el grupo de primer plano), así que el orden
 * del apagado lo decide acá y no la carrera entre cuatro procesos recibiendo
 * SIGINT a la vez.
 */
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const useColor = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
const COLORS = {
  render: 35,
  api: 36,
  worker: 33,
  web: 32,
  media: 34,
  tunnel: 94,
  start: 1,
  setup: 90,
};

/** @param {string} name */
export function prefix(name) {
  const tag = `[${name}]`;
  const code = COLORS[/** @type {keyof typeof COLORS} */ (name)] ?? 34;
  return useColor ? `\x1b[${code}m${tag}\x1b[0m` : tag;
}

/**
 * @param {string} name
 * @param {string} message
 */
export function log(name, message) {
  process.stdout.write(`${prefix(name)} ${message}\n`);
}

/**
 * @typedef {object} Tracked
 * @property {string} name
 * @property {import("node:child_process").ChildProcess} child
 * @property {boolean} exited  el líder del grupo salió
 * @property {number | null} code
 * @property {NodeJS.Signals | null} signal
 * @property {Promise<void>} done
 * @property {Set<(line: string) => void>} lineListeners
 */

/** @type {Tracked[]} */
const tracked = [];

/**
 * Arranca un hijo en su propio grupo, con cada línea de stdout/stderr
 * prefijada. No filtra nada.
 *
 * @param {string} name
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd: string, env: NodeJS.ProcessEnv }} options
 * @returns {Tracked}
 */
export function spawnTracked(name, command, args, { cwd, env }) {
  const child = spawn(command, args, {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  /** @type {Tracked} */
  const t = {
    name,
    child,
    exited: false,
    code: null,
    signal: null,
    done: Promise.resolve(),
    lineListeners: new Set(),
  };
  t.done = new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      t.exited = true;
      t.code = code;
      t.signal = signal;
      resolve();
    });
    child.once("error", (err) => {
      log(name, `no se pudo arrancar: ${err.message}`);
      t.exited = true;
      t.code = 127;
      resolve();
    });
  });
  for (const stream of [child.stdout, child.stderr]) {
    let buffer = "";
    stream?.setEncoding("utf8");
    stream?.on("data", (chunk) => {
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        emit(t, line);
      }
    });
    stream?.on("end", () => {
      if (buffer !== "") emit(t, buffer);
      buffer = "";
    });
  }
  tracked.push(t);
  return t;
}

/**
 * @param {Tracked} t
 * @param {string} line
 */
function emit(t, line) {
  process.stdout.write(`${prefix(t.name)} ${line}\n`);
  for (const listener of t.lineListeners) listener(line);
}

/**
 * Corre un paso de preparación hasta el final y devuelve su código.
 *
 * @param {string} name
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd: string, env: NodeJS.ProcessEnv }} options
 */
export async function runStep(name, command, args, options) {
  const t = spawnTracked(name, command, args, options);
  await t.done;
  forget(t);
  return t.code ?? 1;
}

/** @param {Tracked} t */
function forget(t) {
  const i = tracked.indexOf(t);
  if (i !== -1) tracked.splice(i, 1);
}

/** @param {number | undefined} pid */
function groupAlive(pid) {
  if (pid === undefined) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {number | undefined} pid
 * @param {NodeJS.Signals} signal
 */
function signalGroup(pid, signal) {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // ESRCH: el grupo ya no existe.
  }
}

/**
 * Baja todos los hijos en orden inverso al de arranque: web antes que la API
 * que consume, worker antes que el render al que le habla. SIGTERM al grupo,
 * espera hasta `graceMs` y después SIGKILL.
 *
 * El worker necesita el margen: su SIGTERM espera a que terminen los jobs
 * activos (`queue.stop()`), y un build a mitad puede estar en la transacción
 * que reembolsa un save.
 *
 * @param {{ graceMs?: number }} [options]
 */
export async function stopAll({ graceMs = 15_000 } = {}) {
  for (const t of [...tracked].reverse()) {
    const pid = t.child.pid;
    if (!groupAlive(pid)) continue;
    log("start", `bajando ${t.name}…`);
    signalGroup(pid, "SIGTERM");
    const deadline = Date.now() + graceMs;
    while (groupAlive(pid) && Date.now() < deadline) await sleep(100);
    if (groupAlive(pid)) {
      log("start", `${t.name} no bajó en ${graceMs / 1000}s: SIGKILL`);
      signalGroup(pid, "SIGKILL");
      while (groupAlive(pid)) await sleep(50);
    }
  }
}

/** Último recurso, sincrónico: para `process.on("exit")` y el segundo Ctrl+C. */
export function killAllNow() {
  for (const t of tracked) signalGroup(t.child.pid, "SIGKILL");
}
