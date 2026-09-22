import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@fastgram/ui", "@fastgram/contracts"],
  eslint: {
    // El lint corre una sola vez desde la raíz (`pnpm lint`). Que Next lo
    // repita en cada build duplica el trabajo y puede usar otra config.
    ignoreDuringBuilds: true,
  },
};

export default config;

/**
 * ## Acá había un bloque `webpack` con `extensionAlias`, y su historia importa
 *
 * `packages/ui` escribía sus imports internos con extensión `.js` (`./cn.js`)
 * aunque los archivos fueran `.ts`/`.tsx`. Webpack no hace esa traducción solo,
 * así que `next build` fallaba con `Can't resolve './cn.js'` — apuntando a
 * `packages/ui`, que es donde **no** estaba el problema. El `extensionAlias` le
 * enseñaba a webpack la regla.
 *
 * Y tapaba el síntoma sólo de un lado: **el script `dev` corre
 * `next dev --turbopack`, y turbopack no lee ese bloque.** O sea que
 * **ninguna pantalla de esta app arrancó nunca en modo desarrollo**: el
 * `layout.tsx` raíz importa `@fastgram/ui`, así que morían todas. `next build`
 * iba por webpack y estaba verde, que es por lo que nadie lo notó — hasta que
 * alguien abrió un navegador por primera vez.
 *
 * **El arreglo fue de raíz, no acá**: `packages/ui` dejó de escribir la
 * extensión. Podía hacerlo porque su `package.json` apunta `main` y `types` a
 * `./src/index.ts` — **no tiene `dist` y nadie lo corre por Node**, así que esas
 * extensiones no le servían a ningún consumidor. Con imports sin extensión, los
 * resuelven los dos bundlers y TypeScript con `moduleResolution: "Bundler"`.
 *
 * Medido después del cambio: `next dev --turbopack` sirve `/library` con
 * **200** y cero `Module not found`.
 *
 * `packages/contracts` **sí** conserva sus `.js` y tiene que conservarlos: tiene
 * `dist`, lo consume `apps/api` por Node ESM, y ahí la extensión es obligatoria.
 */
