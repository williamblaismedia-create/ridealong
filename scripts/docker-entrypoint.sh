#!/usr/bin/env bash
# Conteneur Scry : Xvfb + Chrome (profil persistant dans /data), puis le serveur MCP sur stdio.
# Rien sur stdout sauf le JSON-RPC.
set -euo pipefail
mkdir -p "$SCRY_DATA_DIR/profile"
if [ ! -f "$SCRY_DATA_DIR/scry.env" ]; then
  printf 'SCRY_LIVE_SECRET=%s\n' "$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')" > "$SCRY_DATA_DIR/scry.env"
  echo "scry: secret genere dans $SCRY_DATA_DIR/scry.env" >&2
fi
set -a; . "$SCRY_DATA_DIR/scry.env"; set +a
Xvfb "$DISPLAY" -screen 0 "${SCRY_VIEWPORT_WIDTH}x${SCRY_VIEWPORT_HEIGHT}x24" -nolisten tcp >/dev/null 2>&1 &
for _ in $(seq 1 40); do [ -S "/tmp/.X11-unix/X${DISPLAY#:}" ] && break; sleep 0.1; done
google-chrome --no-sandbox --disable-dev-shm-usage --user-data-dir="$SCRY_DATA_DIR/profile" --password-store=basic \
  --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 --no-first-run --no-default-browser-check \
  --disable-features=Translate --window-size="${SCRY_VIEWPORT_WIDTH},${SCRY_VIEWPORT_HEIGHT}" about:blank >/dev/null 2>&1 &
for _ in $(seq 1 80); do curl -s -m 1 http://127.0.0.1:9222/json/version >/dev/null 2>&1 && break; sleep 0.25; done
# La vue live doit écouter sur toutes les interfaces du conteneur pour être publiée (-p 9400:9400).
export SCRY_LIVE_BIND=0.0.0.0
exec node /app/dist/src/server.js
