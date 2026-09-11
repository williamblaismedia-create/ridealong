# Scry — Hébergement, vue live, accès distant (Plan B) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement the code tasks (1–4). Tasks 5–7 are w-agent deployment: files + a runbook, executed WITH William on w-agent (they need Xvfb/Chrome/tunnel and William's login — not locally verifiable). Steps use checkbox (`- [ ]`) syntax.

**Goal:** Turn the Scry core (an MCP server that drives a Chrome over CDP) into an always-on service on w-agent that William can watch and drive from anywhere, iPhone included, and log into himself when a site asks.

**Architecture:** The core (`src/*` on `main`) stays untouched as the perception/action brain. Plan B adds: multi-tab tools and transient-error resilience to the driver (pure code, locally testable); a live-view sidecar that streams Chrome's screen over a websocket to a minimal, token-gated web page with a read-only mode and a hand-the-wheel input-relay mode; and the w-agent hosting (always-on Chrome under Xvfb with a persistent profile, systemd units, a Cloudflare-tunnel route for the live link). The last mile — deploying on w-agent and William's own Google/Timeliner login via hand-the-wheel — is collaborative, not autonomous.

**Tech Stack:** Node ≥ 20, TypeScript ESM, Playwright, `@modelcontextprotocol/sdk`, `ws` (websocket), CDP `Page.startScreencast`/`Input.*`, vitest; Xvfb + Google Chrome + systemd + cloudflared on w-agent.

**Spec:** `docs/specs/2026-09-11-scry-design.md` (§5.1 chrome-host, §5.8 live-view + passe-la-main, §5.9 remote-access, §10 security).

## Global Constraints

- **Session, jamais mot de passe.** Login happens only via hand-the-wheel (William drives the live view directly); the tool never reads or types a password, and MUST NOT capture input while in input mode. (Spec §2, §9, §5.8)
- **Le lien de vue live est authentifié, à jeton expirant, derrière le tunnel.** Never public — it shows William's logged-in browser. (Spec §5.8, §10)
- **Port CDP local seulement**, données et profil hors dépôt sous `~/scry-donnees`. (Spec §10)
- **Le cœur ne régresse pas :** the 35 existing tests stay green; new work is additive.
- **TypeScript ESM, Node 20.**

---

## File Structure (additions)

```
scry/
  src/
    driver.ts            # MODIFY: add withRetry + tabs (list/open/close/select)
    tabs.ts              # NEW: multi-tab operations over the driver's context
    live-view.ts         # NEW: screencast server (ws), token gen/verify, read/input modes
    server.ts            # MODIFY: register tabs_* tools + live_* tools
  test/
    tabs.test.ts
    retry.test.ts
    live-view.test.ts
  scripts/
    launch-chrome.sh     # NEW: Xvfb + Google Chrome, persistent profile, local CDP
    scry-chrome.service  # NEW: systemd user unit for the Chrome host
    scry-server.service  # NEW: systemd user unit for the MCP + live-view server
    cloudflared-scry.yml # NEW: tunnel route snippet for the live link (documented)
  docs/
    DEPLOIEMENT-W-AGENT.md  # NEW: the runbook (deploy + login acceptance)
```

---

## Task 1: Transient-error retry in the driver

**Files:** Modify `src/driver.ts`; Test `test/retry.test.ts`.

**Interfaces:**
- Produces: an internal `withRetry<T>(fn: () => Promise<T>, opts?: { tries?: number; baseMs?: number }): Promise<T>` that retries on transient CDP/Playwright errors (message matching `/Target closed|renderer|timeout|detached|not attached/i`), with exponential back-off, rethrowing the last error after `tries` (default 3). Wrap `navigate`, `evaluate`, and `screenshot` bodies in it.

- [ ] **Step 1: Write the failing test** — a fake fn that throws a transient error twice then succeeds resolves; a fn that always throws a non-transient error rethrows immediately.

```typescript
import { describe, it, expect } from 'vitest';
import { withRetry } from '../src/driver.js';

describe('withRetry', () => {
  it('retries a transient failure then succeeds', async () => {
    let n = 0;
    const r = await withRetry(async () => { if (n++ < 2) throw new Error('Target closed'); return 'ok'; }, { tries: 3, baseMs: 1 });
    expect(r).toBe('ok');
    expect(n).toBe(3);
  });
  it('rethrows a non-transient error without retrying', async () => {
    let n = 0;
    await expect(withRetry(async () => { n++; throw new Error('boom logic'); }, { tries: 3, baseMs: 1 })).rejects.toThrow('boom logic');
    expect(n).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify fail** — `npm test -- retry` → FAIL (no export).
- [ ] **Step 3: Implement** `export async function withRetry` in `src/driver.ts` (exported), and wrap `navigate`/`evaluate`/`screenshot` internals with it. Transient matcher: `/Target closed|renderer|timeout|detached|not attached|Session closed/i` on `String(err?.message)`.
- [ ] **Step 4: Run** `npm test` → all green (retry + unchanged suite).
- [ ] **Step 5: Commit** `feat(driver): withRetry on transient CDP errors`.

---

## Task 2: Multi-tab tools

**Files:** Create `src/tabs.ts`; Modify `src/server.ts`; Test `test/tabs.test.ts`.

**Interfaces:**
- Produces: `class Tabs { constructor(driver: Driver); list(): Promise<{ id: number; url: string; title: string; active: boolean }[]>; open(url: string): Promise<number>; close(id: number): Promise<void>; select(id: number): Promise<void> }` over the driver's Playwright `context.pages()`; `id` is the page's index in `context.pages()` at call time. Server registers `tabs_list`, `tabs_open`, `tabs_close`, `tabs_select` (Spec §7).
- Consumes: `Driver` (needs a `context()` accessor — add `Driver.context()` returning `this._page.context()`).

- [ ] **Step 1: Write the failing test** (drives the real browser harness): open a second tab to the fixture, `list()` shows 2, `select(0)` then `list()[0].active` is true, `close(1)` leaves 1.
- [ ] **Step 2: Run to verify fail.**
- [ ] **Step 3: Implement** `Driver.context()`, `src/tabs.ts`, and register the four tools in `src/server.ts` (wire `new Tabs(perception.driver)`; `main()` too). `tabs_select` must also repoint the driver's active page if the core needs it — for v1, `select` calls `page.bringToFront()` and returns the state; document that the driver's `_page` stays the primary unless a later task rebinds it.
- [ ] **Step 4: Run** `npm test` → green.
- [ ] **Step 5: Commit** `feat(tabs): multi-tab list/open/close/select + tools`.

> Note: rebinding the driver's primary page on `select` is a design change to the core; keep it out of v1 (document the limitation) unless the acceptance run needs it.

---

## Task 3: Live-view server — read-only screencast

**Files:** Create `src/live-view.ts`; Test `test/live-view.test.ts`. Add `ws` to dependencies.

**Interfaces:**
- Produces: `class LiveView { constructor(driver: Driver, opts: { secret: string }); start(port: number): Promise<{ url: (ttlSec?: number) => string }>; stop(): Promise<void> }`. It: (a) opens a websocket server; (b) on a client connecting with a valid, unexpired token (HMAC of an expiry timestamp with `secret`, in the query string), attaches CDP `Page.startScreencast` and forwards each frame (base64 JPEG) as a ws message; (c) `url(ttlSec)` mints `http://…/?token=<exp>.<hmac>`. Read-only in this task (no input).
- Consumes: `Driver` — add `Driver.cdpSession(): Promise<CDPSession>` (`this._page.context().newCDPSession(this._page)`).

- [ ] **Step 1: Write the failing test** — unit-test the token: `mintToken(secret, ttl)` then `verifyToken(secret, token)` is true; a token with a past expiry verifies false; a tampered token verifies false. (Pure, no browser.)
- [ ] **Step 2: Run to verify fail.**
- [ ] **Step 3: Implement** `src/live-view.ts` with exported pure `mintToken`/`verifyToken` (HMAC-SHA256 of `String(expEpoch)`, compared in constant time; token = `${exp}.${hex}`), the `ws` server, and the CDP screencast forwarding. Guard every ws connection with `verifyToken`.
- [ ] **Step 4: Add an integration test** — start `LiveView` on an ephemeral port against the harness browser, connect a `ws` client with a valid token, assert at least one screencast frame message arrives within a timeout; connect with an expired token, assert the socket is closed/refused.
- [ ] **Step 5: Run** `npm test` → green. **Commit** `feat(live-view): token-gated read-only CDP screencast over ws`.

---

## Task 4: Hand-the-wheel — input relay with no-capture safeguard

**Files:** Modify `src/live-view.ts`; Test extends `test/live-view.test.ts`.

**Interfaces:**
- Produces: `LiveView.setMode(mode: 'read' | 'input'): void`. In `input` mode, ws messages of shape `{ t: 'mouse'|'key', … }` from the client are dispatched to Chrome via CDP `Input.dispatchMouseEvent`/`Input.dispatchKeyEvent`. **Safeguard:** while `mode === 'input'`, the server MUST NOT log, store, or screenshot keystroke payloads — key events are dispatched to CDP and never written anywhere. A ledger/audit of input is explicitly forbidden here (Spec §5.8).

- [ ] **Step 1: Write the failing test** — in `input` mode, a `{t:'key', text:'a'}` client message results in a CDP `Input.dispatchKeyEvent` call (spy/stub the CDP session's `send`), and assert NO key text is present in any server-side buffer/log the test can inspect; in `read` mode the same message is ignored.
- [ ] **Step 2: Run to verify fail.**
- [ ] **Step 3: Implement** `setMode` + the input dispatch, with the no-capture guard (do not push input payloads to any retained array; the frame forwarder and input handler share no buffer that persists key text).
- [ ] **Step 4: Run** `npm test` → green. **Commit** `feat(live-view): hand-the-wheel input relay, no keystroke capture`.

- [ ] **Step 5: Wire `live_*` tools** in `src/server.ts`: `live_start()` → returns a signed URL (calls `LiveView.start` + `url(ttl)`), `live_mode({read|input})` → `setMode`, `live_stop()`. Add a smoke test that the three tools register. **Commit** `feat(server): live_start/live_mode/live_stop tools`.

---

## Task 5 (w-agent, files + smoke — executed WITH William): Chrome host

**Files:** Create `scripts/launch-chrome.sh`, `scripts/scry-chrome.service`.

Not locally verifiable (needs Xvfb + Google Chrome on Linux). Deliver as reviewed files, dry-checked with `bash -n` / `shellcheck`, and run on w-agent during deployment.

- [ ] `launch-chrome.sh`: start Xvfb on a display, launch **Google Chrome** (`google-chrome`, not chromium — for H.264/AAC so Timeliner video isn't black) with `--user-data-dir=~/scry-donnees/profile`, `--remote-debugging-port=9222 --remote-debugging-address=127.0.0.1`, `--no-first-run`, on that display. CDP local-only.
- [ ] `scry-chrome.service`: systemd **user** unit running the script, `Restart=always`, wanted by `default.target`; relies on `loginctl enable-linger` (as the other w-agent services do).
- [ ] `bash -n scripts/launch-chrome.sh` clean; commit `chore(host): Chrome-under-Xvfb launch script + systemd unit`.

---

## Task 6 (w-agent, files — executed WITH William): server unit + tunnel route

**Files:** Create `scripts/scry-server.service`, `scripts/cloudflared-scry.yml`.

- [ ] `scry-server.service`: systemd user unit running the Scry MCP + live-view server, `EnvironmentFile=~/scry-donnees/scry.env` (holds `SCRY_CDP_URL`, `SCRY_DATA_DIR`, the live-view `secret`), `Restart=always`.
- [ ] `cloudflared-scry.yml`: a documented **ingress rule** for the existing `~/.cloudflared/config.yml`, inserted BEFORE the catch-all 404 (like the marketis rule), routing a hostname (e.g. `scry.wautomatisations.com`) to the local live-view port. Note: reload via SIGHUP, never `systemctl restart cloudflared` (would drop the other tunnels).
- [ ] Commit `chore(host): server systemd unit + cloudflared ingress snippet`.

---

## Task 7 (w-agent — executed WITH William): deployment runbook + acceptance

**Files:** Create `docs/DEPLOIEMENT-W-AGENT.md`.

The runbook, then the login-gated acceptance that only William can complete:

- [ ] Clone/pull scry to `~/scry` on w-agent (OUTSIDE the Syncthing `~/projets` tree, per the spec's data-hors-sync ruling); `npm ci`; `npx playwright install chromium` (dev) but the host uses system Google Chrome.
- [ ] Create `~/scry-donnees/scry.env` with the live-view `secret` (generated once, never in git).
- [ ] `systemctl --user enable --now scry-chrome scry-server`; insert the cloudflared ingress rule; SIGHUP cloudflared.
- [ ] **Acceptance (William):** open the signed live link on the iPhone → it shows Chrome on w-agent. Navigate to Timeliner; when the login wall appears, switch to input mode and **log in yourself** (or approve a Google passkey on the phone). Back to read mode. Then, from a Claude session that reaches w-agent, drive Scry to capture the first Timeliner screen (snapshot + screenshot + a thumbnail via `fetch_with_session`) — proving the whole loop, the Mac untouched.

---

## Self-Review

- **Spec coverage:** §5.1 → Task 5. §5.8 live-view+passe-la-main → Tasks 3, 4. §5.9 remote-access → Task 6. §7 tabs_*/live_* → Tasks 2, 4. §8 retry → Task 1. §10 security (token, no-capture, local CDP, secret-out-of-repo) → Tasks 3, 4, 5, 6, 7.
- **Autonomy boundary:** Tasks 1–4 are pure code, locally testable, executable now via subagents. Tasks 5–7 are w-agent infrastructure + William's login — files/runbook now, executed together on w-agent.
- **No core regression:** every code task ends with the full suite green.
- **Deferred (from Plan A, still deferred):** ariaSnapshot ai-mode migration, read_response captured-body, console tool, read scoping, screenshot ref/annotate, navigate back/forward, act select, perf caps — a later iteration.
