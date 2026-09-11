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
# SCRY_DATA_DIR, SCRY_LIVE_PORT, SCRY_LIVE_SECRET).
ENV_FILE="${SCRY_ENV_FILE:-${HOME}/scry-donnees/scry.env}"
if [ -f "${ENV_FILE}" ]; then
  set -a
  # shellcheck disable=SC1090
  . "${ENV_FILE}"
  set +a
else
  echo "scry-mcp: env file not found at ${ENV_FILE}" >&2
fi

exec /usr/bin/node "${HOME}/scry/dist/src/server.js"
