#!/usr/bin/env bash
# Claude Code status line: claude-pulse as before, plus the Scry live link
# while a scry MCP session is up (marker written by scripts/scry-mcp-relay.mjs).
input="$(cat)"
printf '%s' "$input" | cat >/dev/null # (remplacer par votre statusline existante si vous en avez une)
alive=0
if [ -f "$HOME/.claude/scry-live.json" ]; then
  pid="$(python3 -c 'import json,os; print(json.load(open(os.path.expanduser("~/.claude/scry-live.json"))).get("pid",0))' 2>/dev/null || echo 0)"
  [ "$pid" -gt 0 ] 2>/dev/null && kill -0 "$pid" 2>/dev/null && alive=1
fi
if [ "$alive" = 1 ]; then
  url="$(python3 -c 'import json,os; print(json.load(open(os.path.expanduser("~/.claude/scry-statusline.json"))).get("url","http://127.0.0.1:9400"))' 2>/dev/null || echo http://127.0.0.1:9400)"
  printf '\n\033[38;2;218;119;86m\xe2\x97\x89\033[0m Scry \xc2\xb7 %s' "$url"
fi
