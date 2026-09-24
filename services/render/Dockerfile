# syntax=docker/dockerfile:1.7
#
# services/render — ADR-007 (FFmpeg + sharp). PU-RUN-004.
#
# Contexto de build: la RAÍZ del repo (lo necesita el lockfile del monorepo):
#   docker build -f services/render/Dockerfile -t fastgram-render .
#
# ── FFmpeg: P0-REPO-004 sigue ABIERTA ────────────────────────────────────────
# Esto instala el ffmpeg de Debian, que se compila con `--enable-gpl` (libx264,
# entre otros): la imagen resultante lleva componentes GPL. Si eso es aceptable
# para distribuir la imagen, o si hace falta un build LGPL propio, es la
# decisión legal de `P0-REPO-004`, que NO se toma acá. Para correrlo uno mismo
# en su VPS no se distribuye nada; para publicar la imagen, sí importa.
# Cuando se decida, se cambia SÓLO la línea de `apt-get install ffmpeg`.
#
# ── Fuentes en Linux ─────────────────────────────────────────────────────────
# Las 32 OFL se bajan en el build (`fonts:fetch`) a /opt/fastgram/fonts y el
# servicio las activa al arrancar con un `fonts.conf` propio en
# `FONTCONFIG_FILE` (ver `src/render/fontActivation.ts`: en Linux el Pango de
# sharp usa el backend fontconfig). No se instalan en /usr/share/fonts: el
# mecanismo es el mismo que en la Mac —el directorio de RENDER_FONT_DIR— y así
# un volumen puede reemplazarlas sin reconstruir. `tiktok` y `snapchat` no se
# bajan (licencia, P2-RENDER-008): `fonts:fetch` sale con 1 por eso y el build
# comprueba el número de archivos en vez del código de salida.

ARG NODE_IMAGE=node:26.8.1-trixie-slim

# ── base: Node + pnpm (Node 26 ya no trae corepack) ──────────────────────────
FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true \
    TURBO_TELEMETRY_DISABLED=1
RUN npm install -g pnpm@12.3.4 && pnpm --version
WORKDIR /app

# ── manifests: sólo lo que decide `pnpm install` (cachea mejor) ──────────────
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

# ── build: deps completas, tsc, y las fuentes ────────────────────────────────
FROM manifests AS build
RUN --mount=type=cache,id=fastgram-pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@fastgram/render-service..."
COPY . .
RUN pnpm turbo run build --filter="@fastgram/render-service..."
RUN (pnpm --filter @fastgram/render-service fonts:fetch /opt/fastgram/fonts || true) \
 && n=$(ls /opt/fastgram/fonts/*.ttf | wc -l) \
 && echo "fuentes: $n .ttf" \
 && test "$n" -eq 32

# ── prod-deps: node_modules sin devDependencies ──────────────────────────────
FROM manifests AS prod-deps
RUN --mount=type=cache,id=fastgram-pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter "@fastgram/render-service..."

# ── runtime ──────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS runtime
# ffmpeg/ffprobe: ver P0-REPO-004 arriba. fontconfig trae /etc/fonts/fonts.conf,
# que el `fonts.conf` generado incluye; tini reenvía señales al proceso de Node.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg fontconfig tini \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    RENDER_PORT=3002 \
    RENDER_FONT_DIR=/opt/fastgram/fonts \
    RENDER_FONT_STRICT=true \
    RENDER_CACHE_DIR=/var/cache/fastgram-render
WORKDIR /app
COPY --from=prod-deps /app /app
COPY --from=build /app/packages/config/dist packages/config/dist
COPY --from=build /app/services/render/dist services/render/dist
COPY --from=build /opt/fastgram/fonts /opt/fastgram/fonts
COPY deploy/docker/entrypoint.sh /usr/local/bin/fastgram-entrypoint
# El directorio de cache existe con dueño `node` para que el volumen nombrado
# nazca con ese dueño (Docker copia permisos de la imagen al volumen vacío).
RUN mkdir -p /var/cache/fastgram-render /run/fastgram-secrets \
 && chown node:node /var/cache/fastgram-render \
 && chmod 0755 /usr/local/bin/fastgram-entrypoint
USER node
WORKDIR /app/services/render
EXPOSE 3002
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=6 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.RENDER_PORT||3002)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["tini", "--", "fastgram-entrypoint"]
CMD ["node", "dist/main.js"]
