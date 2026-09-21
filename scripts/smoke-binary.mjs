#!/usr/bin/env node
/**
 * Arranca el binario compilado y le pega — `P0-REPO-013`.
 *
 * ## Por qué existe y por qué no lo cubre `pnpm verify`
 *
 * `pnpm build` puede pasar y el binario no arrancar. Pasó: los paquetes
 * apuntaban `exports` a `src/*.ts` y Node no puede importar `.ts` desde
 * `node_modules`, así que `tsc` quedaba contento y `node dist/main.js` moría
 * con `ERR_MODULE_NOT_FOUND`. Nada del pipeline lo veía, porque todo corre con
 * `tsx` o con vitest, que resuelven TypeScript.
 *
 * Y no alcanza con que arranque. La segunda vez que esto falló fue con el
 * proceso levantado y sano: arrancaba `boss.start()` en vez de `queue.start()`,
 * así que las colas no quedaban registradas y **la primera petición que encola
 * moría**. `/health` respondía 200 igual. Por eso acá se hace una escritura de
 * verdad y se mira la cola, no sólo el health check.
 *
 * ## Qué asume
 *
 * `DATABASE_URL` apuntando a una base **ya migrada** (`pnpm --filter
 * @fastgram/db db:migrate`), y `apps/api` ya construido. No migra ni construye:
 * si lo hiciera, un fallo de migración se leería como un fallo del binario.
 *
 * Correr: `node scripts/smoke-binary.mjs`
 */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import postgres from "postgres";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://fastgram:fastgram@localhost:5432/fastgram";
const PORT = Number(process.env.SMOKE_PORT ?? 3199);
const BASE = `http://127.0.0.1:${PORT}`;
const QUEUE_SCHEMA = process.env.QUEUE_SCHEMA ?? "pgboss_smoke";

const fallos = [];
const ok = [];

function check(condicion, que, detalle = "") {
  if (condicion) ok.push(que);
  else fallos.push(`${que}${detalle === "" ? "" : ` — ${detalle}`}`);
}

/** Workspace y API key de un solo uso, con ids reconocibles para poder limpiarlos. */
const COMPANY_ID = "cccccccc-0000-4000-8000-" + randomUUID().slice(-12);
const USER_ID = "dddddddd-0000-4000-8000-" + randomUUID().slice(-12);
const TOKEN = `fsln_live_${randomUUID().replaceAll("-", "")}`;
const HASH = createHash("sha256").update(TOKEN, "utf8").digest("hex");

const sql = postgres(DATABASE_URL, { max: 2, onnotice: () => {} });

async function sembrar() {
  await sql`insert into users (id, external_identity_id, email, full_name, timezone)
            values (${USER_ID}, ${"ext_" + USER_ID}, ${USER_ID + "@smoke.test"}, 'Smoke', 'UTC')`;
  await sql`insert into companies (id, name, owner_user_id, plan_id, billing_anchor_day, timezone, status)
            values (${COMPANY_ID}, 'Smoke', ${USER_ID}, 'growth', 1, 'UTC', 'active')`;
  await sql`insert into api_keys (company_id, label, hash, kind)
            values (${COMPANY_ID}, 'smoke', ${HASH}, 'workspace')`;
}

async function limpiar() {
  // En orden de dependencia. `pgboss` aparte porque su esquema es propio.
  await sql`delete from contents where company_id = ${COMPANY_ID}`.catch(() => {});
  await sql`delete from idempotency_records where company_id = ${COMPANY_ID}`.catch(() => {});
  await sql`delete from api_keys where company_id = ${COMPANY_ID}`.catch(() => {});
  await sql`delete from companies where id = ${COMPANY_ID}`.catch(() => {});
  await sql`delete from users where id = ${USER_ID}`.catch(() => {});
  await sql.unsafe(`drop schema if exists ${QUEUE_SCHEMA} cascade`).catch(() => {});
  await sql.end({ timeout: 5 });
}

/** Espera a que el proceso responda, o se rinde con el log a la vista. */
async function esperarSalud(proc, salida) {
  const limite = Date.now() + 40_000;
  while (Date.now() < limite) {
    if (proc.exitCode !== null) {
      throw new Error(`el binario murió con código ${proc.exitCode}:\n${salida.join("")}`);
    }
    try {
      const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
    } catch {
      // Todavía no escucha. Es lo normal durante el arranque.
    }
    await sleep(500);
  }
  throw new Error(`no respondió /health en 40 s:\n${salida.join("")}`);
}

const pedir = (path, init = {}) =>
  fetch(`${BASE}${path}`, {
    ...init,
    signal: AbortSignal.timeout(15_000),
    headers: { authorization: `Bearer ${TOKEN}`, ...init.headers },
  });

const WALL_OF_TEXT = {
  canvas: { width: 1080, height: 1920 },
  video: { url: "https://cdn.smoke.test/a.mp4", drawX: 0, drawY: 0, drawW: 1080, drawH: 1920 },
  text: {
    content: "Smoke",
    x: 50,
    y: 50,
    width: 800,
    fontSize: 48,
    color: "#FFFFFF",
    textAlign: "center",
  },
};

let proc;
try {
  await sembrar();

  proc = spawn(process.execPath, ["dist/main.js"], {
    cwd: new URL("../apps/api/", import.meta.url).pathname,
    env: {
      ...process.env,
      DATABASE_URL,
      DATABASE_APP_ROLE: process.env.DATABASE_APP_ROLE ?? "fastgram_app",
      QUEUE_SCHEMA,
      // Una sola vez y sobre un esquema efímero: acá no hay deploy que ordenar.
      QUEUE_MIGRATE: "true",
      API_PORT: String(PORT),
      LOG_LEVEL: "warn",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const salida = [];
  proc.stdout.on("data", (c) => salida.push(String(c)));
  proc.stderr.on("data", (c) => salida.push(String(c)));

  await esperarSalud(proc, salida);
  check(true, "el binario arranca y responde /health");

  const sinCredencial = await fetch(`${BASE}/api/v1/content`, {
    signal: AbortSignal.timeout(10_000),
  });
  check(sinCredencial.status === 401, "sin credencial → 401", `dio ${sinCredencial.status}`);
  check(
    (sinCredencial.headers.get("www-authenticate") ?? "").includes("Bearer"),
    "el 401 trae `WWW-Authenticate: Bearer` (§9.1)",
  );

  const listado = await pedir("/api/v1/content");
  check(listado.status === 200, "con credencial → 200", `dio ${listado.status}`);

  // La escritura: es la que encontró que `boss.start()` no registraba las colas.
  const creada = await pedir("/api/v1/content", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": `smoke-${randomUUID()}` },
    body: JSON.stringify(WALL_OF_TEXT),
  });
  const cuerpo = await creada.json().catch(() => ({}));
  check(
    creada.status === 201,
    "POST /content → 201",
    `dio ${creada.status}: ${JSON.stringify(cuerpo).slice(0, 200)}`,
  );

  const contentId = cuerpo?.data?._id;
  if (typeof contentId === "string") {
    const filas = await sql.unsafe(
      `select count(*)::int as n from ${QUEUE_SCHEMA}.job where data->>'contentId' = $1`,
      [contentId],
    );
    check(
      (filas[0]?.n ?? 0) === 1,
      "el job quedó encolado en pg-boss",
      `encontré ${filas[0]?.n ?? 0}`,
    );
  } else {
    check(false, "el job quedó encolado en pg-boss", "no hubo contentId que buscar");
  }
} catch (error) {
  fallos.push(String(error instanceof Error ? error.message : error));
} finally {
  if (proc !== undefined && proc.exitCode === null) {
    proc.kill("SIGTERM");
    await sleep(1500);
    if (proc.exitCode === null) proc.kill("SIGKILL");
  }
  await limpiar();
}

for (const o of ok) console.log(`  ok  ${o}`);
if (fallos.length > 0) {
  console.error(`\n✗ ${fallos.length} fallo(s) del binario compilado:\n`);
  for (const f of fallos) console.error(`  · ${f}`);
  console.error(
    "\n`pnpm verify` no mide esto: todo ahí corre con tsx o vitest, que resuelven\n" +
      "TypeScript. Lo que falla acá es el artefacto que se despliega.\n",
  );
  process.exit(1);
}
console.log(`\n✓ el binario compilado arranca, autentica, escribe y encola`);
