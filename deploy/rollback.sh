#!/usr/bin/env bash
# Volver a la versión anterior en el VPS — P1-INFRA-005.
#
#   deploy/rollback.sh              imagen anterior, misma base
#   deploy/rollback.sh --restore    imagen anterior + restaura la base del
#                                   backup que update.sh hizo justo antes
#
# Usa la última línea de deploy/.releases (la escribe update.sh). Sin
# --restore sólo cambia de imagen: sirve si la versión nueva no migró nada, o
# si sus migraciones son compatibles hacia atrás. Si la vieja falla contra la
# base migrada, repetí con --restore (pierde lo escrito desde el backup).

# shellcheck source=backup/lib.sh
. "$(dirname "$0")/backup/lib.sh"

RELEASES="$DEPLOY_DIR/.releases"
[ -s "$RELEASES" ] || die "no hay versiones anteriores en $RELEASES (¿se actualizó con update.sh?)"

line="$(tail -n 1 "$RELEASES")"
prev_tag="$(printf '%s' "$line" | cut -f2)"
backup_path="$(printf '%s' "$line" | cut -f3)"

docker image inspect "fastgram/api:$prev_tag" >/dev/null 2>&1 ||
  die "no está la imagen fastgram/api:$prev_tag en este host"

if grep -q '^FASTGRAM_IMAGE_TAG=' "$ENV_FILE"; then
  sed -i.bak "s/^FASTGRAM_IMAGE_TAG=.*/FASTGRAM_IMAGE_TAG=$prev_tag/" "$ENV_FILE" && rm -f "$ENV_FILE.bak"
else
  printf '\nFASTGRAM_IMAGE_TAG=%s\n' "$prev_tag" >>"$ENV_FILE"
fi
export FASTGRAM_IMAGE_TAG="$prev_tag"

if [ "${1:-}" = "--restore" ]; then
  [ -n "$backup_path" ] && [ -d "$backup_path" ] || die "no encuentro el backup $backup_path"
  log "restaurando la base desde $backup_path"
  "$DEPLOY_DIR/backup/restore.sh" "$backup_path" --db --yes
fi

log "volviendo a $prev_tag"
compose up -d --no-build --wait
# La línea usada sale de la lista: un segundo rollback vuelve una más atrás.
sed -i.bak '$d' "$RELEASES" && rm -f "$RELEASES.bak"
log "listo: $prev_tag corriendo"
