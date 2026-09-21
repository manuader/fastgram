import type { NextConfig } from "next";

/**
 * Sólo el trozo del config de webpack que tocamos.
 *
 * El tipo que expone Next para ese parámetro es `any`; declararlo así en vez de
 * aceptarlo evita el `any` y, de paso, documenta qué es lo único que se toca.
 */
interface WebpackResolveConfig {
  resolve: { extensionAlias?: Record<string, readonly string[]> };
}

const config: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@fastgram/ui", "@fastgram/contracts"],
  eslint: {
    // El lint corre una sola vez desde la raíz (`pnpm lint`). Que Next lo
    // repita en cada build duplica el trabajo y puede usar otra config.
    ignoreDuringBuilds: true,
  },

  /**
   * **Por qué existe este `webpack`.**
   *
   * `packages/ui` escribe sus imports internos con extensión `.js`
   * (`./cn.js`, `./i18n/index.js`) aunque los archivos sean `.ts`/`.tsx`: es lo
   * que exige el ESM de Node y lo que TypeScript resuelve sin ayuda. Webpack no
   * hace esa traducción por su cuenta, así que sin esto `next build` falla con
   * `Can't resolve './cn.js'` — y el error apunta a `packages/ui`, que es donde
   * **no** está el problema. Costó un rato entenderlo.
   *
   * `extensionAlias` le enseña a webpack la misma regla que ya aplican
   * TypeScript y Node.
   */
  webpack(webpackConfig: WebpackResolveConfig) {
    webpackConfig.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js", ".jsx"],
      ".mjs": [".mts", ".mjs"],
      ".cjs": [".cts", ".cjs"],
    };
    return webpackConfig;
  },
};

export default config;
