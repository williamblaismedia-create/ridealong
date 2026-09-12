# Reddit

## r/ClaudeAI (jour 1)

**Titre** : I built an MCP so I can watch Claude Code browse a real Chrome — and grab the wheel from my phone when it hits a login

**Corps** :
Claude Code is great at driving a browser until it isn't: a login page, a 2FA code, a "Pay now" button. I couldn't see what it saw, and I couldn't step in.

So I built Ridealong (MIT): an MCP server that drives a real Google Chrome and streams it live to a page on my Mac or phone. Claude's cursor moves with a ripple on click, there's a journal of every action, and:

- **Manual mode**: my clicks/keys/scroll go into the page. What I type is never stored or shown to Claude.
- **Approve / Deny**: Claude calls `ask_approval` before paying, sending, deleting. A card pops up on my phone, the tool waits.
- **Point & say**: I tap an element or type a line and Claude hears it.
- For Claude: `console_errors`, `network_requests`, real tabs, stable refs, `diff`, cache bypass so a freshly deployed site is what it tests.

Runs locally in one command (`claude mcp add ridealong -- ./scripts/ridealong-local.sh`), in Docker, or on a server with a tunnel. Video is H.264 encoded on the GPU if you have one, JPEG otherwise.

Repo + 20-second demo: https://github.com/williamblaismedia-create/ridealong
Site: https://williamblaismedia-create.github.io/ridealong/

Happy to answer anything about the no-capture design or the approval gate.

## r/LocalLLaMA (jour 2) — angle open source / self-hosted
**Titre** : Ridealong: self-hosted live view + takeover for an agent-driven Chrome (MCP, MIT, NVENC)
Corps : même contenu, insister sur Docker, NVENC, le relais SSH, aucun service tiers.

## r/webdev (jour 3) — angle test d'app déployée
**Titre** : Let an AI test your deployed app in a real Chrome while you watch — and see console errors in the transcript
Corps : le scénario console_errors + cache bypass + reprise manuelle pour le 2FA.
