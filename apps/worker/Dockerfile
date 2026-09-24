# syntax=docker/dockerfile:1.7
#
# apps/worker — PU-RUN-004.
#
# Contexto de build: la RAÍZ del repo.
#   docker build -f apps/worker/Dockerfile -t fastgram-worker .
#
# El worker NO levanta si tiene `RENDER_SERVICE_URL` y el render no contesta
# `/capabilities` al arrancar: en Compose eso es `depends_on: render:
# service_healthy` más `restart`, no un sleep.
#
# Sonda de salud: `WORKER_HEALTH_PORT` (default 0 = apagada en el código). En la
# imagen se pone 3004 para que el HEALTHCHECK tenga a quién preguntarle; el
# puerto no se publica.

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
    pnpm install --frozen-lockfile --filter "@fastgram/worker..."
COPY . .
RUN pnpm turbo run build --filter="@fastgram/worker..."

FROM manifests AS prod-deps
RUN --mount=type=cache,id=fastgram-pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter "@fastgram/worker..."

FROM ${NODE_IMAGE} AS runtime
# Herramientas de `media-import` (memes por link): sin yt-dlp, ffmpeg y ffprobe
# el handler NO se monta y los imports quedan `queued` para siempre (el worker
# lo avisa al arrancar, y nada más).
#  - ffmpeg: el de Debian, con componentes GPL. Misma situación que el render:
#    `P0-REPO-004` (licencia del build de FFmpeg) sigue abierta y NO se decide acá.
#  - yt-dlp: desde PyPI y no el paquete de Debian (trixie trae 2025.04.30): los
#    extractores se rompen cada pocas semanas y uno viejo falla en silencio
#    contra Instagram/TikTok. Sin YTDLP_VERSION se instala la última al construir;
#    para actualizarlo, reconstruir la imagen (`up -d --build worker`).
ARG YTDLP_VERSION=
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ffmpeg python3 python3-venv ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && python3 -m venv /opt/yt-dlp \
 && /opt/yt-dlp/bin/pip install --no-cache-dir "yt-dlp${YTDLP_VERSION:+==$YTDLP_VERSION}" \
 && ln -s /opt/yt-dlp/bin/yt-dlp /usr/local/bin/yt-dlp \
 && yt-dlp --version
ENV NODE_ENV=production \
    WORKER_HEALTH_PORT=3004 \
    FASTGRAM_HOME=/data/fastgram-home
WORKDIR /app
COPY --from=prod-deps /app /app
COPY --from=build /app/packages/adapters/dist packages/adapters/dist
COPY --from=build /app/packages/config/dist packages/config/dist
COPY --from=build /app/packages/contracts/dist packages/contracts/dist
COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/packages/db/dist packages/db/dist
COPY --from=build /app/packages/ports/dist packages/ports/dist
COPY --from=build /app/apps/worker/dist apps/worker/dist
COPY deploy/docker/entrypoint.sh /usr/local/bin/fastgram-entrypoint
RUN mkdir -p /data/fastgram-home /run/fastgram-secrets \
 && chown node:node /data/fastgram-home \
 && chmod 0755 /usr/local/bin/fastgram-entrypoint
USER node
WORKDIR /app/apps/worker
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=6 \
  CMD ["node", "-e", "const p=process.env.WORKER_HEALTH_PORT;if(!p||p==='0')process.exit(0);fetch('http://127.0.0.1:'+p+'/health/ready').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["tini", "--", "fastgram-entrypoint"]
CMD ["node", "dist/main.js"]
