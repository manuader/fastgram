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
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globalSetup: ["./test/helpers/setup-db.ts"],
    include: ["test/**/*.int.test.ts"],
    // Migrar 33 tablas y aplicar RLS no entra en los 5 s por defecto.
    testTimeout: 60_000,
    hookTimeout: 120_000,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
