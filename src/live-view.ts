import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
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

  constructor(private driver: Driver, private opts: { secret: string; publicUrl?: string }) {}

  /** Switch between read-only streaming and hand-the-wheel input relay. */
  setMode(mode: 'read' | 'input'): void {
    this.mode = mode;
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
    const bindPort = port ?? this.port;

    // We own the HTTP server (rather than letting ws create its own) so that
    // non-upgrade GETs get the viewer page instead of ws's canned "426 Upgrade
    // Required" (C2). ws attaches its upgrade handler to it via { server }.
    const httpServer = createServer((req, res) => this.serveViewer(req, res));
    const wss = new WebSocketServer({ server: httpServer });
    this.server = wss;
    this.httpServer = httpServer;

    wss.on('connection', (ws, req) => {
      void this.handleConnection(ws, req);
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
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : VIEWER_HTML);
  }

  private async handleConnection(ws: WebSocket, req: import('node:http').IncomingMessage): Promise<void> {
    const token = new URL(req.url ?? '', 'http://x').searchParams.get('token') ?? '';
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
    ws.on('close', async () => {
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
      await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 60 });
    } catch {
      ws.close(1011, 'echec du screencast');
      return;
    }

    if (!cdp || closedDuringAttach) {
      // The socket closed while we were still attaching CDP above: the
      // close handler already fired, but `cdp` didn't exist yet at that
      // point so it couldn't stop the screencast/detach. Finish that now.
      if (cdp) {
        await cdp.send('Page.stopScreencast').catch(() => {});
        await cdp.detach().catch(() => {});
      }
      this.sessions.delete(ws);
      return;
    }

    this.sessions.set(ws, cdp);

    // Hand-the-wheel input relay. Wired here, in the same place as the frame
    // forwarder below, only once the socket is confirmed open with `cdp`
    // attached. NO-CAPTURE: besides the `cdp.send` call itself, this handler
    // never writes the message anywhere — no array push, no console.log —
    // and the parsed object goes out of scope the instant the handler
    // returns.
    ws.on('message', async (raw) => {
      if (this.mode !== 'input') return; // read mode: input is ignored entirely
      try {
        const msg = JSON.parse(raw.toString());
        const { t, ...rest } = msg;
        if (t === 'mouse') await cdp!.send('Input.dispatchMouseEvent', rest);
        else if (t === 'key') await cdp!.send('Input.dispatchKeyEvent', rest);
      } catch {
        // Malformed JSON or a CDP dispatch failure: drop silently. Never
        // log or retain `raw`/`msg` — that is the no-capture guarantee.
      }
    });

    cdp.on('Page.screencastFrame', async (f) => {
      if (ws.readyState === ws.OPEN) {
        // Frame payload for the viewer page: the JPEG, the frame's CSS-pixel
        // dimensions (so the page can map a click back to CDP coordinates),
        // and the current mode (so the page shows read vs input). This is
        // read-mode/server->client data only — no input is ever echoed here.
        ws.send(JSON.stringify({ data: f.data, w: f.metadata?.deviceWidth, h: f.metadata?.deviceHeight, mode: this.mode }));
      }
      try {
        await cdp!.send('Page.screencastFrameAck', { sessionId: f.sessionId });
      } catch {
        // Session may already be tearing down; nothing to do.
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
    // afterwards, and so a concurrent stop() is a no-op.
    this.server = undefined;
    this.httpServer = undefined;

    for (const [ws, cdp] of this.sessions) {
      await cdp.send('Page.stopScreencast').catch(() => {});
      await cdp.detach().catch(() => {});
      ws.close();
    }
    this.sessions.clear();

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
 * The viewer page (C2, Spec §14 "page statique minimale"). Inert and safe to
 * serve unauthenticated: it holds no secret and does nothing until it opens the
 * token-gated websocket. It renders each `{data}` JPEG frame, shows the current
 * mode, and — only in input mode — relays pointer/keyboard events as the
 * `{t:'mouse'|'key', ...}` messages LiveView.handleConnection forwards to CDP
 * Input.dispatch*. It NEVER writes the token or any keystroke to console.*.
 */
const VIEWER_HTML = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<title>Scry — vue live</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: #0b0d10; color: #e6e6e6;
    font: 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  #bar { display: flex; align-items: center; gap: 10px; padding: 8px 12px;
    background: #14181d; border-bottom: 1px solid #232a31; position: sticky; top: 0; }
  #dot { width: 9px; height: 9px; border-radius: 50%; background: #555; flex: 0 0 auto; }
  #dot.on { background: #45d17a; }
  #mode { font-weight: 600; }
  #mode.read { color: #7fd1ff; }
  #mode.input { color: #ffcf5c; }
  #hint { color: #8a939b; margin-left: auto; }
  #stage { display: flex; justify-content: center; padding: 8px; }
  #screen { display: block; max-width: 100%; height: auto; background: #000;
    touch-action: none; border-radius: 6px; -webkit-user-select: none; user-select: none; }
  #kb { position: absolute; opacity: 0; width: 1px; height: 1px; border: 0; padding: 0; }
</style>
</head>
<body>
  <div id="bar">
    <span id="dot"></span>
    <span>mode : <span id="mode" class="read">…</span></span>
    <span id="hint"></span>
    <input id="kb" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false" aria-label="capture clavier">
  </div>
  <div id="stage"><img id="screen" alt="vue live"></div>
<script>
(function () {
  // Token from the fragment only (never the query string), then scrub it from
  // history immediately (n4). Never logged.
  var token = new URLSearchParams((location.hash || '').replace(/^#/, '')).get('token') || '';
  try { history.replaceState(null, document.title, location.pathname + location.search); } catch (e) {}

  var img = document.getElementById('screen');
  var modeEl = document.getElementById('mode');
  var dot = document.getElementById('dot');
  var hint = document.getElementById('hint');
  var kb = document.getElementById('kb');
  var frameW = 0, frameH = 0, mode = 'read';

  var scheme = location.protocol === 'https:' ? 'wss://' : 'ws://';
  var ws = new WebSocket(scheme + location.host + '/?token=' + encodeURIComponent(token));

  ws.onopen = function () { dot.classList.add('on'); };
  ws.onclose = function () { dot.classList.remove('on'); hint.textContent = 'deconnecte'; };
  ws.onerror = function () { /* no payload logged */ };
  ws.onmessage = function (ev) {
    var msg; try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ''); } catch (e) { return; }
    if (!msg) return;
    if (typeof msg.mode === 'string' && msg.mode !== mode) setMode(msg.mode);
    if (typeof msg.data === 'string') {
      if (msg.w) frameW = msg.w;
      if (msg.h) frameH = msg.h;
      img.src = 'data:image/jpeg;base64,' + msg.data;
    }
  };

  function setMode(m) {
    mode = m;
    modeEl.textContent = m === 'input' ? 'passe-la-main (saisie relayee)' : 'lecture seule';
    modeEl.className = m;
    hint.textContent = m === 'input' ? 'vos clics/frappes vont au navigateur' : '';
  }
  setMode('read');

  function send(obj) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }

  // Map a client point over the <img> to the page CSS-pixel space CDP uses.
  function toPage(cx, cy) {
    var r = img.getBoundingClientRect();
    if (!r.width || !r.height || !frameW || !frameH) return null;
    return { x: Math.round((cx - r.left) / r.width * frameW), y: Math.round((cy - r.top) / r.height * frameH) };
  }
  function mods(e) { return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0); }

  // Pointer events unify mouse + touch + pen (iOS Safari supports them), so one
  // set of handlers covers the iPhone. Relayed only in input mode.
  function mouse(type, e) {
    if (mode !== 'input') return;
    var p = toPage(e.clientX, e.clientY);
    if (p) send({ t: 'mouse', type: type, x: p.x, y: p.y, button: 'left', clickCount: 1, modifiers: mods(e) });
  }
  img.addEventListener('pointerdown', function (e) { e.preventDefault(); mouse('mousePressed', e); });
  img.addEventListener('pointerup', function (e) { e.preventDefault(); mouse('mouseReleased', e); if (mode === 'input') { try { kb.focus(); } catch (x) {} } });
  img.addEventListener('pointermove', function (e) { if (mode === 'input') { e.preventDefault(); mouse('mouseMoved', e); } });

  // Keyboard, captured at window level (covers a physical keyboard and the
  // hidden #kb input that only exists to raise the mobile soft keyboard).
  // A printable key carries its char as text on keyDown — that is what
  // inserts it (the same shape Puppeteer uses); modifiers with ctrl/meta are
  // treated as shortcuts (no text). keyUp mirrors it. Nothing is buffered.
  window.addEventListener('keydown', function (e) {
    if (mode !== 'input') return;
    var text = (e.key && e.key.length === 1 && !e.ctrlKey && !e.metaKey) ? e.key : undefined;
    send({ t: 'key', type: 'keyDown', key: e.key, code: e.code, windowsVirtualKeyCode: e.keyCode, text: text, modifiers: mods(e) });
    if (e.key !== 'F5') e.preventDefault();
  });
  window.addEventListener('keyup', function (e) {
    if (mode !== 'input') return;
    send({ t: 'key', type: 'keyUp', key: e.key, code: e.code, windowsVirtualKeyCode: e.keyCode, modifiers: mods(e) });
    e.preventDefault();
  });
})();
</script>
</body>
</html>`;
