/**
 * Contenedor `init` de `deploy/compose.vps.yml` — PU-RUN-004.
 *
 * Hace en Docker lo que `scripts/start.mjs` hace antes de levantar los
 * servicios, en el mismo orden, y sale con 0 (el resto de la stack espera a
 * `service_completed_successfully`):
 *
 *  1. Migraciones (`packages/db/dist/migrate.js`: el mismo `migrateWithUrl`
 *     que `pnpm db:migrate`, compilado).
 *  2. Dueño de los volúmenes: `FASTGRAM_HOME` y el de secretos quedan del
 *     usuario `node` (1000), que es con el que corren los servicios.
 *  3. `RENDER_MEDIA_GRANT_SECRET`: si no vino del `.env`, se genera UNA vez y
 *     queda en el volumen de secretos (`render-grant-secret`, 0600). Render y
 *     worker lo leen con `RENDER_MEDIA_GRANT_SECRET_FILE`.
 *  4. Key de la web (`PU-RUN-003`): workspace personal + key, con
 *     `issueDevWorkspaceKey` de `scripts/lib/dev-workspace.mjs`.
 *
 * ── Por qué la key va a un archivo y no «sólo al entorno» como en la Mac ─────
 * `pnpm start` emite una key por corrida y se la pasa a la web por el entorno,
 * porque ahí la web muere y nace con todo lo demás. En Compose cada contenedor
 * reinicia por su cuenta: si la web se reinicia sola, necesita volver a leer la
 * misma key, y si `init` emitiera una nueva en cada `up`, revocaría la que la
 * web tiene en memoria. Así que la key vive en un volumen que sólo montan
 * `init` (rw) y `web` (ro), 0600, y **se reusa mientras siga válida** en la
 * base: sólo se emite una nueva si falta el archivo o su hash no está vigente
 * (base restaurada, key revocada a mano).
 *
 * Nunca se imprime un secreto: sólo si se generó o se reusó.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  chownSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import {
  DEV_COMPANY_ID,
  issueDevWorkspaceKey,
} from "../../scripts/lib/dev-workspace.mjs";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const NODE_UID = 1000;
const NODE_GID = 1000;

const SECRETS_DIR = process.env.FASTGRAM_SECRETS_DIR ?? "/run/fastgram-secrets";
const HOME_DIR = process.env.FASTGRAM_HOME ?? "/data/fastgram-home";
const DATABASE_URL = process.env.DATABASE_URL;

/** @param {string} msg */
const log = (msg) => process.stdout.write(`[init] ${msg}\n`);

/** @param {string} msg */
function fail(msg) {
  process.stderr.write(`[init] ERROR: ${msg}\n`);
  process.exit(1);
}

if (DATABASE_URL === undefined || DATABASE_URL === "") fail("falta DATABASE_URL");

// ── 1. Migraciones ─────────────────────────────────────────────────────────
log("migraciones…");
const migrate = spawnSync(
  process.execPath,
  [join(APP_ROOT, "packages/db/dist/migrate.js")],
  { stdio: "inherit", env: process.env },
);
if (migrate.status !== 0) fail(`las migraciones fallaron (salida ${migrate.status})`);

// ── 2. Volúmenes ───────────────────────────────────────────────────────────
/** @param {string} dir */
function ownDir(dir) {
  mkdirSync(dir, { recursive: true });
  // Sólo si corremos como root (el servicio `init` lo hace a propósito).
  if (process.getuid?.() === 0) chownSync(dir, NODE_UID, NODE_GID);
  chmodSync(dir, 0o700);
}
ownDir(SECRETS_DIR);
ownDir(HOME_DIR);
log(`volúmenes listos (${HOME_DIR}, ${SECRETS_DIR})`);

/**
 * @param {string} file
 * @param {string} value
 */
function writeSecret(file, value) {
  writeFileSync(file, value, { mode: 0o600 });
  chmodSync(file, 0o600);
  if (process.getuid?.() === 0) chownSync(file, NODE_UID, NODE_GID);
}

// ── 3. Secreto render ↔ worker ─────────────────────────────────────────────
const grantFile = join(SECRETS_DIR, "render-grant-secret");
if ((process.env.RENDER_MEDIA_GRANT_SECRET ?? "") !== "") {
  log("RENDER_MEDIA_GRANT_SECRET: viene del .env (no se genera archivo)");
} else if (existsSync(grantFile) && readFileSync(grantFile, "utf8").length >= 32) {
  log("RENDER_MEDIA_GRANT_SECRET: se reusa el del volumen");
} else {
  writeSecret(grantFile, randomBytes(32).toString("base64"));
  log("RENDER_MEDIA_GRANT_SECRET: generado en el volumen de secretos");
}

// ── 4. Key de la web ───────────────────────────────────────────────────────
const keyFile = join(SECRETS_DIR, "web-api-key");

/** @param {string} token */
async function keyStillValid(token) {
  const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    const hash = createHash("sha256").update(token, "utf8").digest("hex");
    const rows = await sql`
      select 1 from api_keys
       where hash = ${hash} and company_id = ${DEV_COMPANY_ID} and revoked_at is null
       limit 1`;
    return rows.length === 1;
  } finally {
    await sql.end();
  }
}

const existing = existsSync(keyFile) ? readFileSync(keyFile, "utf8").trim() : "";
if (existing !== "" && (await keyStillValid(existing))) {
  log("key de la web: se reusa (sigue vigente en la base)");
} else {
  const { token } = await issueDevWorkspaceKey({ databaseUrl: DATABASE_URL });
  writeSecret(keyFile, token);
  log(
    existing === ""
      ? "key de la web: emitida (workspace personal listo)"
      : "key de la web: la guardada ya no era válida; se emitió otra",
  );
}

log("listo");
