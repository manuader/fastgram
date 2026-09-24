#!/usr/bin/env bash
# Actualizar FastGram en el VPS con vuelta atrás — P1-INFRA-005.
#
#   deploy/update.sh            (desde la raíz del repo, con la stack arriba)
#
# Orden, y por qué:
#   1. Backup (deploy/backup/backup.sh). Las migraciones son sólo hacia
#      adelante: volver a una imagen vieja sobre una base migrada puede no
#      andar, así que el backup de justo antes es la mitad del rollback.
#   2. Anota la versión que está corriendo (tag de imagen + commit) en
#      deploy/.releases, la lista que usa rollback.sh.
#   3. Construye con FASTGRAM_IMAGE_TAG = commit nuevo. Las imágenes viejas
#      quedan en el host con su tag: volver no exige recompilar.
#   4. `up -d --wait`: si algún servicio no llega a healthy, avisa cómo volver.
#
# Nada de esto se ejecutó contra un VPS real (se probó la sintaxis y la lógica
# de tags en local); ver deploy/README.md §5.

# shellcheck source=backup/lib.sh
. "$(dirname "$0")/backup/lib.sh"

RELEASES="$DEPLOY_DIR/.releases"
cd "$DEPLOY_DIR/.."

current_tag="$(env_get FASTGRAM_IMAGE_TAG local)"
new_tag="$(git rev-parse --short=12 HEAD)"

[ "$current_tag" = "$new_tag" ] && die "ya está corriendo $new_tag; hacé git pull primero"

log "backup antes de actualizar"
"$DEPLOY_DIR/backup/backup.sh"
backup_path="$(ls -1dt "$(env_get BACKUP_DIR /var/backups/fastgram)"/daily/*/ 2>/dev/null | grep -v '\.partial' | head -n 1)"

log "versión actual: $current_tag → nueva: $new_tag"
printf '%s\t%s\t%s\n' "$(date -u +%FT%TZ)" "$current_tag" "${backup_path%/}" >>"$RELEASES"

set_tag() {
  if grep -q '^FASTGRAM_IMAGE_TAG=' "$ENV_FILE"; then
    sed -i.bak "s/^FASTGRAM_IMAGE_TAG=.*/FASTGRAM_IMAGE_TAG=$1/" "$ENV_FILE" && rm -f "$ENV_FILE.bak"
  else
    printf '\nFASTGRAM_IMAGE_TAG=%s\n' "$1" >>"$ENV_FILE"
  fi
}

set_tag "$new_tag"
export FASTGRAM_IMAGE_TAG="$new_tag"
if compose up -d --build --wait; then
  log "listo: $new_tag corriendo"
else
  printf '\nLa versión %s no quedó sana. Para volver a %s:\n' "$new_tag" "$current_tag" >&2
  printf '  deploy/rollback.sh            # imagen anterior, sin tocar la base\n' >&2
  printf '  deploy/rollback.sh --restore  # además restaura la base del backup %s\n' "${backup_path%/}" >&2
  exit 1
fi
