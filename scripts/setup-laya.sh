#!/usr/bin/env bash
# Instala Laya (motor de juicio local, D-18) en $FASTGRAM_HOME/laya (default
# ~/.fastgram/laya). Sprint 9, agente O.
#
# Idempotente: si el venv y `laya-serve` ya están, no reinstala nada (uv no
# toca lo que ya satisface la versión pedida). Es exactamente lo que hizo el
# coordinador a mano el 2026-09-28:
#
#   uv venv --python 3.12 && uv pip install "laya[serve]"
#
# con la versión fijada a la que se verificó (0.3.21, torch 2.14, MPS en la
# Mac). Para otra: LAYA_VERSION=x.y.z scripts/setup-laya.sh
#
# Después: `pnpm start` lo levanta solo en 127.0.0.1:3006 (ver
# scripts/lib/laya.mjs), y en Settings → Models se elige «Laya» para el juicio.
#
# Uso:
#   scripts/setup-laya.sh           instala o confirma que está
#   scripts/setup-laya.sh --check   sólo dice qué hay, no instala nada
set -euo pipefail

LAYA_VERSION="${LAYA_VERSION:-0.3.21}"
HOME_DIR="${FASTGRAM_HOME:-$HOME/.fastgram}"
DIR="$HOME_DIR/laya"
VENV="$DIR/.venv"
BIN="$VENV/bin/laya-serve"
PY="$VENV/bin/python"

installed_version() {
  # `importlib.metadata` no importa torch: es instantáneo y no toca la GPU.
  "$PY" -c 'import importlib.metadata as m; print(m.version("laya"))' 2>/dev/null || true
}

if [[ "${1:-}" == "--check" ]]; then
  if [[ -x "$BIN" ]]; then
    echo "laya: instalado en $DIR (versión $(installed_version))"
    exit 0
  fi
  echo "laya: no instalado (correr scripts/setup-laya.sh)"
  exit 1
fi

if ! command -v uv >/dev/null 2>&1; then
  echo "falta uv (https://docs.astral.sh/uv/). En la Mac: brew install uv" >&2
  exit 1
fi

mkdir -p "$DIR"
cd "$DIR"

if [[ ! -x "$PY" ]]; then
  echo "▸ creando el venv (Python 3.12) en $VENV"
  uv venv --python 3.12 "$VENV"
fi

current="$(installed_version)"
if [[ -x "$BIN" && "$current" == "$LAYA_VERSION" ]]; then
  echo "laya $current ya está en $DIR: nada que hacer"
  exit 0
fi

echo "▸ instalando laya[serve]==$LAYA_VERSION (torch incluido: la primera vez tarda)"
uv pip install --python "$PY" "laya[serve]==$LAYA_VERSION"

if [[ ! -x "$BIN" ]]; then
  echo "se instaló laya pero no apareció $BIN" >&2
  exit 1
fi
echo "listo: laya $(installed_version) en $DIR"
echo "pnpm start lo levanta en 127.0.0.1:3006; elegilo en Settings → Models (Judgment)."
