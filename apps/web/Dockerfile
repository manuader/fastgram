# syntax=docker/dockerfile:1.7
#
# apps/web — PU-RUN-004. `next build` + `next start`.
#
# Contexto de build: la RAÍZ del repo.
#   docker build -f apps/web/Dockerfile -t fastgram-web .
#
# La web NO tiene login (modo personal): no se publica a internet. En
# `deploy/compose.vps.yml` su puerto se ata a 127.0.0.1 (o a la IP de
# Tailscale) y el dueño entra por un túnel SSH o por Tailscale.
#
# `FASTGRAM_API_KEY` llega con `FASTGRAM_API_KEY_FILE` (la escribe `init` en el
# volumen de secretos); ver `deploy/docker/entrypoint.sh`.

ARG NODE_IMAGE=node:26.8.1-trixie-slim

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true \
    TURBO_TELEMETRY_DISABLED=1 \
    NEXT_TELEMETRY_DISABLED=1
RUN npm install -g pnpm@12.3.4 && pnpm --version
WORKDIR /app

FROM base AS manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/mcp/package.json apps/mcp/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/adapters/package.json packages/adapters/
COPY packages/config/package.json packages/config/
COPY packages/contracts/package.json packages/contracts/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/ports/package.json packages/ports/
COPY packages/ui/package.json packages/ui/
COPY services/render/package.json services/render/

FROM manifests AS build
RUN --mount=type=cache,id=fastgram-pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@fastgram/web..."
COPY . .
# `^...`: las dependencias de la web (contracts compila a dist); después la web.
RUN pnpm turbo run build --filter="@fastgram/web^..." \
 && cd apps/web && pnpm run build
# `next start` con un `next.config.ts` necesita el paquete `typescript` en
# runtime (si no está, intenta `npm install` y muere con `workspace:*`).
# typescript es devDependency: en vez de meterlo en la imagen, se transpila el
# config a `.mjs` con el typescript del build, y a runtime va sólo el `.mjs`.
RUN cd apps/web && node -e "\
const ts = require('typescript'); const fs = require('node:fs');\
const out = ts.transpileModule(fs.readFileSync('next.config.ts', 'utf8'), {\
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });\
fs.writeFileSync('next.config.mjs', out.outputText);"

FROM manifests AS prod-deps
RUN --mount=type=cache,id=fastgram-pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter "@fastgram/web..."

FROM ${NODE_IMAGE} AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000
WORKDIR /app
COPY --from=prod-deps /app /app
COPY --from=build /app/packages/contracts/dist packages/contracts/dist
COPY --from=build /app/packages/ui/src packages/ui/src
COPY --from=build /app/apps/web/next.config.mjs apps/web/next.config.mjs
COPY --from=build /app/apps/web/.next apps/web/.next
COPY deploy/docker/entrypoint.sh /usr/local/bin/fastgram-entrypoint
RUN rm -rf apps/web/.next/cache \
 && mkdir -p /run/fastgram-secrets \
 && chown -R node:node apps/web/.next \
 && chmod 0755 /usr/local/bin/fastgram-entrypoint
USER node
WORKDIR /app/apps/web
EXPOSE 3000
# Cualquier respuesta < 500: `/` puede redirigir (el mismo criterio que `pnpm start`).
HEALTHCHECK --interval=15s --timeout=10s --start-period=40s --retries=6 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/',{redirect:'manual'}).then(r=>process.exit(r.status<500?0:1),()=>process.exit(1))"]
ENTRYPOINT ["tini", "--", "fastgram-entrypoint"]
CMD ["node", "node_modules/next/dist/bin/next", "start", "-H", "0.0.0.0", "-p", "3000"]
