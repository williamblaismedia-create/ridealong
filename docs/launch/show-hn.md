# Show HN (post + réponses préparées)

**Titre** (80 caractères max) :
Show HN: Ridealong – watch your AI browse a real Chrome, take the wheel from your phone

**URL** : https://github.com/williamblaismedia-create/ridealong

**Premier commentaire (poster immédiatement après)** :

Hi HN, I'm William. I build automations for small businesses in Montréal, and I spend my days letting Claude Code drive a browser: testing what I just deployed, logging into clients' tools, filling forms.

Every browser MCP I tried had the same blind spot: I couldn't see what the agent was doing, and when it hit a login, a 2FA prompt or a "Pay $49" button, my options were "hope" or "kill it".

Ridealong is an MCP server (stdio, MIT) that drives a real Google Chrome over CDP and streams it live to a web page: H.264 encoded on the GPU (NVENC / VideoToolbox / libx264), about 150 ms behind, or JPEG frames. On that page you can:

- watch Claude's cursor move and read a journal of every action;
- tap an element ("William points at: button « Login »") or type a one-line message — it lands in Claude's next tool result, or instantly via Claude Code channels;
- pause it;
- approve or deny when Claude calls `ask_approval` before a payment / send / delete;
- switch to Manual and type the password yourself. Nothing you type is stored, logged or visible to the model; Claude's perception tools refuse to run while you hold the wheel, and password fields never expose values in snapshots. There's a test that inspects the server's own state after a relayed keystroke.

For the agent: `snapshot`/`find` with stable refs (not selectors), `diff`, `console_errors`, `network_requests` with the session's cookies, real tabs with a moving target, and Chrome's cache/service workers bypassed so a freshly deployed site is what it sees.

It runs with one command on your machine, in Docker, or on an always-on server (I run it on a box with a 3060 Ti behind a Cloudflare tunnel, watching from my phone). Two Claude Code sessions on one Chrome share the view; a small relay keeps the MCP session alive when my laptop sleeps.

Things I'd love feedback on: the approval gate UX, whether the no-capture guarantee is convincing enough, and what other MCP clients you'd want this to work with.

**Réponses prêtes**

- *« Why not Playwright MCP? »* — Playwright MCP is great at acting. Ridealong is about the human: seeing, approving, taking over. It uses CDP directly on a real Chrome (codecs, extensions, profile), not headless Chromium.
- *« Isn't streaming my browser a security risk? »* — The link is HMAC-signed and expires (30 s–1 h), carried in the URL fragment so it never hits history or logs; the server binds to loopback unless you expose it; device tokens live only in your browser; rotate one secret to revoke everything. Manual-mode input is relayed and never retained.
- *« Latency? »* — ~150 ms on LAN with NVENC; the player hugs the live edge in Manual (0.15 s target). JPEG mode is lower latency still.
- *« Does it work with Cursor / other clients? »* — Tools yes (standard stdio MCP). The instant channel for messages/approvals is Claude Code specific; other clients get them at the end of the next tool result.
- *« Why a GPU? »* — You don't need one. ffmpeg picks NVENC, VideoToolbox or libx264; without ffmpeg it streams JPEG.
