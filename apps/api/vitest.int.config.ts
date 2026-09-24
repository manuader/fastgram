/**
 * Tests de integración de `apps/api` — Postgres real.
 *
 * Separados de `vitest.config.ts` porque **necesitan una base**: un entorno sin
 * Postgres tiene que poder correr `pnpm test` y que dé verde, sin que eso mienta sobre
 * si la integración se verificó. Por eso los archivos son `*.int.test.ts` y la config
 * de unit no los incluye.
 *
 * ## Por qué docker-compose y no Testcontainers
 *
 * `packages/db` usa Testcontainers y sería lo natural copiarlo, pero
 * `@testcontainers/postgresql` es dependencia de **ese** paquete y no de éste, y esta
 * tarea tiene prohibido tocar `package.json`. El Postgres de `docker compose` es
 * igual de real: la diferencia es quién levanta el contenedor, no contra qué se prueba.
 *
 * `DATABASE_URL` se respeta si está; el default es el del `docker-compose.yml`.
 *
 * `singleFork`: los tests comparten una base y se pisarían entre archivos.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { defineConfig } from "vitest/config";

/**
 * `~/.fastgram` de mentira para toda la suite (sprint 7): sin esto, una ruta que
 * lee el registro de modelos o las integraciones leía el archivo **real** del
 * dueño —y llamaba a su Ollama—. Un test que necesita otro lo pisa igual.
 */
const FASTGRAM_HOME = mkdtempSync(path.join(tmpdir(), "fastgram-test-home-"));

export default defineConfig({
  test: {
    environment: "node",
    env: { FASTGRAM_HOME },
    globalSetup: ["./test/helpers/setup-db.ts"],
    include: ["test/**/*.int.test.ts"],
    // Migrar 33 tablas y aplicar RLS no entra en los 5 s por defecto.
    testTimeout: 60_000,
    hookTimeout: 120_000,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
