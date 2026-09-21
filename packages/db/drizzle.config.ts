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
  schema: "./src/schema/index.ts",
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
