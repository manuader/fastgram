#!/bin/sh
# Entrypoint común de las imágenes de FastGram (deploy/). PU-RUN-004.
#
# Convención `<VAR>_FILE`: si `<VAR>` está vacía y `<VAR>_FILE` apunta a un
# archivo, se exporta `<VAR>` con su contenido. Así los secretos que genera el
# contenedor `init` (secreto de render, key de la web) llegan al proceso por su
# entorno sin pasar por el `.env` ni por `docker inspect`.
#
# Sólo las variables de esta lista: un `_FILE` arbitrario sería una forma de
# leer cualquier archivo del contenedor a una variable.
set -eu

for var in RENDER_MEDIA_GRANT_SECRET FASTGRAM_API_KEY; do
  eval "current=\${$var:-}"
  eval "file=\${${var}_FILE:-}"
  if [ -z "$current" ] && [ -n "$file" ]; then
    if [ ! -r "$file" ]; then
      echo "entrypoint: ${var}_FILE=$file no existe o no se puede leer (¿corrió el contenedor init?)" >&2
      exit 1
    fi
    value=$(cat "$file")
    if [ -z "$value" ]; then
      echo "entrypoint: $file está vacío" >&2
      exit 1
    fi
    export "$var=$value"
  fi
  unset "${var}_FILE" 2>/dev/null || true
done
unset current file value 2>/dev/null || true

exec "$@"
