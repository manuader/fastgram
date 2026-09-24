# syntax=docker/dockerfile:1.7
#
# apps/api — PU-RUN-004. Una imagen, tres usos en `deploy/compose.vps.yml`:
#   - `api`          → node dist/main.js                 (el default)
#   - `public-media` → node dist/public-media/main.js    (lo que expone el túnel)
#   - `init`         → node /app/deploy/init/init.mjs    (migraciones, secretos, key)
# `public-media` vive en `apps/api/src/public-media` y comparte dependencias con
# la API: una imagen aparte sería el mismo contenido con otro CMD.
#
# Contexto de build: la RAÍZ del repo.
#   docker build -f apps/api/Dockerfile -t fastgram-api .

ARG NODE_IMAGE=node:26.8.1-trixie-slim

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true \
    TURBO_TELEMETRY_DISABLED=1
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
    pnpm install --frozen-lockfile --filter "@fastgram/api..."
COPY . .
RUN pnpm turbo run build --filter="@fastgram/api..."

FROM manifests AS prod-deps
RUN --mount=type=cache,id=fastgram-pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter "@fastgram/api..."

FROM ${NODE_IMAGE} AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    API_PORT=3001 \
    FASTGRAM_HOME=/data/fastgram-home
WORKDIR /app
COPY --from=prod-deps /app /app
COPY --from=build /app/packages/adapters/dist packages/adapters/dist
COPY --from=build /app/packages/config/dist packages/config/dist
COPY --from=build /app/packages/contracts/dist packages/contracts/dist
COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/packages/db/dist packages/db/dist
COPY --from=build /app/packages/ports/dist packages/ports/dist
COPY --from=build /app/apps/api/dist apps/api/dist
# Migraciones SQL: `migrate.js` las busca en `dist/../drizzle`.
COPY packages/db/drizzle packages/db/drizzle
# Para `init`: la lógica de la key de la web es la de `pnpm start`, no una copia.
COPY scripts/lib/dev-workspace.mjs scripts/lib/dev-workspace.mjs
COPY deploy/init/init.mjs deploy/init/init.mjs
COPY deploy/docker/entrypoint.sh /usr/local/bin/fastgram-entrypoint
# `dev-workspace.mjs` importa `postgres`, que en el repo es devDependency de la
# raíz y no se instala con `--prod --filter`. Es la MISMA versión (catálogo)
# que usa `packages/db`: se enlaza la de ahí en vez de instalar otra.
RUN ln -s ../packages/db/node_modules/postgres node_modules/postgres \
 && node -e "import('postgres').then(()=>console.log('postgres resuelve desde la raíz'))" \
 && mkdir -p /data/fastgram-home /run/fastgram-secrets \
 && chown node:node /data/fastgram-home \
 && chmod 0755 /usr/local/bin/fastgram-entrypoint
USER node
WORKDIR /app/apps/api
EXPOSE 3001
HEALTHCHECK --interval=10s --timeout=5s --start-period=40s --retries=6 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.API_PORT||3001)+'/health').then(r=>process.exit(r.status===200?0:1),()=>process.exit(1))"]
ENTRYPOINT ["tini", "--", "fastgram-entrypoint"]
CMD ["node", "dist/main.js"]
