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
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    /**
     * Los `*.int.test.ts` quedan fuera: necesitan Postgres. Mismo criterio —y
     * mismo motivo— que en `apps/api`: `.int.test.ts` termina en `.test.ts`, así
     * que sin esta exclusión `pnpm test` pasa a exigir Docker, y una suite de
     * unit que no da verde sin infraestructura deja de ser señal de nada.
     */
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.int.test.ts"],
    coverage: { provider: "v8", reporter: ["text", "lcov"] },
  },
});
