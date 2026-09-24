/**
 * Tests de integración de `apps/worker` — Postgres real.
 *
 * Contra la base y no con dobles porque lo que hay que verificar es
 * exactamente lo que un doble no puede fingir: que el `FOR UPDATE` bloquee, que
 * RLS deje pasar al rol de aplicación, que el CHECK del reembolso exista, y que
 * cerrar la pieza y devolver el save ocurran en la **misma** transacción.
 *
 * `DATABASE_URL` se respeta si está, y de ahí se **deriva** la base del worker
 * (`fastgram` → `fastgram_worker`), que el `globalSetup` crea si falta.
 * `singleFork`: los archivos comparten base y se pisarían entre sí.
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
    include: ["test/**/*.int.test.ts"],
    /**
     * Crea y migra la base del worker antes de todo. Ver `setup-db.ts`: es lo
     * que hace que esta suite no comparta base con la de `apps/api`, cuyos
     * fixtures truncan `companies` y `contents` — las mismas tablas que ésta
     * siembra. Corriendo las dos a la vez (turbo lo hace en `pnpm test:int`),
     * una le borraba las filas a la otra en medio de un test.
     */
    globalSetup: ["./test/helpers/setup-db.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
