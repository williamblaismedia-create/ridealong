import WebSocket from 'ws';
import { mintToken, controlSecret, type LiveViewLike } from './live-view.js';

/**
 * Follower live view. Two Claude Code sessions each spawn a scry server on
 * the same Chrome; only one can bind the live-view port. Instead of losing
 * its live_* tools (EADDRINUSE), the second attaches to the owner as a
 * CONTROL client over loopback: it mints viewer links itself (same secret,
 * same public URL), drives mode/pause/announce through the owner, and
 * mirrors the owner's mode and pause state from its pushes. Frames never
 * flow here. The owner keeps running when the follower stops.
 *
 * Reconnects with a short backoff while the owner is away; if the owner is
 * gone for good, the port is free and the next session becomes the owner.
 */
export class RemoteLiveView implements LiveViewLike {
  private ws: WebSocket | undefined;
  private mode: 'read' | 'input' = 'read';
  private paused = false;
  private pauseWaiters: Array<() => void> = [];
  private closing = false;
  private retry: NodeJS.Timeout | undefined;

  private everConnected = false;

  constructor(private opts: { secret: string; port: number; publicUrl?: string; onOwnerGone?: () => void }) {}

  async ensureStarted(): Promise<void> {
    this.closing = false;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    await this.connect();
  }

  private connect(): Promise<void> {
    return new Promise<void>((resolve) => {
      const token = mintToken(controlSecret(this.opts.secret), 3600);
      const ws = new WebSocket(`ws://127.0.0.1:${this.opts.port}/?control=${token}`);
      this.ws = ws;
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(); } };
      ws.on('open', () => { this.everConnected = true; done(); });
      ws.on('message', (raw) => {
        let m: any; try { m = JSON.parse(raw.toString()); } catch { return; }
        if (m && typeof m.mode === 'string' && (m.mode === 'read' || m.mode === 'input')) this.mode = m.mode;
        if (m && typeof m.paused === 'boolean') this.applyPaused(m.paused);
      });
      ws.on('error', () => { /* close follows */ });
      let opened = false;
      ws.once('open', () => { opened = true; });
      ws.on('close', () => {
        if (this.ws === ws) this.ws = undefined;
        this.applyPaused(false); // never leave a tool call hanging on a gone owner
        done();
        if (this.closing) return;
        // A reconnect that never opened means nobody listens on the port any
        // more: the owner is gone (its session ended, or it was a zombie that
        // got killed). Tell the slot so this server can take the port itself.
        if (!opened && this.everConnected) this.opts.onOwnerGone?.();
        this.retry = setTimeout(() => { void this.connect(); }, 2000);
      });
      // Don't hang a tool call on an owner that never answers.
      setTimeout(done, 3000);
    });
  }

  private applyPaused(on: boolean): void {
    this.paused = on;
    if (!on) { const w = this.pauseWaiters; this.pauseWaiters = []; for (const r of w) r(); }
  }

  private send(obj: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) { try { this.ws.send(JSON.stringify(obj)); } catch { /* owner gone */ } }
  }

  url(ttlSec?: number): string {
    const ttl = Math.min(3600, Math.max(30, Math.floor(ttlSec ?? 900)));
    const base = this.opts.publicUrl ?? `http://127.0.0.1:${this.opts.port}`;
    return `${base}/#token=${mintToken(this.opts.secret, ttl)}`;
  }

  setMode(mode: 'read' | 'input'): void { this.mode = mode; this.send({ t: 'mode', mode }); }
  getMode(): 'read' | 'input' { return this.mode; }
  announce(ev: { kind: string; label: string; x?: number; y?: number }): void { this.send({ t: 'announce', ...ev }); }
  isPaused(): boolean { return this.paused; }
  waitWhilePaused(): Promise<void> {
    if (!this.paused) return Promise.resolve();
    return new Promise<void>((resolve) => this.pauseWaiters.push(resolve));
  }

  /** Detach from the owner (which keeps serving). */
  async stop(): Promise<void> {
    this.closing = true;
    if (this.retry) { clearTimeout(this.retry); this.retry = undefined; }
    const ws = this.ws; this.ws = undefined;
    this.applyPaused(false);
    if (ws) { try { ws.terminate(); } catch { /* ignore */ } }
  }
}
