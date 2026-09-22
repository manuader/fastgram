/**
 * Setup del arnés de componentes · `P1-UI-014`.
 *
 * Corre para **todos** los archivos de test de `apps/web`, también los que
 * están en entorno `node` (ver `vitest.config.ts`). De ahí la guarda por
 * `document`: importar `@testing-library/react` sin DOM y llamar a su
 * `cleanup` es pedirle que recorra contenedores que no existen.
 *
 * El `cleanup` es explícito y no el automático de RTL: el automático se
 * engancha al `afterEach` **global**, y este repo corre con `globals: false`
 * (los tests importan `describe`/`it`/`expect` de `vitest`, mirá cualquiera de
 * `lib/`). Sin esto, el segundo test de un archivo encuentra en el `document`
 * el árbol del primero y `getByRole` falla con "found multiple elements" — un
 * fallo que parece del componente y es del arnés.
 */
import { afterEach } from "vitest";

if (typeof document !== "undefined") {
  await import("@testing-library/jest-dom/vitest");
  const { cleanup } = await import("@testing-library/react");
  afterEach(() => {
    cleanup();
  });
}
