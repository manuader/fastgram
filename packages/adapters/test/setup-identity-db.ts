/**
 * `globalSetup` de `test:int`: crea `…_adapters` si falta y le aplica las
 * migraciones con el script de `@fastgram/db` (adapters no depende de db y no
 * vale la pena acoplarlos por un fixture). Ver `identity-db.ts` por qué existe.
 *
 * Sin Postgres no falla: el test de identidad lo detecta en su `probe()` y se
 * saltea con el motivo en el nombre, como el resto de la suite.
 */
import { execFileSync } from "node:child_process";
import pg from "pg";

import { identityDatabaseUrl } from "./identity-db.js";

export default async function setup(): Promise<void> {
  const target = identityDatabaseUrl();
  const nombre = new URL(target).pathname.replace(/^\//, "");
  if (!/^[a-z_][a-z0-9_]*$/.test(nombre)) {
    throw new Error(`nombre de base inválido: ${JSON.stringify(nombre)}`);
  }

  const mantenimiento = new URL(target);
  mantenimiento.pathname = "/postgres";
  const admin = new pg.Client({ connectionString: mantenimiento.toString() });
  try {
    await admin.connect();
  } catch {
    return;
  }
  try {
    const { rows } = await admin.query("select 1 from pg_database where datname = $1", [
      nombre,
    ]);
    // `CREATE DATABASE` no admite `IF NOT EXISTS` ni parámetros: el nombre sale
    // de nuestro propio `DATABASE_URL` y se acotó arriba.
    if (rows.length === 0) await admin.query(`create database ${nombre}`);
  } finally {
    await admin.end();
  }

  execFileSync("pnpm", ["--filter", "@fastgram/db", "db:migrate"], {
    env: { ...process.env, DATABASE_URL: target },
    stdio: "ignore",
  });
}
