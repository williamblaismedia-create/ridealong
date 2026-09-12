#!/usr/bin/env bash
#
# Scry — MCP server launcher (stdio transport).
#
# The Scry MCP server speaks the MCP protocol over STDIO to ONE client
# (a Claude Code session), per spec §5.2. It is therefore launched BY
# that client, once per session — NEVER run as an always-on daemon: a
# stdio server with no client on its stdin would idle forever or, under
# systemd Restart=always, crash-loop. The only always-on process is
# Chrome (scry-chrome.service). This server — and the live view it opens
# on demand via live_start — live only for the duration of a session.
#
# Spec §5.9 (remote access): Claude reaches w-agent by SSH keys OR a
# remote Claude Code session. Two launch paths, both sourcing the secret
# ON w-agent so it never lands on the Mac — see docs/DEPLOIEMENT-W-AGENT.md
# and scripts/scry-mcp-client.example.json:
#   - Claude Code running ON w-agent:        command = this script
#   - Claude Code on the Mac / iPhone (SSH):  command = ssh, args = w-agent + this script
#
# IMPORTANT: this script must print NOTHING to stdout — stdout is the
# JSON-RPC channel. All diagnostics below go to stderr.
set -euo pipefail

# Config + secret from outside git / outside ~/projets. `set -a` exports
# every assignment so the node process inherits them (SCRY_CDP_URL,
# SCRY_DATA_DIR, SCRY_LIVE_PORT, SCRY_LIVE_SECRET, SCRY_LIVE_PUBLIC_URL, SCRY_LIVE_QUALITY).
ENV_FILE="${SCRY_ENV_FILE:-${HOME}/scry-donnees/scry.env}"
if [ -f "${ENV_FILE}" ]; then
  set -a
  # shellcheck disable=SC1090
  . "${ENV_FILE}"
  set +a
else
  echo "scry-mcp: env file not found at ${ENV_FILE}" >&2
fi

# Warn LOUDLY (stderr, never stdout) if the live-view secret is missing or
# still the CHANGE_ME placeholder. We do NOT exit: perception/action work
# without it. But config.ts treats such a value as unset, so the live view
# and its tools stay OFF until a real secret (openssl rand -hex 32) is set —
# the HMAC is never keyed on a guessable literal (N3).
case "${SCRY_LIVE_SECRET:-}" in
  "" | CHANGE_ME)
    echo "scry-mcp: SCRY_LIVE_SECRET absent ou laisse a CHANGE_ME dans ${ENV_FILE} — vue live DESACTIVEE. Generez-en un (openssl rand -hex 32) pour l'activer." >&2
    ;;
esac

# Resolve the node binary robustly. w-agent has no /usr/bin/node; node lives
# at ~/.local/node/bin/node (v22) and is normally on PATH via ~/.bashrc. Order:
#   1. explicit SCRY_NODE override (documented escape hatch),
#   2. whatever `node` resolves to on PATH,
#   3. the known ~/.local/node install,
# then fail LOUDLY on stderr (never stdout — that is the JSON-RPC channel) so
# the failure is visible at `initialize` instead of a silent non-start.
NODE_BIN="${SCRY_NODE:-$(command -v node 2>/dev/null || true)}"
[ -x "${NODE_BIN}" ] || NODE_BIN="${HOME}/.local/node/bin/node"
[ -x "${NODE_BIN}" ] || { echo "scry-mcp: node introuvable (essayez SCRY_NODE=/chemin/vers/node)" >&2; exit 127; }

exec "${NODE_BIN}" "${HOME}/scry/dist/src/server.js"
