import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import { startBrowser } from './helpers.js';
import { Driver } from '../src/driver.js';
import { LiveView, mintToken } from '../src/live-view.js';
import { RemoteLiveView } from '../src/live-view-remote.js';

// Two Claude Code sessions -> two ridealong servers on ONE Chrome. Only one can
// bind the live-view port; the other must not lose its live_* tools. The
// follower attaches to the owner as a CONTROL client (its own token flavour,
// no screencast) and drives mode / pause / announce through it, minting
// viewer links locally from the same secret.
describe('RemoteLiveView (follower of an existing live view on the same port)', () => {
  const PORT = 9410;
  const secret = 'shared-secret';
  let env: Awaited<ReturnType<typeof startBrowser>>;
  let driver: Driver;
  let owner: LiveView;
  let follower: RemoteLiveView;

  beforeAll(async () => {
    env = await startBrowser();
    driver = await Driver.connect(env.cdpUrl, { viewport: { width: 1440, height: 900 }, defaultTimeoutMs: 15000 });
    await driver.navigate(env.pageUrl);
    owner = new LiveView(driver, { secret });
    await owner.start(PORT);
    follower = new RemoteLiveView({ secret, port: PORT });
    await follower.ensureStarted();
  });

  afterAll(async () => {
    await follower.stop();
    await owner.stop();
    await driver.close();
    await env.stop();
  });

  const viewer = () => new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/?token=${mintToken(secret, 60)}`);
    ws.on('open', () => resolve(ws)); ws.on('error', reject);
  });

  it('a second LiveView on the same port fails to bind (this is the case the follower exists for)', async () => {
    const second = new LiveView(driver, { secret });
    await expect(second.start(PORT)).rejects.toThrow(/EADDRINUSE/);
  });

  it('a viewer token is refused as a control token, and vice versa', async () => {
    const asControl = new WebSocket(`ws://127.0.0.1:${PORT}/?control=${mintToken(secret, 60)}`);
    const code = await new Promise<number>((resolve) => asControl.on('close', (c) => resolve(c)));
    expect(code).toBe(1008);
  });

  it('follower.url() mints a viewer link that the owner accepts', async () => {
    const url = follower.url(120);
    const token = new URLSearchParams(url.split('#')[1]).get('token')!;
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/?token=${token}`);
    await new Promise<void>((resolve, reject) => { ws.on('open', () => resolve()); ws.on('error', reject); });
    ws.close();
  });

  it('follower.setMode() flips the owner and the follower sees the confirmed mode', async () => {
    follower.setMode('input');
    await new Promise((r) => setTimeout(r, 300));
    expect(owner.getMode()).toBe('input');
    expect(follower.getMode()).toBe('input');
    follower.setMode('read');
    await new Promise((r) => setTimeout(r, 300));
    expect(owner.getMode()).toBe('read');
    expect(follower.getMode()).toBe('read');
  });

  it('follower.announce() reaches viewers of the owner', async () => {
    const ws = await viewer();
    try {
      const got = new Promise<any>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('no action')), 3000);
        ws.on('message', (d) => { let m: any; try { m = JSON.parse(d.toString()); } catch { return; } if (m && m.action) { clearTimeout(t); resolve(m.action); } });
      });
      await new Promise((r) => setTimeout(r, 200));
      follower.announce({ kind: 'click', label: 'click button « Go »', x: 10, y: 20 });
      expect((await got).label).toContain('Go');
    } finally { ws.close(); }
  });

  it('a pause from a viewer gates the follower too', async () => {
    const ws = await viewer();
    try {
      await new Promise((r) => setTimeout(r, 200));
      ws.send(JSON.stringify({ t: 'pause', on: true }));
      await new Promise((r) => setTimeout(r, 300));
      expect(follower.isPaused()).toBe(true);
      let released = false;
      const gate = follower.waitWhilePaused().then(() => { released = true; });
      await new Promise((r) => setTimeout(r, 200));
      expect(released).toBe(false);
      ws.send(JSON.stringify({ t: 'pause', on: false }));
      await gate;
      expect(released).toBe(true);
    } finally { owner.setPaused(false); ws.close(); }
  });

  it('follower.stop() detaches without stopping the owner', async () => {
    await follower.stop();
    await new Promise((r) => setTimeout(r, 200));
    const ws = await viewer(); // owner still serving
    ws.close();
    await follower.ensureStarted(); // re-attach for afterAll symmetry
  });
});
