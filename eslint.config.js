// Un solo eslint para todo el monorepo. Doce procesos separados tardaban más
// y hacían más fácil que un paquete terminara con reglas distintas.
import base from "./packages/config/eslint.config.js";

export default [
  ...base,
  // El entorno Python de `services/vision` (instaloader trae urllib3, que trae
  // JS de navegador): no es código nuestro.
  { ignores: ["**/.venv/**"] },
  {
    // Los tests pueden afirmar sobre cosas que el tipo dice que no son null.
    files: ["**/*.test.ts", "**/*.test.tsx", "**/test/**"],
    rules: { "no-restricted-syntax": "off" },
  },
];
