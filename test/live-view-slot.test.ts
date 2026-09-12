import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import { startBrowser } from './helpers.js';
import { Driver } from '../src/driver.js';
import { LiveViewSlot } from '../src/live-view-slot.js';
import { mintToken } from '../src/live-view.js';

// The zombie case of 2026-09-12: the owner of port 9400 died (killed), the
// follower kept handing out links to a dead port. Now it promotes itself.
describe('LiveViewSlot (owner / follower / promotion)', () => {
  const PORT = 9420;
  const secret = 'slot-secret';
  let env: Awaited<ReturnType<typeof startBrowser>>;
  let driver: Driver;
  let a: LiveViewSlot; let b: LiveViewSlot;

  beforeAll(async () => {
    env = await startBrowser();
    driver = await Driver.connect(env.cdpUrl, { viewport: { width: 1440, height: 900 }, defaultTimeoutMs: 15000 });
    await driver.navigate(env.pageUrl);
  });
  afterAll(async () => { await b?.stop(); await a?.stop(); await driver.close(); await env.stop(); });

  it('first slot owns, second follows; when the owner stops, the follower takes the port', async () => {
    a = await LiveViewSlot.create(driver, { secret, port: PORT });
    expect(a.isOwner()).toBe(true);
    const logs: string[] = [];
    b = await LiveViewSlot.create(driver, { secret, port: PORT }, (m) => logs.push(m));
    expect(b.isOwner()).toBe(false);
    expect(logs.join(' ')).toMatch(/suit/);

    await a.stop(); // the owner goes away (session ended / zombie killed)
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !b.isOwner()) await new Promise((r) => setTimeout(r, 200));
    expect(b.isOwner()).toBe(true);
    expect(logs.join(' ')).toMatch(/reprend le port/);

    // Its links now work: a viewer connects to the port b just bound.
    const url = b.url(60);
    const token = new URLSearchParams(url.split('#')[1]).get('token')!;
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/?token=${token}`);
    await new Promise<void>((resolve, reject) => { ws.on('open', () => resolve()); ws.on('error', reject); });
    ws.close();
  }, 20000);
});
