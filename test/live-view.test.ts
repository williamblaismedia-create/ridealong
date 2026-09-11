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
});
