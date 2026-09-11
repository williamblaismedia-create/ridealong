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
 * Read-only live view: streams the driven page's screen over a token-gated
 * websocket via CDP's Page.startScreencast. No input handling here — that is
 * a later task.
 */
export class LiveView {
  private server: WebSocketServer | undefined;
  private port = 0;
  private sessions = new Map<WebSocket, CDPSession>();

  constructor(private driver: Driver, private opts: { secret: string }) {}

  async start(port: number): Promise<{ url: (ttlSec?: number) => string }> {
    const wss = new WebSocketServer({ host: '127.0.0.1', port });
    this.server = wss;

    wss.on('connection', (ws, req) => {
      void this.handleConnection(ws, req);
    });

    await new Promise<void>((resolve, reject) => {
      wss.once('listening', () => resolve());
      wss.once('error', reject);
    });

    this.port = port;
    return { url: (ttlSec?: number) => this.url(ttlSec) };
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
    return `http://127.0.0.1:${this.port}/?token=${mintToken(this.opts.secret, ttlSec)}`;
  }

  /** Number of currently live (attached) screencast sessions. For tests/observability. */
  sessionCount(): number {
    return this.sessions.size;
  }

  async stop(): Promise<void> {
    for (const [ws, cdp] of this.sessions) {
      await cdp.send('Page.stopScreencast').catch(() => {});
      await cdp.detach().catch(() => {});
      ws.close();
    }
    this.sessions.clear();

    const wss = this.server;
    if (!wss) return;
    await new Promise<void>((resolve, reject) => {
      wss.close((err) => (err ? reject(err) : resolve()));
    });
  }
}
