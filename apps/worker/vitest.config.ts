import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
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
