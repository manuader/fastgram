import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const src = fileURLToPath(new URL("./src", import.meta.url));
const uiEntry = fileURLToPath(new URL("../../packages/ui/src/index.ts", import.meta.url));

/**
 * Arnés de test de componentes de `apps/web` · `P1-UI-014`.
 *
 * ## Por qué `@vitejs/plugin-react` y no el `esbuild.jsx` de `packages/ui`
 *
 * El tsconfig de esta app hereda `jsx: "preserve"` de `@fastgram/config`
 * (lo compila Next, no TypeScript). esbuild a secas, leyendo ese tsconfig,
 * preserva el JSX y el módulo resultante no es ejecutable. `packages/ui` lo
 * resuelve con `esbuild: { jsx: "automatic" }`; acá hace falta el plugin de
 * verdad porque los componentes de esta app son **client components** de Next
 * y el plugin instala además el runtime de refresh/act que espera React 19.
 * El plugin ya fuerza `esbuild.jsx = "automatic"`, así que no hay que repetirlo.
 *
 * ## Los alias, y cuál NO está
 *
 * · `@/…` — el mismo `paths` del `tsconfig.json`. Sin esto no resuelve nada:
 *   medio `src` se importa así.
 * · `@fastgram/ui` — el paquete **no tiene `dist`**: su `package.json` apunta
 *   `main` a `./src/index.ts` a propósito (ver la cabecera de ese índice). El
 *   alias es a la fuente para que el `.ts` pase por el pipeline de Vite y se
 *   transpile. La forma es un **regex anclado** (`/^@fastgram\/ui$/`) y no la
 *   cadena `"@fastgram/ui"`: el alias de cadena de Vite es por prefijo, y se
 *   llevaría por delante `@fastgram/ui/styles.css` —que importa el root
 *   layout— reescribiéndolo a `…/src/index.ts/styles.css`.
 * · `@fastgram/contracts` — **a propósito sin alias**. Ese paquete sí emite
 *   `dist` y es lo que `next build` empaqueta (`main: "./dist/index.js"`);
 *   aliasearlo a `src` haría que el test valide contra un contrato que no es
 *   el que corre. El precio es que la suite necesita el `dist` construido, que
 *   es justo lo que `turbo.json` garantiza con `test: { dependsOn: ["^build"] }`.
 *   Correr `pnpm --filter @fastgram/web test` a pelo en un clon recién bajado
 *   falla con un `Cannot find module` hasta que se haga `pnpm build`.
 *
 * ## Dos entornos, no uno
 *
 * Los tests que ya existían (`lib/api/client.test.ts`, `upstream.test.ts`, …)
 * corren en Node **a propósito**: `client.ts` tiene una rama para
 * `typeof window === "undefined"` y bajo jsdom esa rama deja de ejecutarse
 * nunca. Poner jsdom para todo la habría apagado en silencio. Así que el
 * default sigue siendo `node` y jsdom se enciende por carpeta.
 *
 * `environmentMatchGlobs` está deprecado en vitest 3 (este repo está en el 2,
 * ver el catálogo). Cuando se actualice, la traducción es un `projects`/
 * `workspace` con dos proyectos; el criterio —qué corre en qué— es el de acá.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^@\/(.*)$/, replacement: `${src}/$1` },
      { find: /^@fastgram\/ui$/, replacement: uiEntry },
    ],
  },
  test: {
    environment: "node",
    environmentMatchGlobs: [
      ["src/components/**", "jsdom"],
      ["src/app/**", "jsdom"],
    ],
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // Las llamadas quedan limpias entre tests; las implementaciones NO se
    // tocan (`restoreMocks`), porque cada test instala la suya en su propio
    // arranque y restaurarlas dejaría el mock del cliente devolviendo
    // `undefined` a mitad de archivo.
    clearMocks: true,
    coverage: { provider: "v8", reporter: ["text", "lcov"] },
  },
});
