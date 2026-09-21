/**
 * Tests de integración — Postgres real vía Testcontainers (IMPL §4, tabla de testing).
 *
 * Separados de `vitest.config.ts` porque **necesitan Docker**: un entorno sin Docker
 * tiene que poder correr `pnpm test` y que dé verde, sin que eso mienta sobre si la
 * integración se verificó. Por eso los archivos son `*.int.test.ts` y la config de
 * unit los excluye explícitamente.
 *
 * `singleFork`: cada archivo levanta su propio contenedor. Correrlos en paralelo
 * multiplica los contenedores y, en una máquina con poca RAM, hace que fallen por
 * timeout en vez de por el motivo real.
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.int.test.ts"],
    // Arrancar Postgres, migrar 33 tablas y aplicar RLS no entra en los 5 s default.
    testTimeout: 120_000,
    hookTimeout: 180_000,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
