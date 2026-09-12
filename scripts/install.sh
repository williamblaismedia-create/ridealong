#!/usr/bin/env bash
# Installation locale en une commande :
#   curl -fsSL https://raw.githubusercontent.com/williamblaismedia-create/ridealong/main/scripts/install.sh | bash
# Clone dans ~/scry, construit, et branche Claude Code sur le lanceur local.
set -euo pipefail
DIR="${RIDEALONG_HOME:-$HOME/ridealong}"
REPO="${SCRY_REPO:-https://github.com/williamblaismedia-create/scry.git}"
command -v node >/dev/null || { echo "node >= 20 requis"; exit 1; }
command -v claude >/dev/null || { echo "Claude Code (claude) requis"; exit 1; }
if [ -d "$DIR/.git" ]; then git -C "$DIR" pull --quiet; else git clone --quiet "$REPO" "$DIR"; fi
cd "$DIR" && npm ci --silent && npm run build --silent
claude mcp remove ridealong >/dev/null 2>&1; claude mcp add ridealong -- "$DIR/scripts/ridealong-local.sh"
echo "Ridealong installe. Dans Claude : « ouvre example.com et donne-moi la vue live »."
command -v ffmpeg >/dev/null || echo "(ffmpeg absent : la vue live sera en images JPEG ; installez-le pour la video H.264)"
