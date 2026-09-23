/**
 * Tests de integración de adaptadores — Postgres real.
 *
 * Separados de `vitest.config.ts` por la misma razón que en `packages/db`: un
 * entorno sin base tiene que poder correr `pnpm test` en verde sin que eso
 * mienta sobre si la integración se verificó.
 *
 * `singleFork` porque estos tests comparten una sola base de desarrollo y cada
 * archivo usa su propio esquema de pg-boss; en paralelo, las migraciones de
 * pg-boss de dos archivos distintos se pisan en `pg_catalog` y fallan con un
 * error de concurrencia que no tiene nada que ver con lo que se está probando.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.int.test.ts", "test/**/*.int.test.ts"],
    // Base propia para identidad: ver `test/identity-db.ts`.
    globalSetup: ["./test/setup-identity-db.ts"],
    testTimeout: 120_000,
    hookTimeout: 180_000,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
