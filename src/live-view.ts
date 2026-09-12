import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import type { CDPSession } from 'playwright';
import type { Driver } from './driver.js';
import { VideoStream, VIDEO_MIME, type VideoOpts } from './video.js';

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
 * Control clients (a second ridealong server on the same Chrome, see
 * live-view-remote.ts) authenticate with a DIFFERENT token flavour, keyed
 * on `${secret}:control`: a viewer link can never act as a control client
 * and vice versa.
 */
export function controlSecret(secret: string): string { return `${secret}:control`; }
/** Device tokens (30 days, stored by the viewer page) are keyed on `${secret}:device`. */
export function deviceSecret(secret: string): string { return `${secret}:device`; }
export const DEVICE_TTL_SEC = 30 * 24 * 3600;

export type Verdict = 'approved' | 'denied' | 'timeout' | 'no-viewer';

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
/** What server.ts needs from a live view — implemented by LiveView (owner) and RemoteLiveView (follower). */
export interface LiveViewLike {
  ensureStarted(): Promise<void>;
  url(ttlSec?: number): string;
  setMode(mode: 'read' | 'input'): void;
  getMode(): 'read' | 'input';
  announce(ev: { kind: string; label: string; x?: number; y?: number }): void;
  isPaused(): boolean;
  waitWhilePaused(): Promise<void>;
  stop(): Promise<void>;
  setTabSelector?(fn: ((id: number) => Promise<void>) | undefined): void;
  setViewportSink?(fn: ((v: { width: number; height: number }) => Promise<void>) | undefined): void;
  /** Ask William on the viewer; resolves with his answer, a timeout, or 'no-viewer'. */
  ask(question: string, opts?: { timeoutMs?: number }): Promise<Verdict>;
  /** William's pointer hints and messages, oldest first; drain empties. */
  drainInbox(): string[];
  peekInbox(): string[];
  waitInbox(timeoutMs: number): Promise<string[]>;
  pushInbox(line: string): void;
  /** True when at least one viewer page is attached. */
  hasViewers(): boolean;
}

export class LiveView implements LiveViewLike {
  private server: WebSocketServer | undefined;
  private httpServer: Server | undefined;
  private port = 0;
  // Per viewer: its CDP session on the CURRENT target page and its screencast
  // params, so the cast can be re-attached when the target moves (tabs).
  private sessions = new Map<WebSocket, { cdp: CDPSession; params: ReturnType<typeof screencastParams> }>();
  private tabSelector: ((id: number) => Promise<void>) | undefined;
  private viewportSink: ((v: { width: number; height: number }) => Promise<void>) | undefined;
  private askSeq = 0;
  private asks = new Map<number, (v: Verdict) => void>();
  // Inbox: what William tells Claude from the viewer (pointer hints,
  // messages). Meant FOR Claude, so it flows into tool results; never
  // written to disk. Capped so a chatty viewer can't grow memory.
  private inbox: string[] = [];
  private inboxWaiters: Array<() => void> = [];
  // Control clients: no screencast, they get mode/pause pushes and may set
  // mode, pause, and announce actions (a follower ridealong server).
  private controls = new Set<WebSocket>();
  private mode: 'read' | 'input' = 'read';
  // Set for the duration of stop(): an attach that finishes after clear() must
  // see this and tear itself down instead of leaving an untracked screencast.
  private stopping = false;
  // Tab list pushed to viewers as {tabs:[...]}: polled while anyone is
  // attached (cheap: url() is sync, title() is raced against a short timeout),
  // sent only when it changed. The PRIMARY tab (the one being cast) is marked.
  private tabsTimer: NodeJS.Timeout | undefined;
  private lastTabsJson = '';
  // Pause: William freezes Claude from the page without taking control.
  // Action tools await waitWhilePaused() before running (server.ts).
  private paused = false;
  private pauseWaiters: Array<() => void> = [];

  /**
   * pingMs: interval of the server-side websocket pings that keep an idle
   * link alive. Cloudflare's proxy drops a websocket that carries no bytes
   * for ~100s (measured through the tunnel: close 1006 at 125s), and a
   * static page produces no screencast frame at all — so without pings the
   * live view "disconnects" every two minutes of William waiting. 30s
   * leaves a 3x margin; tests shrink it.
   */
  constructor(private driver: Driver, private opts: { secret: string; publicUrl?: string; quality?: number; pingMs?: number; video?: Partial<VideoOpts> | false; bind?: string }) {
    // The target moved (tabs_select/open/close, or a chip tap): every viewer's
    // screencast and the shared encoder re-attach to the new page, and the
    // tab chips update at once.
    driver.on('page', () => { void this.onTargetChanged(); });
  }

  hasViewers(): boolean { return this.sessions.size > 0; }

  pushInbox(line: string): void {
    this.inbox.push(line.slice(0, 400));
    if (this.inbox.length > 50) this.inbox.splice(0, this.inbox.length - 50);
    this.broadcastTo(this.controls, { william: line.slice(0, 400) }); // followers keep their own inbox
    const w = this.inboxWaiters; this.inboxWaiters = []; for (const r of w) r();
  }
  peekInbox(): string[] { return this.inbox.slice(); }
  drainInbox(): string[] { const out = this.inbox; this.inbox = []; return out; }
  waitInbox(timeoutMs: number): Promise<string[]> {
    if (this.inbox.length) return Promise.resolve(this.drainInbox());
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.inboxWaiters = this.inboxWaiters.filter((r) => r !== wake); resolve(this.drainInbox()); }, timeoutMs);
      const wake = () => { clearTimeout(timer); resolve(this.drainInbox()); };
      this.inboxWaiters.push(wake);
    });
  }

  /** Describe what is under a page point, for "William pointe : …". */
  private async describePoint(x: number, y: number): Promise<string> {
    try {
      const d = await this.driver.page().evaluate(([px, py]) => {
        const el = document.elementFromPoint(px, py) as HTMLElement | null;
        if (!el) return null;
        const role = el.getAttribute('role') || ({ A: 'link', BUTTON: 'button', INPUT: (el as HTMLInputElement).type === 'checkbox' ? 'checkbox' : 'textbox', SELECT: 'combobox', TEXTAREA: 'textbox', IMG: 'img', H1: 'heading', H2: 'heading', H3: 'heading' } as Record<string, string>)[el.tagName] || el.tagName.toLowerCase();
        const name = (el.getAttribute('aria-label') || (el as HTMLInputElement).placeholder || el.getAttribute('title') || (el as HTMLImageElement).alt || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80);
        return { role, name, id: el.id || '' };
      }, [x, y] as [number, number]);
      if (!d) return `William pointe (${x},${y}) : rien de cliquable`;
      return `William pointe : ${d.role}${d.name ? ` « ${d.name} »` : ''}${d.id ? ` #${d.id}` : ''} (${x},${y}) — retrouve-le avec find/snapshot`;
    } catch {
      return `William pointe (${x},${y})`;
    }
  }

  /**
   * Approval gate. The question goes to every viewer as {ask:{id,question}};
   * the first {t:'answer'} wins; everyone is then told {ask:{id,done,ok}}.
   * Nothing but the question text and the verdict is kept.
   */
  ask(question: string, opts: { timeoutMs?: number } = {}): Promise<Verdict> {
    if (!this.hasViewers()) return Promise.resolve('no-viewer');
    const id = ++this.askSeq;
    const timeoutMs = opts.timeoutMs ?? 300_000;
    return new Promise<Verdict>((resolve) => {
      const timer = setTimeout(() => finish('timeout'), timeoutMs);
      const finish = (v: Verdict) => {
        if (!this.asks.has(id)) return;
        this.asks.delete(id);
        clearTimeout(timer);
        this.broadcast({ ask: { id, done: true, ok: v === 'approved' } });
        resolve(v);
      };
      this.asks.set(id, finish);
      this.broadcast({ ask: { id, question: String(question).slice(0, 300), at: Date.now() } });
    });
  }

  private answer(id: unknown, ok: unknown): void {
    if (typeof id !== 'number') return;
    this.asks.get(id)?.(ok === true ? 'approved' : 'denied');
  }

  /** Where a viewer-chosen resolution is persisted (server.ts writes viewport.json). */
  setViewportSink(fn: ((v: { width: number; height: number }) => Promise<void>) | undefined): void { this.viewportSink = fn; }

  /**
   * Resolution picked from the page. Bounded to what Chrome renders sanely;
   * applied to the target (and later tabs), the shared encoder restarts at
   * the new size, every viewer is told, and the choice is persisted.
   */
  async setViewport(w: unknown, h: unknown): Promise<void> {
    const W = Number(w), H = Number(h);
    if (!Number.isInteger(W) || !Number.isInteger(H) || W < 640 || H < 400 || W > 3840 || H > 2400) return;
    await this.driver.setViewport({ width: W, height: H });
    this.broadcast({ viewport: { w: W, h: H } });
    if (this.videoViewers.size) {
      this.broadcastTo(this.videoViewers, { video: { w: W, h: H, mime: VIDEO_MIME } });
      if (this.video) { const v = this.video; this.video = undefined; await v.stop(); }
      const v = this.ensureVideo();
      try { await v.start(); } catch { /* exit handler tells viewers */ }
    }
    try { await this.viewportSink?.({ width: W, height: H }); } catch { /* persistence is best-effort */ }
  }

  /** Wire what a viewer's chip tap does ({t:'tab', id}); server.ts passes tabs.select. */
  setTabSelector(fn: ((id: number) => Promise<void>) | undefined): void { this.tabSelector = fn; }

  private async onTargetChanged(): Promise<void> {
    for (const [ws, st] of [...this.sessions]) {
      if (ws.readyState !== ws.OPEN) continue;
      await st.cdp.send('Page.stopScreencast').catch(() => {});
      await st.cdp.detach().catch(() => {});
      try {
        st.cdp = await this.attachScreencast(ws, st.params);
      } catch {
        ws.close(1011, 'echec du screencast'); // the close handler cleans up
      }
    }
    if (this.video?.isRunning) this.video.restart();
    this.lastTabsJson = '';
    void this.pushTabs();
  }

  /**
   * Open a CDP session on the current target and start its screencast for
   * one viewer. The frame listener is registered BEFORE startScreencast (m2).
   */
  private async attachScreencast(ws: WebSocket, params: ReturnType<typeof screencastParams>): Promise<CDPSession> {
    await this.driver.page().bringToFront().catch(() => {});
    const cdp = await this.driver.cdpSession();
    cdp.on('Page.screencastFrame', async (f) => {
      // m2: drop (but still ACK) a frame when the socket is backed up, so a
      // slow phone link can't grow server memory unbounded or lag minutes
      // behind. Frame payload: the JPEG, its CSS-pixel dimensions (so the
      // page maps a click back to CDP coordinates), the mode and the url.
      // Server->client only — no input is ever echoed here.
      if (ws.readyState === ws.OPEN && ws.bufferedAmount <= 1024 * 1024) {
        ws.send(JSON.stringify({ data: f.data, w: f.metadata?.deviceWidth, h: f.metadata?.deviceHeight, mode: this.mode, url: this.driver.page().url() }));
      }
      try { await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }); } catch { /* tearing down */ }
    });
    try {
      await cdp.send('Page.startScreencast', params);
    } catch (e) {
      await cdp.detach().catch(() => {});
      throw e;
    }
    return cdp;
  }

  // ---- Video path (H.264 fMP4 over the same websocket, see video.ts) ----
  private video: VideoStream | undefined;
  private videoViewers = new Set<WebSocket>();

  private videoEnabled(): boolean { return this.opts.video !== false; }

  private ensureVideo(): VideoStream {
    if (this.video) return this.video;
    const vp = this.driver.viewport();
    const v = new VideoStream(this.driver, { width: vp.width, height: vp.height, ...(this.opts.video || {}) });
    v.on('init', (b: Buffer) => this.sendVideo(Buffer.concat([Buffer.from([1]), b])));
    v.on('segment', (b: Buffer) => this.sendVideo(Buffer.concat([Buffer.from([2]), b])));
    v.on('exit', (info: { code: number | null; stderr: string }) => {
      // ffmpeg died (no encoder, GPU busy...): tell viewers so they fall back to JPEG.
      if (this.videoViewers.size) this.broadcastTo(this.videoViewers, { video: { error: `encodeur termine (code ${info.code}) ${info.stderr.slice(-200)}` } });
    });
    v.on('error', () => { /* surfaced via exit */ });
    this.video = v;
    return v;
  }

  private sendVideo(payload: Buffer): void {
    for (const ws of this.videoViewers) {
      if (ws.readyState !== ws.OPEN) continue;
      // Backpressure: a media segment can't be skipped without breaking the
      // decoder until the next keyframe, so a backed-up viewer (> 4 MB) is
      // dropped and reconnects (its page falls back / retries).
      if (ws.bufferedAmount > 4 * 1024 * 1024) { ws.terminate(); continue; }
      try { ws.send(payload, { binary: true }); } catch { /* cleaned up on close */ }
    }
  }

  private broadcastTo(set: Iterable<WebSocket>, obj: unknown): void {
    const payload = JSON.stringify(obj);
    for (const ws of set) { if (ws.readyState === ws.OPEN) { try { ws.send(payload); } catch { /* ignore */ } } }
  }

  private async subscribeVideo(ws: WebSocket): Promise<void> {
    const v = this.ensureVideo();
    this.videoViewers.add(ws);
    const vp = this.driver.viewport();
    try { ws.send(JSON.stringify({ video: { w: vp.width, h: vp.height, mime: VIDEO_MIME }, mode: this.mode })); } catch { /* dead */ }
    if (v.isRunning) v.restart(); // fresh init + keyframe for the newcomer (and everyone)
    else {
      try { await v.start(); } catch (e) {
        this.videoViewers.delete(ws);
        try { ws.send(JSON.stringify({ video: { error: (e as Error).message } })); } catch { /* dead */ }
      }
    }
  }

  private async unsubscribeVideo(ws: WebSocket): Promise<void> {
    if (!this.videoViewers.delete(ws)) return;
    if (this.videoViewers.size === 0 && this.video) { const v = this.video; this.video = undefined; await v.stop(); }
  }

  /** Switch between read-only streaming and hand-the-wheel input relay. */
  setMode(mode: 'read' | 'input'): void {
    this.mode = mode;
    // Push the new mode to every attached viewer NOW. The mode also rides on
    // each screencast frame, but a static login page produces no frames, so
    // without this the phone would stay on 'read' and drop William's taps —
    // exactly the case hand-the-wheel exists for (N1). We send only the mode
    // string; no keystroke, no token — the no-capture invariant is untouched.
    this.broadcast({ mode });
  }

  private async tabList(): Promise<Array<{ id: number; url: string; title: string; primary: boolean }>> {
    const primary = this.driver.page();
    const pages = this.driver.context().pages();
    return Promise.all(pages.map(async (p, id) => {
      const url = p.url();
      const title = await Promise.race([
        p.title().catch(() => ''),
        new Promise<string>((r) => setTimeout(() => r(''), 300)),
      ]);
      return { id, url, title, primary: p === primary };
    }));
  }

  /** Push the tab list to every viewer if it changed (or to one socket, always). */
  private async pushTabs(only?: WebSocket): Promise<void> {
    let json: string;
    try { json = JSON.stringify({ tabs: await this.tabList() }); } catch { return; }
    if (only) {
      if (only.readyState === only.OPEN) { try { only.send(json); } catch { /* dead socket */ } }
      return;
    }
    if (json === this.lastTabsJson) return;
    this.lastTabsJson = json;
    for (const ws of this.sessions.keys()) {
      if (ws.readyState === ws.OPEN) { try { ws.send(json); } catch { /* cleaned up elsewhere */ } }
    }
  }

  private syncTabsPolling(): void {
    if (this.sessions.size > 0 && !this.tabsTimer) {
      this.tabsTimer = setInterval(() => { void this.pushTabs(); }, 1500);
      this.tabsTimer.unref?.();
    } else if (this.sessions.size === 0 && this.tabsTimer) {
      clearInterval(this.tabsTimer);
      this.tabsTimer = undefined;
      this.lastTabsJson = '';
    }
  }

  /** Send one JSON message to every attached viewer (best-effort). */
  private broadcast(obj: unknown): void {
    const payload = JSON.stringify(obj);
    for (const ws of [...this.sessions.keys(), ...this.controls]) {
      if (ws.readyState === ws.OPEN) { try { ws.send(payload); } catch { /* cleaned up elsewhere */ } }
    }
  }

  /**
   * Tell viewers what Claude is about to do: kind/verb, a label (role and
   * accessible name only — never typed text), and the target centre in page
   * CSS px when known. Server->client only; nothing is retained.
   */
  announce(ev: { kind: string; label: string; x?: number; y?: number }): void {
    this.broadcast({ action: { kind: ev.kind, label: ev.label, x: ev.x, y: ev.y, at: Date.now() } });
  }

  /** Pause/resume Claude's actions; viewers are told. */
  setPaused(on: boolean): void {
    if (this.paused === on) { this.broadcast({ paused: on }); return; }
    this.paused = on;
    this.broadcast({ paused: on });
    if (!on) { const w = this.pauseWaiters; this.pauseWaiters = []; for (const r of w) r(); }
  }

  isPaused(): boolean { return this.paused; }

  /** Resolves at once when not paused, else when resumed (or on stop()). */
  waitWhilePaused(): Promise<void> {
    if (!this.paused) return Promise.resolve();
    return new Promise<void>((resolve) => this.pauseWaiters.push(resolve));
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
      httpServer.listen(bindPort, this.opts.bind ?? '127.0.0.1');
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
    // Static brand assets (favicon, marks) from viewer/brand — names only,
    // no path traversal, known types only.
    const path = (req.url ?? '/').split('?')[0];
    const m = /^\/brand\/([A-Za-z0-9._-]+\.(svg|png))$/.exec(path);
    if (m) {
      const file = join(dirname(VIEWER_PATH), 'brand', m[1]);
      let body: Buffer;
      try { body = readFileSync(file); } catch { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': m[2] === 'svg' ? 'image/svg+xml' : 'image/png', 'cache-control': 'public, max-age=86400' });
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }
    if (path !== '/' && path !== '/index.html') { res.writeHead(404); res.end(); return; }
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
    const control = query.get('control');
    if (control !== null) {
      if (!verifyToken(controlSecret(this.opts.secret), control)) { ws.close(1008, 'jeton de controle invalide'); return; }
      this.handleControl(ws);
      return;
    }
    const token = query.get('token') ?? '';
    const device = query.get('device');
    const byDevice = device !== null && verifyToken(deviceSecret(this.opts.secret), device);
    if (!byDevice && !verifyToken(this.opts.secret, token)) {
      ws.close(1008, 'jeton invalide');
      return;
    }
    if (!byDevice) {
      // Pairing: a valid short link leaves a 30-day device token in this
      // browser, so the bare url works next time (bookmark, home screen).
      try { ws.send(JSON.stringify({ device: mintToken(deviceSecret(this.opts.secret), DEVICE_TTL_SEC) })); } catch { /* dead */ }
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
      const cur = this.sessions.get(ws)?.cdp ?? cdp; // the target may have moved since attach
      this.sessions.delete(ws);
      this.syncTabsPolling();
      if (cur) {
        await cur.send('Page.stopScreencast').catch(() => {});
        await cur.detach().catch(() => {});
      }
    });

    const params = screencastParams({ w: query.get('w'), h: query.get('h') }, this.opts.quality);
    const st: { cdp: CDPSession; params: ReturnType<typeof screencastParams> } = { cdp: undefined as unknown as CDPSession, params };
    const wantsVideo = query.get('video') === '1' && this.videoEnabled();
    try {
      if (wantsVideo) {
        // H.264 path: no per-viewer screencast; the shared encoder feeds this
        // socket. A CDP session is still needed for the input relay.
        ws.on('close', () => { void this.unsubscribeVideo(ws); });
        await this.subscribeVideo(ws);
        await this.driver.page().bringToFront().catch(() => {});
        st.cdp = await this.driver.cdpSession();
      } else {
        // Frame size follows the viewer's own screen (physical pixels, passed
        // as ?w=&h= by the page at connect time); see screencastParams.
        st.cdp = await this.attachScreencast(ws, params);
      }
    } catch {
      // m1: a disconnect during attach must not leave a CDP session behind.
      await this.unsubscribeVideo(ws).catch(() => {});
      ws.close(1011, 'echec du screencast');
      return;
    }
    cdp = st.cdp; // for the close handler registered above

    if (closedDuringAttach || this.stopping || !this.server) {
      // The socket closed, or stop() ran, while we were attaching (M5).
      await st.cdp.send('Page.stopScreencast').catch(() => {});
      await st.cdp.detach().catch(() => {});
      await this.unsubscribeVideo(ws).catch(() => {});
      this.sessions.delete(ws);
      ws.terminate();
      return;
    }

    this.sessions.set(ws, st);
    this.syncTabsPolling();
    void this.pushTabs(ws); // this viewer gets the list right away
    { const vp = this.driver.viewport(); try { ws.send(JSON.stringify({ viewport: { w: vp.width, h: vp.height } })); } catch { /* dead */ } }
    if (this.paused) { try { ws.send(JSON.stringify({ paused: true })); } catch { /* dead socket */ } }

    // Hand-the-wheel input relay. Wired only once the socket is confirmed open
    // with a CDP session attached. NO-CAPTURE: besides the `cdp.send` call
    // itself, this handler never writes the message anywhere — no array push,
    // no console.log — and the parsed object goes out of scope the instant the
    // handler returns.
    //
    // Messages accepted in EITHER mode: {t:'view', w, h} (viewer resized:
    // restart its screencast at the new cap; restarts are serialised and
    // coalesced), {t:'mode'}, {t:'pause'}, {t:'tab', id} (chip tap).
    let restarting: Promise<void> = Promise.resolve();
    let wanted: { w: unknown; h: unknown } | undefined;
    const resize = (hint: { w: unknown; h: unknown }) => {
      wanted = hint;
      restarting = restarting.then(async () => {
        if (!wanted || ws.readyState !== ws.OPEN || wantsVideo) return;
        st.params = screencastParams(wanted, this.opts.quality);
        wanted = undefined;
        await st.cdp.send('Page.stopScreencast').catch(() => {});
        await st.cdp.send('Page.startScreencast', st.params).catch(() => {});
      });
    };
    ws.on('message', async (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        const { t, ...rest } = msg;
        if (t === 'view') { resize({ w: rest.w, h: rest.h }); return; }
        if (t === 'tab') { if (Number.isInteger(rest.id) && this.tabSelector) await this.tabSelector(rest.id).catch(() => {}); return; }
        if (t === 'viewport') { await this.setViewport(rest.w, rest.h); return; }
        if (t === 'answer') { this.answer(rest.id, rest.ok); return; }
        if (t === 'point') { if (Number.isFinite(rest.x) && Number.isFinite(rest.y)) this.pushInbox(await this.describePoint(Math.round(rest.x), Math.round(rest.y))); return; }
        if (t === 'say') { if (typeof rest.text === 'string' && rest.text.trim()) this.pushInbox(`William dit : ${rest.text.trim().slice(0, 300)}`); return; }
        // William takes / gives back control from the page itself. The token
        // holder is William (signed, expiring link), and the same switch is
        // what the live_mode tool does; only the mode string is read.
        if (t === 'mode') { if (rest.mode === 'read' || rest.mode === 'input') this.setMode(rest.mode); return; }
        if (t === 'pause') { this.setPaused(rest.on === true); return; }
        if (this.mode !== 'input') return; // read mode: input is ignored entirely
        if (t === 'mouse') await st.cdp.send('Input.dispatchMouseEvent', rest);
        else if (t === 'key') await st.cdp.send('Input.dispatchKeyEvent', rest);
        else if (t === 'pinch') await st.cdp.send('Input.synthesizePinchGesture', rest);
      } catch {
        // Malformed JSON or a CDP dispatch failure: drop silently. Never
        // log or retain `raw`/`msg` — that is the no-capture guarantee.
      }
    });
  }

  /**
   * A follower ridealong server. Receives every push viewers get (mode, paused,
   * action, tabs) minus frames; may set mode, pause, and announce. Its
   * messages carry no input and are not retained.
   */
  private handleControl(ws: WebSocket): void {
    this.controls.add(ws);
    ws.on('close', () => { this.controls.delete(ws); });
    try { ws.send(JSON.stringify({ mode: this.mode, paused: this.paused })); } catch { /* dead socket */ }
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        const { t, ...rest } = msg;
        if (t === 'mode') { if (rest.mode === 'read' || rest.mode === 'input') this.setMode(rest.mode); }
        else if (t === 'pause') this.setPaused(rest.on === true);
        else if (t === 'announce' && typeof rest.label === 'string') this.announce({ kind: String(rest.kind ?? 'action'), label: rest.label, x: rest.x, y: rest.y });
        else if (t === 'ask' && typeof rest.question === 'string') {
          // A follower asks through us; answer back to it only.
          void this.ask(rest.question, { timeoutMs: typeof rest.timeoutMs === 'number' ? rest.timeoutMs : undefined })
            .then((v) => { if (ws.readyState === ws.OPEN) { try { ws.send(JSON.stringify({ answer: { ref: rest.ref, verdict: v } })); } catch { /* gone */ } } });
        }
      } catch { /* malformed: drop */ }
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

    for (const [ws, st] of this.sessions) {
      await st.cdp.send('Page.stopScreencast').catch(() => {});
      await st.cdp.detach().catch(() => {});
      // M5: terminate(), not the graceful close() — a dead mobile peer would
      // otherwise hold ws's 30s closeTimeout and stall this whole tool call.
      ws.terminate();
    }
    this.sessions.clear();
    this.syncTabsPolling();
    this.setPaused(false); // never leave a tool call hanging on a gone viewer
    for (const finish of [...this.asks.values()]) finish('timeout');

    for (const c of this.controls) c.terminate();
    this.controls.clear();
    this.videoViewers.clear();
    if (this.video) { const v = this.video; this.video = undefined; await v.stop(); }

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
