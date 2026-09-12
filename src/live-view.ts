import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import type { CDPSession } from 'playwright';
import type { Driver } from './driver.js';

/**
 * Mint a token of the form `${exp}.${hmac}` where `exp` is a unix-epoch
 * expiry (seconds) and `hmac` is HMAC-SHA256(secret, String(exp)) in hex.
 */
export function mintToken(secret: string, ttlSec: number): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const mac = createHmac('sha256', secret).update(String(exp)).digest('hex');
  return `${exp}.${mac}`;
}

/**
 * Verify a token minted by mintToken: recompute the HMAC over the exp part,
 * compare in constant time, and require the expiry to still be in the future.
 * Any parse error (malformed token, bad hex, length mismatch) verifies false.
 */
export function verifyToken(secret: string, token: string): boolean {
  try {
    const dot = token.indexOf('.');
    if (dot < 0) return false;
    const expPart = token.slice(0, dot);
    const macPart = token.slice(dot + 1);
    const expected = createHmac('sha256', secret).update(expPart).digest('hex');
    const given = Buffer.from(macPart, 'hex');
    const wanted = Buffer.from(expected, 'hex');
    if (given.length !== wanted.length || given.length === 0) return false;
    if (!timingSafeEqual(given, wanted)) return false;
    const exp = Number(expPart);
    if (!Number.isFinite(exp)) return false;
    return exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

/** Bounds for a viewer-requested frame size (physical pixels). */
const MIN_FRAME_PX = 320;
const MAX_FRAME_PX = 4096;
const DEFAULT_QUALITY = 85;

/**
 * Compute the Page.startScreencast parameters for one viewer. The viewer
 * reports the PHYSICAL pixels it can display (CSS size x devicePixelRatio);
 * the frame is capped to that, so a phone gets a small stream and a retina
 * desktop gets everything Chrome can render — each device gets the best
 * quality it can actually show, and nobody pays for pixels they can't see.
 * Chrome never upscales past its own viewport, so a huge hint is harmless.
 * A missing/garbage hint falls back to a generous desktop default.
 */
export function screencastParams(hint: { w?: unknown; h?: unknown }, quality = DEFAULT_QUALITY): { format: 'jpeg'; quality: number; maxWidth: number; maxHeight: number } {
  const dim = (v: unknown, dflt: number): number => {
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
    if (!Number.isFinite(n)) return dflt;
    return Math.min(MAX_FRAME_PX, Math.max(MIN_FRAME_PX, Math.round(n)));
  };
  const q = Number.isFinite(quality) ? Math.min(100, Math.max(1, Math.round(quality))) : DEFAULT_QUALITY;
  return { format: 'jpeg', quality: q, maxWidth: dim(hint.w, 1920), maxHeight: dim(hint.h, 1200) };
}

/**
 * Live view: streams the driven page's screen over a token-gated websocket
 * via CDP's Page.startScreencast (read mode), and — only in input mode —
 * relays the client's mouse/key events back to Chrome via CDP
 * Input.dispatch* (hand-the-wheel, Spec §5.8).
 *
 * NO-CAPTURE SAFEGUARD (Spec §5.8, hard constraint): while relaying input,
 * this class MUST NOT store, log, buffer, or screenshot the input payloads.
 * The input handler below parses each message only to strip off `t` and
 * hand the rest straight to `cdp.send`; nothing is pushed to a retained
 * array, nothing is console.logged, and there is no property on LiveView
 * that accumulates keystrokes. Keep it that way: any change that makes a
 * message outlive its handler call breaks this guarantee.
 */
export class LiveView {
  private server: WebSocketServer | undefined;
  private httpServer: Server | undefined;
  private port = 0;
  private sessions = new Map<WebSocket, CDPSession>();
  private mode: 'read' | 'input' = 'read';
  // Set for the duration of stop(): an attach that finishes after clear() must
  // see this and tear itself down instead of leaving an untracked screencast.
  private stopping = false;

  /**
   * pingMs: interval of the server-side websocket pings that keep an idle
   * link alive. Cloudflare's proxy drops a websocket that carries no bytes
   * for ~100s (measured through the tunnel: close 1006 at 125s), and a
   * static page produces no screencast frame at all — so without pings the
   * live view "disconnects" every two minutes of William waiting. 30s
   * leaves a 3x margin; tests shrink it.
   */
  constructor(private driver: Driver, private opts: { secret: string; publicUrl?: string; quality?: number; pingMs?: number }) {}

  /** Switch between read-only streaming and hand-the-wheel input relay. */
  setMode(mode: 'read' | 'input'): void {
    this.mode = mode;
    // Push the new mode to every attached viewer NOW. The mode also rides on
    // each screencast frame, but a static login page produces no frames, so
    // without this the phone would stay on 'read' and drop William's taps —
    // exactly the case hand-the-wheel exists for (N1). We send only the mode
    // string; no keystroke, no token — the no-capture invariant is untouched.
    const payload = JSON.stringify({ mode });
    for (const ws of this.sessions.keys()) {
      if (ws.readyState === ws.OPEN) {
        try { ws.send(payload); } catch { /* a dead socket is cleaned up elsewhere */ }
      }
    }
  }

  /** Current mode. For tools/tests — not part of any capture path. */
  getMode(): 'read' | 'input' {
    return this.mode;
  }

  /**
   * Bind the ws server (eager, at process start). Remembers the port so a
   * later live_start after a live_stop can re-bind on it. Kept as the public
   * entry used by main() and the tests; delegates to ensureStarted.
   */
  async start(port: number): Promise<{ url: (ttlSec?: number) => string }> {
    this.port = port;
    await this.ensureStarted(port);
    return { url: (ttlSec?: number) => this.url(ttlSec) };
  }

  /**
   * Lazily (re-)create the ws server. A no-op when already listening, so
   * live_start is cheap to call repeatedly; after a live_stop cleared
   * `this.server`, it re-binds on the remembered port. This is what makes the
   * live_start -> live_stop -> live_start cycle hand out a live link every
   * time instead of a URL to a closed port (M2).
   */
  async ensureStarted(port?: number): Promise<void> {
    if (this.server) return;
    this.stopping = false; // fresh server: accept connections again after a stop()
    const bindPort = port ?? this.port;

    // We own the HTTP server (rather than letting ws create its own) so that
    // non-upgrade GETs get the viewer page instead of ws's canned "426 Upgrade
    // Required" (C2). ws attaches its upgrade handler to it via { server }.
    // maxPayload caps inbound frames (m3): input messages are tiny, so a large
    // frame is abuse — reject it small rather than buffer up to ws's 100 MiB.
    const httpServer = createServer((req, res) => this.serveViewer(req, res));
    const wss = new WebSocketServer({ server: httpServer, maxPayload: 64 * 1024 });
    this.server = wss;
    this.httpServer = httpServer;

    wss.on('connection', (ws, req) => {
      // m3: a throw out of handleConnection must not become an unhandled
      // rejection — terminate the socket instead.
      void this.handleConnection(ws, req).catch(() => ws.terminate());
    });

    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        httpServer.removeListener('listening', onListening);
        httpServer.removeListener('error', onError);
        wss.removeListener('error', onError);
      };
      const onListening = () => { cleanup(); resolve(); };
      const onError = (err: Error) => {
        // Failed to bind (e.g. EADDRINUSE from a stale process): drop the
        // half-bound handles so the object can be retried, and let the caller
        // (main()) degrade to a core server without live_* tools. ws re-emits
        // the underlying server's error on the WebSocketServer too, so listen
        // on both or the re-emit is an uncaught 'error' that kills the process.
        cleanup();
        this.server = undefined;
        this.httpServer = undefined;
        reject(err);
      };
      httpServer.once('listening', onListening);
      httpServer.once('error', onError);
      wss.once('error', onError);
      httpServer.listen(bindPort, '127.0.0.1');
    });

    // Running phase: keep a benign server-level error handler so a stray late
    // error (ws re-emits socket/server errors on the wss) can't crash the MCP
    // process. Per-connection errors are handled in handleConnection. (n2: a
    // later server-level error is swallowed here rather than surfaced.)
    wss.on('error', () => {});
    httpServer.on('error', () => {});

    this.port = bindPort;
  }

  /**
   * Serve the inert viewer page on any non-upgrade GET. Serving it
   * UNAUTHENTICATED is fine (C2): the page is static and does nothing on its
   * own; the screencast FRAMES are what the token gates, over the websocket.
   * The page reads the token from its URL fragment (never sent to this server,
   * so it stays out of access logs — n4) and opens the ws with it.
   */
  private serveViewer(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('method not allowed');
      return;
    }
    const html = loadViewerHtml();
    if (html === undefined) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('page viewer introuvable sur le disque');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : html);
  }

  private async handleConnection(ws: WebSocket, req: import('node:http').IncomingMessage): Promise<void> {
    // m3: guard the socket's 'error' FIRST. ws emits 'error' unguarded
    // (receiverOnError); with no listener an EventEmitter 'error' throws and
    // takes the whole MCP process down. Invalid UTF-8 / an over-maxPayload
    // frame / a bad close code from a token-holder is the one path by which a
    // ws client could crash the server — terminate the socket instead.
    ws.on('error', () => ws.terminate());

    const query = new URL(req.url ?? '', 'http://x').searchParams;
    const token = query.get('token') ?? '';
    if (!verifyToken(this.opts.secret, token)) {
      ws.close(1008, 'jeton invalide');
      return;
    }

    // `cdp` starts unset. Register the close handler NOW, before the CDP
    // attach awaits below, so a disconnect mid-attach (a flaky mobile link
    // is exactly the scenario this feature targets) still runs cleanup
    // instead of leaking the screencast + CDP session for the life of the
    // process on an always-on service. The same handler also covers the
    // ordinary case where the socket closes after everything is set up.
    let cdp: CDPSession | undefined;
    let closedDuringAttach = false;
    // Keepalive pings (see the constructor note). Protocol-level frames: the
    // browser answers them itself, the page never sees them, and they carry
    // no payload — nothing to do with input, so the no-capture invariant is
    // untouched. Started now so even a slow attach keeps the link warm.
    const ping = setInterval(() => {
      if (ws.readyState === ws.OPEN) { try { ws.ping(); } catch { /* dying socket */ } }
    }, this.opts.pingMs ?? 30_000);
    ws.on('close', async () => {
      clearInterval(ping);
      closedDuringAttach = true;
      if (cdp) {
        await cdp.send('Page.stopScreencast').catch(() => {});
        await cdp.detach().catch(() => {});
      }
      this.sessions.delete(ws);
    });

    // Bring the cast (PRIMARY) tab to the foreground: in headful Chrome a
    // backgrounded tab stops emitting screencast frames, so the live view would
    // silently freeze if another tab were in front (M3). Best-effort.
    await this.driver.page().bringToFront().catch(() => {});

    try {
      cdp = await this.driver.cdpSession();
      // m2: register the frame listener BEFORE startScreencast. ws dispatches
      // every protocol frame in a TCP chunk synchronously, so a screencastFrame
      // arriving in the same chunk as the startScreencast response would be
      // emitted before the listener exists -> never acked -> the cast stalls
      // against Chromium's small in-flight cap with no error.
      cdp.on('Page.screencastFrame', async (f) => {
        // m2: drop (but still ACK) a frame when the socket is backed up, so a
        // slow phone link can't grow server memory unbounded or lag minutes
        // behind. Frame payload: the JPEG, its CSS-pixel dimensions (so the
        // page maps a click back to CDP coordinates), and the current mode.
        // Server->client only — no input is ever echoed here.
        if (ws.readyState === ws.OPEN && ws.bufferedAmount <= 1024 * 1024) {
          ws.send(JSON.stringify({ data: f.data, w: f.metadata?.deviceWidth, h: f.metadata?.deviceHeight, mode: this.mode }));
        }
        try {
          await cdp!.send('Page.screencastFrameAck', { sessionId: f.sessionId });
        } catch {
          // Session may already be tearing down; nothing to do.
        }
      });
      // Frame size follows the viewer's own screen (physical pixels, passed
      // as ?w=&h= by the page at connect time); see screencastParams.
      await cdp.send('Page.startScreencast', screencastParams({ w: query.get('w'), h: query.get('h') }, this.opts.quality));
    } catch {
      // m1: detach the CDP session on the failure path. A disconnect during
      // newCDPSession followed by a startScreencast throw would otherwise leave
      // `cdp` attached forever (the closedDuringAttach cleanup below is skipped
      // by this return).
      await cdp?.detach().catch(() => {});
      ws.close(1011, 'echec du screencast');
      return;
    }

    if (closedDuringAttach || this.stopping || !this.server) {
      // The socket closed, or stop() ran, while we were attaching. The close
      // handler may have fired before `cdp` existed, and an attach that
      // finishes after stop()'s clear() would otherwise leave a running
      // screencast nobody tracks (M5). Tear this one down now.
      if (cdp) {
        await cdp.send('Page.stopScreencast').catch(() => {});
        await cdp.detach().catch(() => {});
      }
      this.sessions.delete(ws);
      ws.terminate();
      return;
    }

    this.sessions.set(ws, cdp);

    // Hand-the-wheel input relay. Wired only once the socket is confirmed open
    // with `cdp` attached. NO-CAPTURE: besides the `cdp.send` call itself, this
    // handler never writes the message anywhere — no array push, no
    // console.log — and the parsed object goes out of scope the instant the
    // handler returns.
    //
    // The one message accepted in EITHER mode is `{t:'view', w, h}`: the
    // viewer's screen size changed (rotation, window resize), so the
    // screencast is restarted at the new cap. Only the two numbers are read
    // from it; restarts are serialised and coalesced (a burst of resize
    // events ends in a single restart at the last size).
    let restarting: Promise<void> = Promise.resolve();
    let wanted: { w: unknown; h: unknown } | undefined;
    const resize = (hint: { w: unknown; h: unknown }) => {
      wanted = hint;
      restarting = restarting.then(async () => {
        if (!wanted || ws.readyState !== ws.OPEN) return;
        const params = screencastParams(wanted, this.opts.quality);
        wanted = undefined;
        await cdp!.send('Page.stopScreencast').catch(() => {});
        await cdp!.send('Page.startScreencast', params).catch(() => {});
      });
    };
    ws.on('message', async (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        const { t, ...rest } = msg;
        if (t === 'view') { resize({ w: rest.w, h: rest.h }); return; }
        // William takes / gives back control from the page itself. The token
        // holder is William (signed, expiring link), and the same switch is
        // what the live_mode tool does; only the mode string is read.
        if (t === 'mode') { if (rest.mode === 'read' || rest.mode === 'input') this.setMode(rest.mode); return; }
        if (this.mode !== 'input') return; // read mode: input is ignored entirely
        if (t === 'mouse') await cdp!.send('Input.dispatchMouseEvent', rest);
        else if (t === 'key') await cdp!.send('Input.dispatchKeyEvent', rest);
      } catch {
        // Malformed JSON or a CDP dispatch failure: drop silently. Never
        // log or retain `raw`/`msg` — that is the no-capture guarantee.
      }
    });
  }

  url(ttlSec?: number): string {
    if (!this.server) throw new Error('vue live non demarree');
    // TTL bounds (m4): default 900s — a Google passkey/2FA login can exceed
    // 5 min. Clamp to [30, 3600] so no caller can mint a practically permanent
    // link (ttlSec huge) or an already-dead one (negative). The tool layer
    // validates too; this is defence in depth for any direct caller.
    const ttl = Math.min(3600, Math.max(30, Math.floor(ttlSec ?? 900)));
    const token = mintToken(this.opts.secret, ttl);
    // Public tunnel base when configured (m6), else loopback. The token rides
    // in the URL fragment (n4): a fragment is never sent to the server, so it
    // stays out of Cloudflare/HTTP access logs, and the page scrubs it from
    // history on load.
    const base = this.opts.publicUrl ?? `http://127.0.0.1:${this.port}`;
    return `${base}/#token=${token}`;
  }

  /** Number of currently live (attached) screencast sessions. For tests/observability. */
  sessionCount(): number {
    return this.sessions.size;
  }

  async stop(): Promise<void> {
    const wss = this.server;
    const httpServer = this.httpServer;
    if (!wss) return; // idempotent: already stopped (a second live_stop resolves)
    // Clear the handles up front so url() throws and ensureStarted() re-binds
    // afterwards, and so a concurrent stop() is a no-op. `stopping` makes any
    // in-flight attach tear itself down instead of re-adding to `sessions`.
    this.stopping = true;
    this.server = undefined;
    this.httpServer = undefined;

    for (const [ws, cdp] of this.sessions) {
      await cdp.send('Page.stopScreencast').catch(() => {});
      await cdp.detach().catch(() => {});
      // M5: terminate(), not the graceful close() — a dead mobile peer would
      // otherwise hold ws's 30s closeTimeout and stall this whole tool call.
      ws.terminate();
    }
    this.sessions.clear();

    // M5: terminate any client that passed the token check but isn't in
    // `sessions` yet (still mid-attach), or wss.close() below waits on it.
    for (const client of wss.clients) client.terminate();

    await new Promise<void>((resolve, reject) => {
      wss.close((err) => (err ? reject(err) : resolve()));
    });
    // ws attached to our HTTP server, so ws.close() leaves it listening —
    // close it too or the port stays bound and ensureStarted() can't re-bind.
    if (httpServer) {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
    }
  }
}

/**
 * The viewer page (C2, Spec §14 "page statique minimale") lives in
 * viewer/index.html and is read from disk on EVERY request: a fix to the
 * page takes effect on the next reload, with no server restart — which
 * matters because the server is spawned per Claude Code session and a
 * restart means a /mcp reconnect for William. The page is inert and safe to
 * serve unauthenticated: it holds no secret and does nothing until it opens
 * the token-gated websocket. See the file for its contract (token from the
 * fragment + sessionStorage, reconnect, {t:'view'} sizing, input relay).
 * SCRY_VIEWER_HTML overrides the path (tests, packaging).
 */
function resolveViewerPath(): string {
  if (process.env.SCRY_VIEWER_HTML) return process.env.SCRY_VIEWER_HTML;
  // This module runs from src/ (vitest) or dist/src/ (built): walk up from
  // the module to the first directory that has viewer/index.html.
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    const candidate = join(dir, 'viewer', 'index.html');
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  return join(dir, 'viewer', 'index.html'); // will 500 with a clear message
}
const VIEWER_PATH = resolveViewerPath();

function loadViewerHtml(): string | undefined {
  try {
    return readFileSync(VIEWER_PATH, 'utf8');
  } catch {
    return undefined;
  }
}
