# Contributing

Thanks for looking. Scry is small on purpose; keep it that way.

## Setup

```bash
npm ci && npm run build && npm test
```

Tests run against a real Chromium that Playwright downloads. `ffmpeg` on the
PATH enables the video tests (they skip cleanly without it).

## Rules that are not negotiable

- **No capture.** Nothing typed in Manual mode may be stored, logged, or made
  visible to Claude. `test/live-view.test.ts` inspects the LiveView's own
  state after a relayed keystroke; keep that test green and extend it if you
  add a code path that touches input.
- **Password fields never expose values** in snapshots (`src/refs.ts`).
- **stdout is the JSON-RPC channel.** Diagnostics go to stderr, always.
- The viewer page (`viewer/index.html`) has no build step and no external
  scripts. Keep it that way.

## Workflow

1. Write the failing test first (Vitest). Integration tests use
   `test/helpers.ts` (fixture page + Chromium).
2. Make it pass with the smallest change.
3. `npm test`, then a commit message that says what changed and why.

Server-side changes need a restart of the MCP session to take effect;
page-only changes take effect on reload. Say which in your PR.

## Where things live

| Path | What |
|---|---|
| `src/server.ts` | MCP tools and wiring |
| `src/driver.ts` | Chrome connection, target tab, viewport, cache bypass |
| `src/perception.ts` `src/refs.ts` | snapshots, refs, diff |
| `src/action.ts` | act/fill/scroll, target events for the cursor |
| `src/live-view.ts` | live view server: frames, video, input relay, approvals, inbox |
| `src/video.ts` | CDP screencast → ffmpeg → fragmented MP4 |
| `src/live-view-remote.ts` `src/live-view-slot.ts` | second session follows / promotes |
| `viewer/index.html` | the live view page |
| `scripts/` | launchers: local, relay, server, Docker |
