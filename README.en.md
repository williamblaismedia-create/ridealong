# Scry

A browser driven by Claude that you can **watch live** and **take over** at
any time. Scry is a stdio MCP server that drives a real Google Chrome over
CDP, plus a **live view**: a web page with an H.264 stream (GPU-encoded) or
JPEG frames, Claude's cursor, an action journal, pause, an **approval gate**,
Manual mode (your clicks, keyboard and scrolling go into Chrome), tabs,
resolution picker, and a way to point at things or message Claude.

![demo](docs/demo.gif)

## Run it on the machine Claude drives (no infrastructure)

```
git clone <this repo> && cd scry && npm ci && npm run build
claude mcp add scry -- "$PWD/scripts/scry-local.sh"
```

The launcher starts Chrome with its debugging port, generates a secret in
`~/scry-donnees/scry.env` on first run, then starts the server. Ask Claude:
"open timeliner.io and give me the live view" -> a link
`http://127.0.0.1:9400/#token=...`. With `ffmpeg` installed you get H.264
video (NVENC, VideoToolbox on macOS, or software); without it, JPEG frames.
Once a device has opened one valid link, the bare address works for 30 days
(bookmark it, add it to your home screen).

## Run it on an always-on server

`docker build -t scry . && claude mcp add scry -- docker run -i --rm -p 9400:9400 -v scry-data:/data scry`
(Chrome under Xvfb, ffmpeg, persistent profile). A tunnel (Cloudflare) in
front of port 9400 and `SCRY_LIVE_PUBLIC_URL` give you the live view from your
phone. See `docs/DEPLOIEMENT-W-AGENT.md` (French) for the reference setup,
including the local relay that survives a dead SSH link.

## Tools

`navigate`, `reload`, `state`, `snapshot`, `find`, `read`, `diff`,
`screenshot`, `console_errors`, `act`, `fill`, `scroll`, `network_requests`,
`fetch_with_session`, `tabs_list`, `tabs_open`, `tabs_close`, `tabs_select`,
`live_start`, `live_mode`, `live_stop`, `ask_approval`, `inbox`.

Perception, action and the live view follow one **target tab** that
`tabs_select`/`tabs_open` move (or a tap on a tab in the live view).
`ask_approval` shows Approve / Deny on the viewer and waits. What you point
at or type in the viewer reaches Claude at the end of its next tool result.

## Guarantees

- **No capture**: in Manual mode nothing you type is stored, logged, or
  visible to Claude (its perception is suspended). Password fields never
  expose their value in snapshots.
- **Signed, expiring links** (HMAC, 30 s to 1 h) that never land in browser
  history or server logs; 30-day device tokens live only in your browser.
- Chrome's HTTP cache and service workers are bypassed on every target, so
  a site you just deployed is what Claude sees.

## Development

`npm test` (Vitest against a test Chromium; ffmpeg optional), `npm run build`.
CI runs the suite on every push.
