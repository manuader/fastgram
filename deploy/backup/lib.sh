# shellcheck shell=bash
# Funciones comunes de deploy/backup/*.sh — PU-RUN-006. No se ejecuta solo.
#
# Todo corre en el HOST del VPS con `docker` y `docker compose`: no hace falta
# instalar pg_dump ni mc en el host, se usan las imágenes de la stack.

set -euo pipefail

BACKUP_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "$BACKUP_LIB_DIR/.." && pwd)"

# Mismas imágenes (y tags) que deploy/compose.vps.yml.
PG_IMAGE="pgvector/pgvector:0.8.6-pg17-bookworm"
MC_IMAGE="quay.io/minio/mc:RELEASE.2025-08-13T08-35-41Z"

ENV_FILE="${ENV_FILE:-$DEPLOY_DIR/.env}"
COMPOSE_FILE="${COMPOSE_FILE:-$DEPLOY_DIR/compose.vps.yml}"
# El `name:` del compose. Pisable con -p en compose → acá con PROJECT.
PROJECT="${PROJECT:-fastgram-vps}"

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

# Lee KEY del .env SIN ejecutarlo (`source` ejecutaría el archivo, y un valor
# con espacios o paréntesis lo rompe). Lo exportado en el entorno gana.
env_get() {
  local key="$1" default="${2:-}" value=""
  if [ -n "${!key:-}" ]; then
    printf '%s' "${!key}"
    return
  fi
  if [ -r "$ENV_FILE" ]; then
    value="$(sed -n "s/^${key}=//p" "$ENV_FILE" | tail -n 1)"
    # Comillas envolventes opcionales, como las acepta Compose.
    value="${value%\"}"
    value="${value#\"}"
  fi
  printf '%s' "${value:-$default}"
}

compose() {
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" -p "$PROJECT" "$@"
}

volume_name() { printf '%s_%s' "$PROJECT" "$1"; }
network_name() { printf '%s_default' "$PROJECT"; }

# `http://host:9000` + user + pass → `http://user:pass@host:9000` (formato
# MC_HOST_<alias> de mc). Las credenciales tienen que ser URL-safe: el
# .env.vps.example las pide en hex.
mc_host_url() {
  local endpoint="$1" user="$2" pass="$3"
  local scheme="${endpoint%%://*}" rest="${endpoint#*://}"
  printf '%s://%s:%s@%s' "$scheme" "$user" "$pass" "${rest%/}"
}

# Conteo exacto de filas de cada tabla (todas las del usuario: public, pgboss,
# drizzle). Como superusuario: RLS no filtra. Salida: `esquema.tabla<TAB>n`.
COUNTS_SQL="select n.nspname || '.' || c.relname,
       (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', n.nspname, c.relname), false, true, '')))[1]::text::bigint
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where c.relkind in ('r', 'p')
   and n.nspname not in ('pg_catalog', 'information_schema')
   and n.nspname not like 'pg_toast%'
 order by 1;"

# Copia de un árbol con hardlinks (los snapshots son inmutables, así que
# comparten bloques sin riesgo). macOS no tiene `cp -l`: copia normal.
link_copy() {
  local src="$1" dst="$2"
  if cp -al "$src" "$dst" 2>/dev/null; then return; fi
  rm -rf "$dst"
  cp -pR "$src" "$dst"
}
