/**
 * Tests de integración de `apps/worker` — Postgres real.
 *
 * Contra la base y no con dobles porque lo que hay que verificar es
 * exactamente lo que un doble no puede fingir: que el `FOR UPDATE` bloquee, que
 * RLS deje pasar al rol de aplicación, que el CHECK del reembolso exista, y que
 * cerrar la pieza y devolver el save ocurran en la **misma** transacción.
 *
 * `DATABASE_URL` se respeta si está; el default es el del `docker-compose.yml`.
 * `singleFork`: los archivos comparten base y se pisarían entre sí.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.int.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
