import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import { startBrowser } from './helpers.js';
import { Driver } from '../src/driver.js';
import { mintToken, verifyToken, LiveView } from '../src/live-view.js';

describe('mintToken / verifyToken (pure)', () => {
  const secret = 'test-secret';

  it('verifies a freshly minted token', () => {
    const token = mintToken(secret, 60);
    expect(verifyToken(secret, token)).toBe(true);
  });

  it('rejects a token minted already expired', () => {
    const token = mintToken(secret, -1);
    expect(verifyToken(secret, token)).toBe(false);
  });

  it('rejects a tampered token', () => {
    const token = mintToken(secret, 60);
    const [exp, mac] = token.split('.');
    // Flip one hex char of the mac, wrapping to a different valid hex digit.
    const flipped = (mac[0] === '0' ? '1' : '0') + mac.slice(1);
    const tampered = `${exp}.${flipped}`;
    expect(verifyToken(secret, tampered)).toBe(false);
  });

  it('rejects malformed input', () => {
    expect(verifyToken(secret, 'garbage')).toBe(false);
  });
});

describe('LiveView (integration)', () => {
  const PORT = 9401;
  const secret = 'integration-secret';
  let env: Awaited<ReturnType<typeof startBrowser>>;
  let driver: Driver;
  let live: LiveView;
  let liveUrl: (ttlSec?: number) => string;

  beforeAll(async () => {
    env = await startBrowser();
    driver = await Driver.connect(env.cdpUrl, { viewport: { width: 1440, height: 900 }, defaultTimeoutMs: 15000 });
    await driver.navigate(env.pageUrl);
    await driver.waitReady();
    live = new LiveView(driver, { secret });
    const started = await live.start(PORT);
    liveUrl = started.url;
  });

  afterAll(async () => {
    await live.stop();
    await driver.close();
    await env.stop();
  });

  // The server only wires its per-connection message listener (frame
  // forwarder + input relay) once CDP attach finishes — see live-view.ts.
  // A message sent right after the client's `open` event can race ahead of
  // that registration and be silently dropped before any listener exists,
  // regardless of mode. That is correct (no queueing of early input — a
  // queue would itself be a capture buffer), but it means input tests must
  // wait for proof that attach is done before sending anything. The first
  // screencast frame is that proof: it can only be emitted after the frame
  // listener is registered, which happens right after the message listener
  // in the same synchronous block, so seeing a frame guarantees the message
  // listener is already live.
  async function connectAttached(url: string): Promise<WebSocket> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });
    await new Promise<void>((resolve, reject) => {
      const poke = setInterval(() => {
        void driver.page().evaluate(() => { document.title = 'poke-' + Math.random(); }).catch(() => {});
      }, 100);
      const timer = setTimeout(() => { clearInterval(poke); reject(new Error('timeout waiting for attach')); }, 4000);
      ws.once('message', () => { clearInterval(poke); clearTimeout(timer); resolve(); });
      ws.once('error', (err) => { clearInterval(poke); clearTimeout(timer); reject(err); });
    });
    return ws;
  }

  it('cleans up the CDP session if the client disconnects during/right after attach (no leak)', async () => {
    expect(live.sessionCount()).toBe(0);

    const ws = new WebSocket(liveUrl());
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });
    ws.on('error', () => {}); // a reset during our own abrupt close is not a test failure
    ws.close();

    await new Promise((r) => setTimeout(r, 300));
    expect(live.sessionCount()).toBe(0);
  });

  it('streams at least one screencast frame to a client with a valid token', async () => {
    const ws = new WebSocket(liveUrl());
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });

    // Page.startScreencast emits an initial frame on its own as soon as it
    // attaches, so no forced change is strictly required. As a defensive
    // nudge (in case that ever isn't true in some headless environment),
    // poke the DOM every 250ms until a frame arrives or we time out.
    //
    // This MUST be a same-document mutation (evaluate), not a navigation:
    // an isolated repro showed that calling driver.navigate() concurrently
    // with the server's cdpSession()/Page.startScreencast() setup on the
    // same page makes Chromium reply "Not attached to an active page" (the
    // navigation tears down/replaces the frame's host mid-attach). A DOM
    // mutation via evaluate() never replaces the frame, so it can't race
    // the attach that way.
    const frame = await new Promise<any>((resolve, reject) => {
      const poke = setInterval(() => {
        void driver.page().evaluate(() => { document.title = 'poke-' + Math.random(); }).catch(() => {});
      }, 250);
      const timer = setTimeout(() => {
        clearInterval(poke);
        reject(new Error('timeout waiting for frame'));
      }, 4000);
      ws.on('message', (data) => {
        clearInterval(poke);
        clearTimeout(timer);
        resolve(JSON.parse(data.toString()));
      });
      ws.on('error', (err) => {
        clearInterval(poke);
        clearTimeout(timer);
        reject(err);
      });
    });

    expect(typeof frame.data).toBe('string');
    expect(frame.data.length).toBeGreaterThan(0);
    ws.close();
  });

  it('closes the connection when the token is expired', async () => {
    const expiredUrl = liveUrl(-1);
    const ws = new WebSocket(expiredUrl);
    const closeCode = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for close')), 4000);
      ws.on('close', (code) => { clearTimeout(timer); resolve(code); });
      ws.on('message', () => { clearTimeout(timer); reject(new Error('should not receive frames on expired token')); });
      ws.on('error', () => { /* a connection reset also counts as refused; close handler resolves */ });
    });
    expect(closeCode).toBe(1008);
  });

  it('read mode (the default) ignores an input message — no effect on the page', async () => {
    live.setMode('read');
    await driver.page().evaluate(() => { (document.getElementById('name') as HTMLInputElement).value = ''; });

    const ws = await connectAttached(liveUrl());
    ws.send(JSON.stringify({ t: 'key', type: 'char', text: 'z' }));
    await new Promise((r) => setTimeout(r, 300));

    expect(await driver.page().locator('#name').inputValue()).toBe('');
    ws.close();
  });

  it('input mode relays mouse + key events to CDP, typing into the page — and retains none of it', async () => {
    await driver.page().evaluate(() => { (document.getElementById('name') as HTMLInputElement).value = ''; });
    const keysBefore = Object.keys(live as unknown as Record<string, unknown>).sort();

    live.setMode('input');
    expect(live.getMode()).toBe('input');

    const box = await driver.page().locator('#name').boundingBox();
    if (!box) throw new Error('no bounding box for #name');
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;

    const ws = await connectAttached(liveUrl());

    // Distinctive string, unlikely to appear anywhere else in LiveView's own
    // state — the no-capture assertion below checks for exactly this text.
    const typed = 'q9zk7p';
    ws.send(JSON.stringify({ t: 'mouse', type: 'mousePressed', x, y, button: 'left', clickCount: 1 }));
    ws.send(JSON.stringify({ t: 'mouse', type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }));
    for (const ch of typed) {
      ws.send(JSON.stringify({ t: 'key', type: 'char', text: ch }));
    }

    let value = '';
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      value = await driver.page().locator('#name').inputValue();
      if (value === typed) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(value).toBe(typed);

    // NO-CAPTURE (Spec §5.8): relaying the input above must not have grown
    // any new property on the LiveView instance — the shape a keystroke
    // buffer/log would take — and the one string-valued field it owns
    // (`mode`) never contains the typed text.
    const keysAfter = Object.keys(live as unknown as Record<string, unknown>).sort();
    expect(keysAfter).toEqual(keysBefore);
    expect(live.getMode()).not.toContain(typed);

    live.setMode('read');
    ws.close();
  });

  it('back in read mode, the same input message is ignored again (gating is dynamic, not one-shot)', async () => {
    live.setMode('read');
    await driver.page().evaluate(() => { (document.getElementById('name') as HTMLInputElement).value = ''; });

    const ws = await connectAttached(liveUrl());
    ws.send(JSON.stringify({ t: 'key', type: 'char', text: 'z' }));
    await new Promise((r) => setTimeout(r, 300));

    expect(await driver.page().locator('#name').inputValue()).toBe('');
    ws.close();
  });
});
