#!/usr/bin/env bash
# Prueba de restore — PU-RUN-006. NO toca la stack.
#
#   deploy/backup/test-restore.sh [snapshot]      (default: el daily más nuevo)
#
# 1. Levanta un Postgres TEMPORAL (misma imagen que la stack, sin puertos,
#    contraseña efímera) y le aplica globals.sql + db.dump.
# 2. Cuenta las filas de cada tabla en la base restaurada y las compara con
#    counts.tsv (lo que había al hacer el backup) y, si la stack está arriba,
#    con la base viva.
# 3. Compara el espejo del bucket con bucket-manifest.tsv (clave y tamaño).
# 4. Borra el Postgres temporal. Sale con 1 si algo no coincide.
#
# Una diferencia contra la base VIVA no es por sí sola un error (hubo
# escrituras después del backup): se informa. Contra counts.tsv sí lo es.

# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

BACKUP_DIR="$(env_get BACKUP_DIR /var/backups/fastgram)"
SNAP="${1:-}"
if [ -z "$SNAP" ]; then
  SNAP="$(ls -1d "$BACKUP_DIR"/daily/* 2>/dev/null | grep -v '\.partial$' | sort | tail -n 1)"
fi
[ -n "$SNAP" ] && [ -d "$SNAP" ] || die "no hay snapshot (BACKUP_DIR=$BACKUP_DIR)"
log "snapshot: $SNAP"

NAME="fastgram-restore-test-$$"
PASS="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

log "Postgres temporal $NAME ($PG_IMAGE)…"
docker run -d --name "$NAME" -e POSTGRES_USER=fastgram -e POSTGRES_PASSWORD="$PASS" \
  -e POSTGRES_DB=fastgram "$PG_IMAGE" >/dev/null
for _ in $(seq 1 60); do
  # pg_isready contra TCP: el entrypoint de la imagen arranca un server
  # temporal por socket antes del definitivo, y ese «listo» engaña.
  if docker exec "$NAME" pg_isready -h 127.0.0.1 -U fastgram -d fastgram >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$NAME" pg_isready -h 127.0.0.1 -U fastgram -d fastgram >/dev/null || die "el Postgres temporal no arrancó"

psql_tmp() { docker exec -i "$NAME" psql -h 127.0.0.1 -U fastgram "$@"; }

log "globals.sql (roles; 'already exists' del superusuario es esperado)…"
psql_tmp -d postgres -q <"$SNAP/globals.sql" >/dev/null 2>&1 || true
log "pg_restore…"
start=$(date +%s)
docker exec -i "$NAME" pg_restore -h 127.0.0.1 -U fastgram -d fastgram --exit-on-error <"$SNAP/db.dump"
log "  restaurado en $(($(date +%s) - start)) s"

RESTORED="$(mktemp)"
LIVE="$(mktemp)"
trap 'cleanup; rm -f "$RESTORED" "$LIVE"' EXIT
psql_tmp -d fastgram -At -F $'\t' -c "$COUNTS_SQL" >"$RESTORED"

have_live=0
if compose ps --status running --services 2>/dev/null | grep -qx postgres; then
  compose exec -T postgres psql -U fastgram -d fastgram -At -F $'\t' -c "$COUNTS_SQL" >"$LIVE"
  have_live=1
fi

fail=0
printf '\n%-52s %10s %10s %10s\n' "tabla" "backup" "restaur." "viva"
while IFS=$'\t' read -r table expected; do
  got="$(awk -F'\t' -v t="$table" '$1 == t { print $2 }' "$RESTORED")"
  live="-"
  [ "$have_live" -eq 1 ] && live="$(awk -F'\t' -v t="$table" '$1 == t { print $2 }' "$LIVE")"
  mark=""
  if [ "$got" != "$expected" ]; then
    mark="  ✗"
    fail=1
  elif [ "$have_live" -eq 1 ] && [ "$live" != "$expected" ]; then
    mark="  (cambió después del backup)"
  fi
  # Sólo las tablas con filas, más las que fallan: 60 líneas de ceros no dicen nada.
  if [ "$expected" != "0" ] || [ -n "$mark" ]; then
    printf '%-52s %10s %10s %10s%s\n' "$table" "$expected" "${got:-FALTA}" "${live:-?}" "$mark"
  fi
done <"$SNAP/counts.tsv"
tables="$(wc -l <"$SNAP/counts.tsv" | tr -d ' ')"
restored_tables="$(wc -l <"$RESTORED" | tr -d ' ')"
rows="$(awk -F'\t' '{ s += $2 } END { print s }' "$SNAP/counts.tsv")"
printf '\ntablas: %s en el backup, %s restauradas; filas: %s\n' "$tables" "$restored_tables" "$rows"
[ "$tables" = "$restored_tables" ] || {
  echo "✗ distinto número de tablas"
  fail=1
}

# ── Bucket ─────────────────────────────────────────────────────────────────
if [ -f "$SNAP/bucket-manifest.tsv" ]; then
  missing=0
  checked=0
  while IFS=$'\t' read -r key size; do
    checked=$((checked + 1))
    f="$BACKUP_DIR/bucket/$key"
    if [ ! -f "$f" ]; then
      echo "✗ falta en el espejo: $key"
      missing=$((missing + 1))
    elif [ "$(wc -c <"$f" | tr -d ' ')" != "$size" ]; then
      echo "✗ tamaño distinto: $key"
      missing=$((missing + 1))
    fi
  done <"$SNAP/bucket-manifest.tsv"
  printf 'bucket: %s objetos en el manifiesto, %s con problemas\n' "$checked" "$missing"
  [ "$missing" -eq 0 ] || fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "RESTORE: FALLÓ"
  exit 1
fi
echo "RESTORE: OK"
