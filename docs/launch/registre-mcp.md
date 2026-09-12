# Publier dans le registre officiel MCP et comme plugin Claude Code

## A. npm (une fois, interactif)
```
npm login                 # compte npm de William
npm publish --access public
```
Le paquet `ridealong-mcp` porte déjà `mcpName: io.github.williamblaismedia-create/ridealong`,
que le registre vérifie contre npm.

## B. Registre officiel MCP
```
curl -L "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_$(uname -s | tr '[:upper:]' '[:lower:]')_$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/').tar.gz" | tar xz mcp-publisher && mkdir -p ~/.local/bin && mv mcp-publisher ~/.local/bin/
~/.local/bin/mcp-publisher login github      # ouvre un code d'appareil GitHub
~/.local/bin/mcp-publisher publish           # lit server.json à la racine
```
Mise à jour : nouvelle version npm, même numéro dans `package.json` et `server.json`, puis `publish` à nouveau.
Le serveur apparaît sur https://registry.modelcontextprotocol.io et dans les clients qui le lisent.

## C. Plugin Claude Code (déjà dans le dépôt)
Les utilisateurs font :
```
claude plugin marketplace add williamblaismedia-create/ridealong
claude plugin install ridealong@ridealong
```
Le plugin lance `npx -y -p ridealong-mcp ridealong`, donc il dépend de l'étape A.
La marketplace officielle d'Anthropic (`claude-plugins-official`) est curée sans formulaire ;
la marketplace communautaire `anthropics/claude-plugins-community` accepte les soumissions
par PR avec vérification automatique : à faire après A.

## D. Connecteurs claude.ai
Réservés aux serveurs distants HTTP. Un serveur stdio n'y est pas admissible ; la voie
pour Claude Desktop reste `claude_desktop_config.json` (ou le registre).
