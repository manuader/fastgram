import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    /**
     * Los `*.int.test.ts` necesitan Docker y corren con `vitest.int.config.ts`
     * (`pnpm test:int`). Se excluyen acá para que `pnpm test` siga siendo la suite
     * rápida y sin IO — y para que un entorno sin Docker no dé falso rojo.
     */
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.int.test.ts"],
    coverage: { provider: "v8", reporter: ["text", "lcov"] },
  },
});
