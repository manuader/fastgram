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
