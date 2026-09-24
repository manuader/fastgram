#!/usr/bin/env bash
# Restore de FastGram en el VPS — PU-RUN-006.
#
#   deploy/backup/restore.sh <snapshot> [--db] [--bucket] [--home] --yes
#
# <snapshot> es un directorio de BACKUP_DIR/daily o weekly. Sin --db/--bucket/
# --home restaura las tres cosas. ES DESTRUCTIVO para lo que restaura:
#   --db      borra la base `fastgram` de la stack y la recrea desde db.dump
#             (antes aplica globals.sql: roles). Baja api/worker/web/public-media
#             mientras tanto y los vuelve a levantar.
#   --bucket  sube el espejo BACKUP_DIR/bucket al bucket (--overwrite; no borra
#             objetos que el bucket tenga de más).
#   --home    reemplaza el contenido del volumen fastgram-home por el tar.
# Sin --yes no hace nada: imprime lo que haría.
#
# Antes de restaurar sobre la stack de verdad, probá el snapshot con
# deploy/backup/test-restore.sh (Postgres temporal, no toca nada).

# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

SNAP="${1:-}"
[ -n "$SNAP" ] && [ -d "$SNAP" ] || die "uso: $0 <snapshot> [--db] [--bucket] [--home] --yes"
shift
DO_DB=0 DO_BUCKET=0 DO_HOME=0 YES=0
for arg in "$@"; do
  case "$arg" in
    --db) DO_DB=1 ;;
    --bucket) DO_BUCKET=1 ;;
    --home) DO_HOME=1 ;;
    --yes) YES=1 ;;
    *) die "argumento desconocido: $arg" ;;
  esac
done
if [ $((DO_DB + DO_BUCKET + DO_HOME)) -eq 0 ]; then DO_DB=1 DO_BUCKET=1 DO_HOME=1; fi

BACKUP_DIR="$(env_get BACKUP_DIR /var/backups/fastgram)"
S3_ENDPOINT="$(env_get S3_ENDPOINT)"
S3_BUCKET="$(env_get S3_BUCKET)"
S3_ACCESS_KEY_ID="$(env_get S3_ACCESS_KEY_ID)"
S3_SECRET_ACCESS_KEY="$(env_get S3_SECRET_ACCESS_KEY)"

for f in db.dump globals.sql fastgram-home.tar.gz; do
  [ -s "$SNAP/$f" ] || die "al snapshot le falta $f"
done
if [ -f "$SNAP/SHA256SUMS" ]; then
  (cd "$SNAP" && (sha256sum -c --quiet SHA256SUMS 2>/dev/null || shasum -a 256 -c --quiet SHA256SUMS)) ||
    die "SHA256SUMS no coincide: el snapshot está corrupto"
  log "SHA256SUMS OK"
fi

log "plan: db=$DO_DB bucket=$DO_BUCKET home=$DO_HOME desde $SNAP (proyecto $PROJECT)"
[ "$YES" -eq 1 ] || {
  log "sin --yes: no se tocó nada."
  exit 0
}

APP_SERVICES="api worker web public-media"

if [ "$DO_DB" -eq 1 ] || [ "$DO_HOME" -eq 1 ]; then
  log "bajando $APP_SERVICES…"
  # shellcheck disable=SC2086
  compose stop $APP_SERVICES
fi

if [ "$DO_DB" -eq 1 ]; then
  log "recreando la base fastgram…"
  compose exec -T postgres dropdb -U fastgram --if-exists --force fastgram
  compose exec -T postgres createdb -U fastgram fastgram
  # Los roles pueden existir ya (el de la stack): esos errores son esperados.
  compose exec -T postgres psql -U fastgram -d postgres -q <"$SNAP/globals.sql" >/dev/null 2>&1 || true
  compose exec -T postgres pg_restore -U fastgram -d fastgram --exit-on-error <"$SNAP/db.dump"
  log "base restaurada"
fi

if [ "$DO_HOME" -eq 1 ]; then
  log "restaurando fastgram-home…"
  docker run --rm -i -v "$(volume_name fastgram-home)":/dst --entrypoint /bin/sh "$PG_IMAGE" -c \
    'find /dst -mindepth 1 -delete && tar -C /dst -xzf - && chown -R 1000:1000 /dst' \
    <"$SNAP/fastgram-home.tar.gz"
fi

if [ "$DO_BUCKET" -eq 1 ]; then
  [ -d "$BACKUP_DIR/bucket" ] || die "no hay espejo del bucket en $BACKUP_DIR/bucket"
  log "subiendo el espejo del bucket a $S3_BUCKET…"
  docker run --rm --network "$(network_name)" \
    -e MC_HOST_dst="$(mc_host_url "$S3_ENDPOINT" "$S3_ACCESS_KEY_ID" "$S3_SECRET_ACCESS_KEY")" \
    -v "$BACKUP_DIR/bucket":/backup:ro \
    "$MC_IMAGE" mirror --quiet --overwrite /backup "dst/$S3_BUCKET"
fi

if [ "$DO_DB" -eq 1 ] || [ "$DO_HOME" -eq 1 ]; then
  # `up -d` y no `start`: vuelve a correr `init`, que revalida la key de la
  # web contra la base restaurada (si no está, emite otra).
  log "levantando la stack…"
  compose up -d
fi
log "restore OK"
