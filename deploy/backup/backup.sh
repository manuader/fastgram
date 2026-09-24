#!/usr/bin/env bash
# Backup de FastGram en el VPS — PU-RUN-006.
#
#   deploy/backup/backup.sh            (con la stack arriba; cron: ver README)
#
# Deja en BACKUP_DIR:
#   daily/<AAAA-MM-DDTHHMMSSZ>/
#     db.dump             pg_dump formato custom (pg_restore)
#     globals.sql         roles (pg_dumpall --roles-only): las políticas RLS
#                         nombran a `fastgram_app`; sin el rol, el restore falla
#     counts.tsv          filas por tabla al momento del backup (lo compara el
#                         test de restore)
#     fastgram-home.tar.gz  el volumen `~/.fastgram`: secret.key, models.json,
#                         integrations.json. SENSIBLE: secret.key descifra las
#                         credenciales guardadas en la base. Sin él, las
#                         conexiones no se recuperan.
#     bucket-manifest.tsv clave y tamaño de cada objeto del bucket
#     SHA256SUMS
#   weekly/<AAAA-Www>/     hardlinks del primer daily de cada semana ISO
#   bucket/                espejo del bucket (`mc mirror`, acumulativo: un
#                          objeto borrado en el origen NO se borra acá)
#
# Retención: BACKUP_KEEP_DAILY diarios y BACKUP_KEEP_WEEKLY semanales.
# Copia fuera del VPS opcional: BACKUP_OFFSITE_URL + BACKUP_OFFSITE_PATH.
#
# Sale con != 0 ante cualquier fallo, y un snapshot a medias queda como
# `*.partial` (nunca se cuenta como backup ni lo borra la retención de otros).

# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

BACKUP_DIR="$(env_get BACKUP_DIR /var/backups/fastgram)"
KEEP_DAILY="$(env_get BACKUP_KEEP_DAILY 7)"
KEEP_WEEKLY="$(env_get BACKUP_KEEP_WEEKLY 4)"
S3_ENDPOINT="$(env_get S3_ENDPOINT)"
S3_BUCKET="$(env_get S3_BUCKET)"
S3_ACCESS_KEY_ID="$(env_get S3_ACCESS_KEY_ID)"
S3_SECRET_ACCESS_KEY="$(env_get S3_SECRET_ACCESS_KEY)"
OFFSITE_URL="$(env_get BACKUP_OFFSITE_URL)"
OFFSITE_PATH="$(env_get BACKUP_OFFSITE_PATH)"

[ -n "$S3_ENDPOINT" ] && [ -n "$S3_BUCKET" ] || die "faltan S3_ENDPOINT / S3_BUCKET en $ENV_FILE"
case "$KEEP_DAILY$KEEP_WEEKLY" in *[!0-9]*) die "BACKUP_KEEP_* tienen que ser números" ;; esac
[ "$KEEP_DAILY" -ge 1 ] || die "BACKUP_KEEP_DAILY tiene que ser >= 1"

compose ps --status running --services 2>/dev/null | grep -qx postgres ||
  die "postgres no está corriendo en el proyecto $PROJECT"

umask 077
mkdir -p "$BACKUP_DIR/daily" "$BACKUP_DIR/weekly" "$BACKUP_DIR/bucket"
STAMP="$(date -u +%Y-%m-%dT%H%M%SZ)"
WORK="$BACKUP_DIR/daily/$STAMP.partial"
FINAL="$BACKUP_DIR/daily/$STAMP"
mkdir -p "$WORK"
log "snapshot $STAMP → $BACKUP_DIR"

# ── 1. Postgres ────────────────────────────────────────────────────────────
log "pg_dump (formato custom)…"
compose exec -T postgres pg_dump -U fastgram -d fastgram -Fc >"$WORK/db.dump"
compose exec -T postgres pg_dumpall -U fastgram --roles-only >"$WORK/globals.sql"
compose exec -T postgres psql -U fastgram -d fastgram -At -F $'\t' -c "$COUNTS_SQL" >"$WORK/counts.tsv"
# Que el dump se pueda leer: pg_restore --list recorre el TOC entero.
toc_entries="$(compose exec -T postgres pg_restore --list <"$WORK/db.dump" | grep -vc '^;')" ||
  die "pg_restore --list no pudo leer el dump"
log "  db.dump $(wc -c <"$WORK/db.dump" | tr -d ' ') B, $toc_entries entradas en el TOC, $(wc -l <"$WORK/counts.tsv" | tr -d ' ') tablas"

# ── 2. FASTGRAM_HOME ───────────────────────────────────────────────────────
log "volumen fastgram-home…"
docker run --rm -v "$(volume_name fastgram-home)":/src:ro --entrypoint tar "$PG_IMAGE" \
  -C /src -czf - . >"$WORK/fastgram-home.tar.gz"

# ── 3. Bucket ──────────────────────────────────────────────────────────────
# Por la red de la stack: con MinIO local, el endpoint es el alias de red; con
# un S3 externo, sale a internet igual. Credenciales de la app (readwrite).
log "mc mirror del bucket $S3_BUCKET…"
SRC_URL="$(mc_host_url "$S3_ENDPOINT" "$S3_ACCESS_KEY_ID" "$S3_SECRET_ACCESS_KEY")"
docker run --rm --network "$(network_name)" \
  -e MC_HOST_src="$SRC_URL" \
  -v "$BACKUP_DIR/bucket":/backup \
  "$MC_IMAGE" mirror --quiet --overwrite "src/$S3_BUCKET" /backup
docker run --rm --network "$(network_name)" -e MC_HOST_src="$SRC_URL" \
  --entrypoint /bin/sh "$MC_IMAGE" -c \
  "mc ls --recursive --json src/$S3_BUCKET" |
  sed -n 's/.*"size":\([0-9]*\).*"key":"\([^"]*\)".*/\2\t\1/p' | sort >"$WORK/bucket-manifest.tsv"
log "  $(wc -l <"$WORK/bucket-manifest.tsv" | tr -d ' ') objetos en el bucket"

# ── 4. Cierre ──────────────────────────────────────────────────────────────
(cd "$WORK" && sha256sum ./* 2>/dev/null >SHA256SUMS || shasum -a 256 ./* >SHA256SUMS)
mv "$WORK" "$FINAL"
log "snapshot listo: $FINAL"

# Semanal: el primer daily de cada semana ISO (no «el domingo»: si el domingo
# falla, la semana igual tiene su copia).
WEEK="$(date -u +%G-W%V)"
if [ ! -d "$BACKUP_DIR/weekly/$WEEK" ]; then
  link_copy "$FINAL" "$BACKUP_DIR/weekly/$WEEK"
  log "semanal $WEEK creado"
fi

# ── 5. Retención (sólo snapshots completos; los .partial se dejan para mirar) ──
prune() {
  local dir="$1" keep="$2" n=0 entry
  # Los nombres ordenan cronológicamente; del más nuevo al más viejo.
  for entry in $(ls -1 "$dir" | grep -v '\.partial$' | sort -r); do
    n=$((n + 1))
    if [ "$n" -gt "$keep" ]; then
      rm -rf "${dir:?}/$entry"
      log "retención: borrado $(basename "$dir")/$entry"
    fi
  done
}
prune "$BACKUP_DIR/daily" "$KEEP_DAILY"
prune "$BACKUP_DIR/weekly" "$KEEP_WEEKLY"

# ── 6. Fuera del VPS (opcional) ────────────────────────────────────────────
if [ -n "$OFFSITE_URL" ]; then
  [ -n "$OFFSITE_PATH" ] || die "BACKUP_OFFSITE_URL sin BACKUP_OFFSITE_PATH (bucket/prefijo)"
  log "copia fuera del VPS → $OFFSITE_PATH"
  # daily/weekly con --remove: el destino respeta la retención. bucket sin
  # --remove: acumulativo, como el espejo local.
  for part in daily weekly; do
    docker run --rm -e MC_HOST_off="$OFFSITE_URL" -v "$BACKUP_DIR/$part":/src/$part:ro \
      "$MC_IMAGE" mirror --quiet --overwrite --remove --exclude "*.partial/*" \
      "/src/$part" "off/$OFFSITE_PATH/$part"
  done
  docker run --rm -e MC_HOST_off="$OFFSITE_URL" -v "$BACKUP_DIR/bucket":/src/bucket:ro \
    "$MC_IMAGE" mirror --quiet --overwrite "/src/bucket" "off/$OFFSITE_PATH/bucket"
fi

log "backup OK"
