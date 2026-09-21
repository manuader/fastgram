/**
 * Aplicación de migraciones — P1-DATA-001.
 *
 * Se usa desde tres lados: el script `db:migrate`, el arranque de `staging`/`prod`, y
 * los tests de integración (que necesitan aplicar todo sobre una base vacía).
 *
 * IMPL §4: *"migraciones siempre hacia adelante"*. No hay `down`, y no es un olvido.
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { migrate } from "drizzle-orm/postgres-js/migrator";

import { createDb, type Database } from "./client.js";

/** `packages/db/drizzle`, resuelto relativo a este archivo y no al cwd. */
export const MIGRATIONS_FOLDER = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../drizzle",
);

export async function applyMigrations(db: Database): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}

/** Abre una conexión propia, migra y la cierra. Para el CLI y para los tests. */
export async function migrateWithUrl(url: string): Promise<void> {
  // Pool de 1: una migración es secuencial y no gana nada con conexiones extra.
  const handle = createDb({ url, max: 1 });
  try {
    await applyMigrations(handle.db);
  } finally {
    await handle.close();
  }
}

const isDirectRun =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  const url = process.env["DATABASE_URL"];
  if (url === undefined || url === "") {
    console.error("Falta DATABASE_URL.");
    process.exit(1);
  }
  await migrateWithUrl(url);
  console.log("Migraciones aplicadas.");
}
