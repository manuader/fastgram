import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    /**
     * Los `*.int.test.ts` quedan fuera: necesitan Postgres.
     *
     * Sin esta exclusión, `test/**‍/*.test.ts` los captura —`.int.test.ts` termina en
     * `.test.ts`— y `pnpm test` pasa a exigir Docker. El problema no es que falle: es
     * que en una máquina sin la base **pasa** silenciosamente o rompe por una razón
     * que no tiene que ver con el código, y en los dos casos deja de poder usarse como
     * señal. La suite de unit tiene que dar verde sin infraestructura, o no dice nada.
     *
     * Se corren con `pnpm --filter @fastgram/api test:int` (ver `vitest.int.config.ts`).
     */
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.int.test.ts"],
    coverage: { provider: "v8", reporter: ["text", "lcov"] },
  },
});
