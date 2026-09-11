import { createHmac, timingSafeEqual } from 'node:crypto';
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
  private port = 0;
  private sessions = new Map<WebSocket, CDPSession>();
  private mode: 'read' | 'input' = 'read';

  constructor(private driver: Driver, private opts: { secret: string }) {}

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
    const wss = new WebSocketServer({ host: '127.0.0.1', port: bindPort });
    this.server = wss;

    wss.on('connection', (ws, req) => {
      void this.handleConnection(ws, req);
    });

    await new Promise<void>((resolve, reject) => {
      wss.once('listening', () => resolve());
      wss.once('error', (err) => {
        // Failed to bind (e.g. EADDRINUSE from a stale process): drop the
        // half-bound handle so the object can be retried, and let the caller
        // (main()) degrade to a core server without live_* tools.
        this.server = undefined;
        reject(err);
      });
    });

    this.port = bindPort;
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
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ data: f.data }));
      try {
        await cdp!.send('Page.screencastFrameAck', { sessionId: f.sessionId });
      } catch {
        // Session may already be tearing down; nothing to do.
      }
    });
  }

  url(ttlSec = 300): string {
    if (!this.server) throw new Error('vue live non demarree');
    return `http://127.0.0.1:${this.port}/?token=${mintToken(this.opts.secret, ttlSec)}`;
  }

  /** Number of currently live (attached) screencast sessions. For tests/observability. */
  sessionCount(): number {
    return this.sessions.size;
  }

  async stop(): Promise<void> {
    const wss = this.server;
    if (!wss) return; // idempotent: already stopped (a second live_stop resolves)
    // Clear the handle up front so url() throws and ensureStarted() re-binds
    // afterwards, and so a concurrent stop() is a no-op.
    this.server = undefined;

    for (const [ws, cdp] of this.sessions) {
      await cdp.send('Page.stopScreencast').catch(() => {});
      await cdp.detach().catch(() => {});
      ws.close();
    }
    this.sessions.clear();

    await new Promise<void>((resolve, reject) => {
      wss.close((err) => (err ? reject(err) : resolve()));
    });
  }
}
