import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    /**
     * Los `*.integration.test.ts` renderizan de verdad (sharp + Pango + FFmpeg).
     * Solos tardan 300–1500 ms; bajo `pnpm verify` —turbo corre todos los
     * paquetes a la vez— dos renders seguidos pasaron los 5 s por defecto dos
     * veces (golden y brand-backgrounds). 30 s sigue cortando un cuelgue real.
     */
    testTimeout: 30_000,
  },
});
