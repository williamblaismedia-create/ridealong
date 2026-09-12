#!/usr/bin/env bash
#
# Ridealong — tout-en-un LOCAL : Chrome + serveur MCP sur la machine que l'on
# pilote (pas de serveur distant, pas de tunnel). Lancé PAR Claude Code :
#   claude mcp add scry -- /chemin/vers/scry/scripts/ridealong-local.sh
#
# - démarre Google Chrome (ou Chromium) avec le port de debug CDP sur
#   127.0.0.1:9222 et un profil dédié dans $SCRY_DATA_DIR/profile, s'il n'y
#   en a pas déjà un ;
# - crée $SCRY_DATA_DIR/scry.env avec un secret aléatoire la première fois ;
# - exec le serveur. La vue live est sur http://127.0.0.1:9400 (ou sur le
#   LAN si SCRY_LIVE_PUBLIC_URL est défini) ; la vidéo H.264 utilise
#   l'encodeur disponible (NVENC, VideoToolbox sur Mac, sinon logiciel), ou
#   retombe sur les images JPEG si ffmpeg est absent.
#
# Rien n'est écrit sur stdout (c'est le canal JSON-RPC) ; diagnostics sur stderr.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRY_DATA_DIR="${RIDEALONG_DATA_DIR:-${SCRY_DATA_DIR:-$HOME/ridealong-data}}"
export SCRY_DATA_DIR
mkdir -p "$SCRY_DATA_DIR"
ENV_FILE="$SCRY_DATA_DIR/ridealong.env"; [ -f "$ENV_FILE" ] || [ ! -f "$SCRY_DATA_DIR/scry.env" ] || ENV_FILE="$SCRY_DATA_DIR/scry.env"
if [ ! -f "$ENV_FILE" ]; then
  secret="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
  printf 'SCRY_CDP_URL=http://127.0.0.1:9222\nSCRY_LIVE_PORT=9400\nSCRY_LIVE_SECRET=%s\n' "$secret" > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "ridealong-local: config creee dans $ENV_FILE" >&2
fi
set -a; . "$ENV_FILE"; set +a

CDP_PORT="${SCRY_CDP_URL##*:}"
if ! curl -s -m 2 "http://127.0.0.1:${CDP_PORT}/json/version" >/dev/null 2>&1; then
  CHROME="${SCRY_CHROME:-}"
  if [ -z "$CHROME" ]; then
    for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" google-chrome google-chrome-stable chromium chromium-browser; do
      if [ -x "$c" ] || command -v "$c" >/dev/null 2>&1; then CHROME="$c"; break; fi
    done
  fi
  [ -n "$CHROME" ] || { echo "ridealong-local: Chrome introuvable (definir SCRY_CHROME)" >&2; exit 127; }
  echo "ridealong-local: demarrage de Chrome ($CHROME) sur le port CDP $CDP_PORT" >&2
  nohup "$CHROME" --remote-debugging-port="$CDP_PORT" --remote-debugging-address=127.0.0.1 \
    --user-data-dir="$SCRY_DATA_DIR/profile" --no-first-run --no-default-browser-check \
    --window-size="${SCRY_VIEWPORT_WIDTH:-1440},${SCRY_VIEWPORT_HEIGHT:-900}" about:blank >/dev/null 2>&1 &
  for _ in $(seq 1 40); do curl -s -m 1 "http://127.0.0.1:${CDP_PORT}/json/version" >/dev/null 2>&1 && break; sleep 0.25; done
fi

NODE_BIN="${SCRY_NODE:-$(command -v node 2>/dev/null || true)}"
[ -x "$NODE_BIN" ] || { echo "ridealong-local: node introuvable" >&2; exit 127; }
[ -f "$HERE/dist/src/server.js" ] || { echo "ridealong-local: dist/ absent — lancer 'npm run build' dans $HERE" >&2; exit 1; }
exec "$NODE_BIN" "$HERE/dist/src/server.js"
