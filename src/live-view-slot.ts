import { LiveView, type LiveViewLike, type Verdict } from './live-view.js';
import { RemoteLiveView } from './live-view-remote.js';
import type { Driver } from './driver.js';
import type { VideoOpts } from './video.js';

export interface SlotOpts { secret: string; port: number; publicUrl?: string; quality?: number; video?: Partial<VideoOpts> | false; bind?: string }

/**
 * One live view per Chrome, whoever is running. The slot tries to OWN the
 * port; if another ridealong server already does, it FOLLOWS it (control client).
 * When the owner goes away — its session ended, or it was a zombie that got
 * killed — the follower promotes itself: it binds the port and becomes the
 * owner, so the links it hands out keep working. If yet another server won
 * the race, it keeps following. server.ts talks to the slot only.
 */
export class LiveViewSlot implements LiveViewLike {
  private current!: LiveViewLike;
  private owner: LiveView | undefined;
  private follower: RemoteLiveView | undefined;
  private tabSelector: ((id: number) => Promise<void>) | undefined;
  private viewportSink: ((v: { width: number; height: number }) => Promise<void>) | undefined;
  private eventListener: ((ev: { kind: 'inbox' | 'mode' | 'pause'; text: string }) => void) | undefined;
  private promoting = false;
  private stopped = false;

  private constructor(private driver: Driver, private opts: SlotOpts) {}

  static async create(driver: Driver, opts: SlotOpts, log: (msg: string) => void = () => {}): Promise<LiveViewSlot> {
    const slot = new LiveViewSlot(driver, opts);
    await slot.tryOwn(log, true);
    return slot;
  }

  /** Bind the port as owner; on EADDRINUSE follow (or keep following). */
  private async tryOwn(log: (msg: string) => void, initial = false): Promise<boolean> {
    const owner = new LiveView(this.driver, { secret: this.opts.secret, publicUrl: this.opts.publicUrl, quality: this.opts.quality, video: this.opts.video, bind: this.opts.bind });
    try {
      await owner.start(this.opts.port);
    } catch (e) {
      if (!/EADDRINUSE/.test((e as Error).message)) throw e;
      if (initial) {
        this.follower = new RemoteLiveView({ secret: this.opts.secret, port: this.opts.port, publicUrl: this.opts.publicUrl, onOwnerGone: () => { void this.promote(log); } });
        this.follower.setEventListener(this.eventListener);
        await this.follower.ensureStarted();
        this.current = this.follower;
        log('vue live deja servie par une autre session : cette session la suit (mode controle).');
      }
      return false;
    }
    owner.setMode(this.current?.getMode?.() ?? 'read');
    owner.setTabSelector(this.tabSelector);
    owner.setViewportSink(this.viewportSink);
    owner.setEventListener(this.eventListener);
    const old = this.follower; this.follower = undefined;
    for (const line of old?.drainInbox() ?? []) owner.pushInbox(line);
    this.owner = owner; this.current = owner;
    if (old) await old.stop();
    if (!initial) log('maitre de la vue live disparu : cette session reprend le port.');
    return true;
  }

  private async promote(log: (msg: string) => void): Promise<void> {
    if (this.promoting || this.stopped || this.owner) return;
    this.promoting = true;
    try { await this.tryOwn(log); } catch { /* keep following */ } finally { this.promoting = false; }
  }

  isOwner(): boolean { return !!this.owner; }

  async ensureStarted(): Promise<void> { return this.current.ensureStarted(); }
  url(ttlSec?: number): string { return this.current.url(ttlSec); }
  setMode(mode: 'read' | 'input'): void { this.current.setMode(mode); }
  getMode(): 'read' | 'input' { return this.current.getMode(); }
  announce(ev: { kind: string; label: string; x?: number; y?: number }): void { this.current.announce(ev); }
  isPaused(): boolean { return this.current.isPaused(); }
  waitWhilePaused(): Promise<void> { return this.current.waitWhilePaused(); }
  setTabSelector(fn: ((id: number) => Promise<void>) | undefined): void { this.tabSelector = fn; this.owner?.setTabSelector(fn); }
  setViewportSink(fn: ((v: { width: number; height: number }) => Promise<void>) | undefined): void { this.viewportSink = fn; this.owner?.setViewportSink(fn); }
  setEventListener(fn: ((ev: { kind: 'inbox' | 'mode' | 'pause'; text: string }) => void) | undefined): void { this.eventListener = fn; this.owner?.setEventListener(fn); this.follower?.setEventListener(fn); }
  hasViewers(): boolean { return this.current.hasViewers(); }
  pushInbox(line: string): void { this.current.pushInbox(line); }
  peekInbox(): string[] { return this.current.peekInbox(); }
  drainInbox(): string[] { return this.current.drainInbox(); }
  waitInbox(timeoutMs: number): Promise<string[]> { return this.current.waitInbox(timeoutMs); }
  ask(question: string, opts?: { timeoutMs?: number }): Promise<Verdict> { return this.current.ask(question, opts); }
  async stop(): Promise<void> { this.stopped = true; await this.current.stop(); }
}
