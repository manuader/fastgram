import { defineConfig } from "vitest/config";

export default defineConfig({
  // El tsconfig del paquete usa `jsx: "preserve"` (lo compila Next). esbuild,
  // si no se le dice nada, cae al transform clásico y busca un `React` global
  // que no existe. Acá se le fija el transform automático de React 19.
  esbuild: { jsx: "automatic", jsxImportSource: "react" },
  test: {
    // Sin @testing-library/react ni jsdom instalados, estos tests no montan
    // componentes: cubren variantes de cva, la lógica pura de los helpers y la
    // cola de toasts. Qué falta y por qué está en el reporte de la sesión.
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    coverage: { provider: "v8", reporter: ["text", "lcov"] },
  },
});
