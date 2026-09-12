# Fiches pour les annuaires MCP (copier-coller)

**Nom** : Ridealong
**Une ligne** : A browser your AI drives. Ride along, grab the wheel anytime.
**Description (400 car.)** : Open-source MCP server for Claude Code that drives a real Google Chrome and streams it live (GPU-encoded H.264). Watch the agent, point at elements, pause, approve sensitive actions with `ask_approval`, or take the wheel from your phone in a no-capture Manual mode. For the agent: stable refs, diff, console errors, network requests, real tabs, cache bypass. Runs locally, in Docker, or on an always-on server. MIT.
**Catégories** : Browser automation · Human-in-the-loop · Developer tools · Testing
**Tags** : mcp, claude-code, browser, chrome, cdp, live-view, approval, human-in-the-loop, playwright-alternative
**Repo** : https://github.com/williamblaismedia-create/ridealong
**Site** : https://williamblaismedia-create.github.io/ridealong/
**npm** : ridealong-mcp
**Commande** : `claude mcp add ridealong -- ./scripts/ridealong-local.sh`
**Config JSON** :
```json
{ "mcpServers": { "ridealong": { "command": "bash", "args": ["/path/to/ridealong/scripts/ridealong-local.sh"] } } }
```
**Licence** : MIT · **Auteur** : William Blais, W Automatisations (Montréal)

## Où soumettre
- Smithery — https://smithery.ai (connexion GitHub, ajouter le dépôt)
- mcp.so — https://mcp.so/submit
- PulseMCP — https://www.pulsemcp.com/submit
- Glama — https://glama.ai/mcp/servers (ajout via GitHub)
- MCP Market — https://mcpmarket.com/submit
- Cursor Directory — https://cursor.directory/mcp (via PR ou formulaire)
- Registre officiel MCP — `mcp-publisher publish` (voir docs/launch/registre-mcp.md)
