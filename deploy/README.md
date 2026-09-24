# FastGram en un VPS

`PU-RUN-004` (Docker Compose para un VPS) y `PU-RUN-006` (backups con restore probado).
PRD `D-16`: primero la Mac con `pnpm start`; después esto, para que corra 24/7.

> **Bloqueante conocido (2026-09-24): hoy la web construida para producción no se puede usar.**
> `apps/web/src/lib/auth/session.ts` → `devSessionAllowed()` devuelve `NODE_ENV !== "production"`,
> y `next build` fija `NODE_ENV=production`: el middleware manda todo a `/login` y el proxy responde
> 401 «Sign in to continue» a cada llamada a la API. La stack levanta sana y la API, el worker y el
> render funcionan; lo que falta es que la web acepte el modo personal. Probado con un cambio de una
> línea (`|| process.env["FASTGRAM_MODE"] === "personal"`) en una copia: con eso `/library` da 200 y
> `POST /content` por el proxy da 201. El cambio es de `apps/web`, no de este directorio.

Qué hay acá:

| Archivo | Para qué |
|---|---|
| `compose.vps.yml` | La stack entera: postgres, minio, init, render, api, worker, web, public-media, cloudflared |
| `.env.vps.example` | Cada variable, con un comentario. Se copia a `deploy/.env` |
| `init/init.mjs` | Migraciones, secreto render↔worker y key de la web (lo que hace `pnpm start` antes de levantar) |
| `docker/entrypoint.sh` | Pasa secretos de archivo a variable (`<VAR>_FILE`) |
| `backup/backup.sh` · `restore.sh` · `test-restore.sh` | Backups, restore y la prueba del restore |

Los Dockerfiles están al lado de cada app: `apps/api/Dockerfile` (también corre `public-media` e
`init`), `apps/worker/Dockerfile`, `apps/web/Dockerfile`, `services/render/Dockerfile`.

---

## 1. Qué cambia respecto de la Mac

| En la Mac (`pnpm start`) | En el VPS (Compose) |
|---|---|
| `~/.fastgram` (models.json, integrations.json, `secret.key`) | volumen `fastgram-home`, montado en `/data/fastgram-home` (api, worker, public-media) |
| `~/fastgram-fonts` + CoreText por proceso (`--experimental-ffi`) | las 32 fuentes OFL **dentro de la imagen de render**, activadas por fontconfig (`FONTCONFIG_FILE`) |
| `RENDER_MEDIA_GRANT_SECRET` efímero por corrida | generado una vez por `init` en el volumen `secrets` (o fijo desde `.env`) |
| key de la web emitida en cada `pnpm start`, sólo en memoria | emitida por `init` y guardada en el volumen `secrets` (0600, sólo la montan `init` y `web`); se **reusa** mientras siga vigente en la base |
| Postgres y MinIO del `docker-compose.yml` de desarrollo | los de esta stack, en otro proyecto (`fastgram-vps`) y con otros volúmenes |
| `cloudflared` quick tunnel o named | sólo named tunnel (`TUNNEL_TOKEN`): un VPS necesita un hostname fijo |
| todo en `localhost` | la web y MinIO publicados **sólo** en `FASTGRAM_BIND` (127.0.0.1 o la IP de Tailscale); la API no se publica |

Por qué la key de la web va a un archivo y no «sólo al entorno»: en Compose cada contenedor se
reinicia por su cuenta. Si la web se cae y vuelve, necesita la misma key; y si `init` emitiera una
nueva en cada `up`, revocaría la que la web tiene en memoria. Detalle en `init/init.mjs`.

---

## 2. Requisitos

- Un VPS Linux con Docker Engine y el plugin `docker compose` v2.20 o más nuevo (el compose usa
  `depends_on.required`). Instalación: <https://docs.docker.com/engine/install/>.
- Salida a internet **al construir**: la imagen de render baja las fuentes de Google Fonts y la del
  worker instala `yt-dlp` de PyPI.
- Disco: las imágenes pesan, medido en arm64 — web 1,32 GB, worker 1,21 GB, render 1,09 GB, api
  537 MB, pgvector 646 MB, minio 228 MB — más la caché de build, la base y el bucket.
- Memoria: en reposo la stack usó **~1,15 GB** (medido: minio 427 MB, render 307 MB, api 145 MB,
  postgres 85 MB, web 82 MB, worker 64 MB, public-media 35 MB). El pico de un render de video y
  el de `next build` **no se midieron**: construir en un VPS con poca memoria puede quedarse sin RAM.

No se recomienda ningún proveedor ni precio acá: no se evaluó ninguno.

---

## 3. Primer arranque

```bash
git clone <repo> fastgram && cd fastgram
cp deploy/.env.vps.example deploy/.env
chmod 600 deploy/.env
# completar deploy/.env: POSTGRES_PASSWORD, MINIO_ROOT_PASSWORD, S3_SECRET_ACCESS_KEY
# (cada uno con `openssl rand -hex 24`), TZ, FASTGRAM_BIND y FASTGRAM_APP_ORIGIN.
docker compose -f deploy/compose.vps.yml up -d --build --wait
docker compose -f deploy/compose.vps.yml ps
```

`up --wait` vuelve cuando todos los servicios están `healthy` (o sale con error diciendo cuál no).
El orden lo resuelve Compose: postgres y minio → `minio-init` (bucket, lectura anónima, usuario de
la app) → `init` (migraciones, secretos, key) → render → api → worker → web.

**Trampa: `umask`.** Si el repo se clonó con `umask 077`, los archivos quedan `600` y los procesos
de las imágenes (usuario `node`) mueren con `EACCES` leyendo `/app/package.json`. Cloná con el
umask normal (022) o `chmod -R a+rX` antes de construir.

Logs: `docker compose -f deploy/compose.vps.yml logs -f render worker`. Al arrancar, el render
loguea `"verified":32` (las 32 fuentes OFL; `tiktok` y `snapchat` no tienen archivo, `P2-RENDER-008`).

---

## 4. Acceso (la app no tiene login)

El modo personal no tiene autenticación. **No publiques la web ni la API a internet**, ni pongas
`FASTGRAM_BIND=0.0.0.0`: quien llegue al puerto usa tu cuenta y tus keys.

Hay dos cosas que tu navegador necesita alcanzar: la **web** y el **bucket** (las subidas van
directo a MinIO con URLs firmadas, y las imágenes se muestran desde `S3_PUBLIC_URL`). Por eso el
bucket se llama igual adentro y afuera: `S3_HOSTNAME` (default `fastgram-s3`) es un alias de red del
contenedor de MinIO, y en tu computadora tiene que resolver al VPS.

### Opción A — túnel SSH (la más cerrada, sin instalar nada)

`FASTGRAM_BIND=127.0.0.1`, `FASTGRAM_APP_ORIGIN=http://localhost:3000`. En tu computadora:

```bash
# una vez: que fastgram-s3 resuelva a tu propia máquina (el túnel lo lleva al VPS)
echo "127.0.0.1 fastgram-s3" | sudo tee -a /etc/hosts
# cada vez:
ssh -N -L 3000:127.0.0.1:3000 -L 9000:127.0.0.1:9000 usuario@tu-vps
```

y abrís <http://localhost:3000>. Las redirect URIs locales de OAuth (`http://localhost:3000/...`)
siguen valiendo.

### Opción B — Tailscale

Con Tailscale en el VPS y en tus dispositivos (<https://tailscale.com/kb/1017/install>):
`FASTGRAM_BIND=<IP de Tailscale del VPS>` (`tailscale ip -4`),
`FASTGRAM_APP_ORIGIN=http://<nombre-o-IP-del-VPS>:3000`, y en cada dispositivo
`<IP de Tailscale del VPS> fastgram-s3` en `/etc/hosts` (o un registro DNS del tailnet con ese nombre).

Sin verificar: si Docker arranca antes que `tailscaled` al bootear, la IP todavía no existe y el
bind a esa IP falla. Revisalo después del primer reinicio del VPS.

### El túnel de Cloudflare no es para vos

`cloudflared` (perfil `tunnel`) expone **sólo** `public-media`: la media firmada que bajan Instagram
y TikTok, y el callback de OAuth. Comparte la red del contenedor de `public-media` (que escucha en
127.0.0.1 de su propio contenedor), así que no llega a nada más.

1. En el dashboard de Cloudflare, crear un named tunnel con una ruta pública `<host>` →
   `http://localhost:3003` (sin path; ver `scripts/lib/tunnel.mjs`).
2. En `deploy/.env`: `TUNNEL_TOKEN=<token>`, `FASTGRAM_PUBLIC_URL=https://<host>`,
   `COMPOSE_PROFILES=minio,tunnel`.
3. `docker compose -f deploy/compose.vps.yml up -d`.

Sin verificar con un túnel real (ver §8).

---

## 5. Actualizar

```bash
git pull
docker compose -f deploy/compose.vps.yml up -d --build --wait
```

`init` vuelve a correr (migraciones hacia adelante, idempotente) y reusa secretos y key. Hacé un
backup antes (§6). `yt-dlp` se instala en su última versión **al construir**: si los imports por
link empiezan a fallar, `up -d --build worker` lo actualiza (o fijá `YTDLP_VERSION` como build arg).

---

## 6. Backups y restore (`PU-RUN-006`)

Todo corre en el host con Docker (no hace falta `pg_dump` ni `mc` instalados). Leen `deploy/.env`.

```bash
sudo deploy/backup/backup.sh          # snapshot en BACKUP_DIR
sudo deploy/backup/test-restore.sh    # restaura el último en un Postgres TEMPORAL y compara
```

Cada snapshot (`BACKUP_DIR/daily/<fecha>/`) trae `db.dump` (pg_dump custom), `globals.sql` (roles:
las políticas RLS nombran a `fastgram_app`), `counts.tsv` (filas por tabla), `fastgram-home.tar.gz`,
`bucket-manifest.tsv` y `SHA256SUMS`. El bucket se espeja con `mc mirror` en `BACKUP_DIR/bucket/`
(acumulativo: lo borrado en el bucket no se borra del espejo). El primer snapshot de cada semana
ISO queda además en `weekly/` (hardlinks). Retención: `BACKUP_KEEP_DAILY` (7) y
`BACKUP_KEEP_WEEKLY` (4).

**`fastgram-home.tar.gz` es sensible**: tiene `secret.key` (descifra las credenciales de las redes
guardadas en la base) y `models.json` (keys de proveedores). Sin él, restaurar la base no recupera
las conexiones. `BACKUP_DIR` queda `700`.

**Un backup en el mismo disco no te salva de perder el VPS.** Para una copia afuera:
`BACKUP_OFFSITE_URL=https://<access>:<secret>@<host>` (formato `MC_HOST_*` de `mc`) y
`BACKUP_OFFSITE_PATH=<bucket>/<prefijo>`.

Cron diario (ejemplo, 04:15 UTC):

```cron
15 4 * * * cd /ruta/a/fastgram && deploy/backup/backup.sh >> /var/log/fastgram-backup.log 2>&1 && deploy/backup/test-restore.sh >> /var/log/fastgram-backup.log 2>&1
```

Restore sobre la stack (destructivo para lo que restaura; sin `--yes` sólo muestra el plan):

```bash
deploy/backup/restore.sh /var/backups/fastgram/daily/<fecha> --yes              # base + bucket + home
deploy/backup/restore.sh /var/backups/fastgram/daily/<fecha> --db --yes         # sólo la base
```

Baja api/worker/web/public-media, recrea la base, aplica roles y dump, y vuelve a levantar con
`up -d` (así `init` revalida la key de la web contra la base restaurada).

---

## 7. Qué quedó fuera de acá, a propósito

- **FFmpeg y la licencia (`P0-REPO-004`, abierta).** Render y worker usan el `ffmpeg` de Debian,
  compilado con componentes GPL. Para correrlo en tu propio VPS no distribuís nada; para publicar
  las imágenes, sí importa. La decisión es legal y no se tomó acá: cuando se tome, se cambia una
  línea en cada Dockerfile.
- **S3 externo (R2).** El compose lo admite (sacar `minio` de `COMPOSE_PROFILES` y apuntar `S3_*`),
  pero el bucket necesita lectura pública y CORS, y nada de eso está probado (`P1-INFRA-004`).

## 8. Qué está verificado y qué no

Verificado (2026-09-24, Docker Desktop en macOS arm64, proyecto de prueba aparte):
`up -d --build --wait` con todos los servicios `healthy`; el render en Linux con las 32 fuentes
verificadas por la sonda y un JPEG con Inter Bold, Anton y Pacifico legibles; una pieza slideshow
creada por la API, construida por el worker con el render real y subida a MinIO; backup,
`test-restore` (68 tablas iguales) y un restore real sobre la stack después de borrar filas y un
objeto del bucket.

No verificado: la web usada desde un navegador (ver el bloqueante de arriba); un VPS x86_64 real; Tailscale; el named tunnel con un token real; el pico de memoria
de un render de video; construir en una máquina chica; R2.
