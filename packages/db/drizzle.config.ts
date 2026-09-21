/**
 * drizzle-kit — ADR-004.
 *
 * `casing: "snake_case"` tiene que coincidir con el de `createDb` en `src/client.ts`.
 * Si divergen, el SQL generado y el que emite el runtime usan nombres distintos y el
 * error recién aparece en la primera query.
 */

import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  // El schema **compilado**, no el fuente. drizzle-kit carga por `require` de CJS y
  // no resuelve `./enums.js` contra `./enums.ts`; los imports relativos llevan `.js`
  // porque sin eso el `dist` no resuelve en Node (`P0-REPO-013`). El `dist` no tiene
  // ese conflicto: es JavaScript de verdad. Por eso `db:generate` construye primero.
  schema: "./dist/schema/index.js",
  out: "./drizzle",
  casing: "snake_case",
  dbCredentials: {
    // Sólo lo usan `push` y `studio`; `generate` trabaja offline sobre el schema.
    url:
      process.env["DATABASE_URL"] ??
      "postgres://fastgram:fastgram@localhost:5432/fastgram",
  },
  strict: true,
  verbose: true,
});
