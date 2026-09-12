import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import WebSocket from 'ws';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBrowser } from './helpers.js';
import { Driver } from '../src/driver.js';
import { mintToken, verifyToken, LiveView, screencastParams } from '../src/live-view.js';

/** Width/height of a baseline or progressive JPEG, read from its SOF marker. */
function jpegSize(buf: Buffer): { w: number; h: number } {
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  throw new Error('no SOF marker');
}

describe('screencastParams (pure)', () => {
  it('caps the frame to the viewer\'s reported physical pixels', () => {
    expect(screencastParams({ w: '750', h: '1334' })).toEqual({ format: 'jpeg', quality: 85, maxWidth: 750, maxHeight: 1334 });
  });
  it('falls back to a desktop default on a missing or garbage hint', () => {
    expect(screencastParams({})).toMatchObject({ maxWidth: 1920, maxHeight: 1200 });
    expect(screencastParams({ w: 'abc', h: null })).toMatchObject({ maxWidth: 1920, maxHeight: 1200 });
  });
  it('clamps absurd sizes and rounds fractions', () => {
    expect(screencastParams({ w: 10, h: 99999 })).toMatchObject({ maxWidth: 320, maxHeight: 4096 });
    expect(screencastParams({ w: 1000.6, h: 500.4 })).toMatchObject({ maxWidth: 1001, maxHeight: 500 });
  });
  it('honours a configured quality and clamps it to 1-100', () => {
    expect(screencastParams({}, 100).quality).toBe(100);
    expect(screencastParams({}, 250).quality).toBe(100);
    expect(screencastParams({}, NaN).quality).toBe(85);
  });
});

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

  it('rejects a token whose exp was extended but mac left unchanged (the realistic forgery)', () => {
    const token = mintToken(secret, 60);
    const mac = token.split('.')[1];
    // Push the expiry far into the future while keeping the mac that was
    // computed over the ORIGINAL exp — the mac no longer matches, so verify
    // must fail even though the exp alone would look fresh.
    const forged = `${Math.floor(Date.now() / 1000) + 999999}.${mac}`;
    expect(verifyToken(secret, forged)).toBe(false);
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

  // url() now returns the human-facing BROWSER link (#token, publicUrl-aware,
  // n4/m6); the viewer page reads that fragment and opens the ws with the token
  // in the query. Tests connect the ws directly, so they build the ws URL with
  // the token in the query the way the page would.
  const wsUrlFor = (port: number, ttlSec = 60) => `ws://127.0.0.1:${port}/?token=${mintToken(secret, ttlSec)}`;

  it('cleans up the CDP session if the client disconnects during/right after attach (no leak)', async () => {
    expect(live.sessionCount()).toBe(0);

    const ws = new WebSocket(wsUrlFor(PORT));
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
    const ws = new WebSocket(wsUrlFor(PORT));
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

  // Wait for the next screencast frame on `ws`, poking the DOM so a static
  // page still produces one (same rationale as above).
  async function nextFrame(ws: WebSocket, timeoutMs = 4000): Promise<{ w: number; h: number }> {
    return new Promise((resolve, reject) => {
      const poke = setInterval(() => {
        void driver.page().evaluate(() => { document.title = 'poke-' + Math.random(); }).catch(() => {});
      }, 100);
      const timer = setTimeout(() => { clearInterval(poke); reject(new Error('timeout waiting for frame')); }, timeoutMs);
      const onMsg = (data: WebSocket.RawData) => {
        let m: any; try { m = JSON.parse(data.toString()); } catch { return; }
        if (!m || typeof m.data !== 'string') return;
        clearInterval(poke); clearTimeout(timer); ws.off('message', onMsg);
        resolve(jpegSize(Buffer.from(m.data, 'base64')));
      };
      ws.on('message', onMsg);
    });
  }

  it('sizes the frames to the viewer\'s screen: small hint -> small JPEG, big hint -> full viewport', async () => {
    // A phone-sized viewer (physical px) gets a frame no wider than it asked for.
    const small = new WebSocket(wsUrlFor(PORT) + '&w=640&h=400');
    await new Promise<void>((resolve, reject) => { small.on('open', () => resolve()); small.on('error', reject); });
    const s = await nextFrame(small);
    expect(s.w).toBeLessThanOrEqual(640);
    expect(s.h).toBeLessThanOrEqual(400);
    small.close();

    // A big desktop viewer gets the page at its real viewport width (1440),
    // i.e. no more forced 1280 downscale.
    const big = new WebSocket(wsUrlFor(PORT) + '&w=3000&h=2000');
    await new Promise<void>((resolve, reject) => { big.on('open', () => resolve()); big.on('error', reject); });
    const b = await nextFrame(big);
    expect(b.w).toBe(1440);
    expect(b.h).toBe(900);
    big.close();
  });

  it('restarts the screencast at a new cap on a {t:"view"} message (rotation/resize), in read mode', async () => {
    const ws = new WebSocket(wsUrlFor(PORT) + '&w=3000&h=2000');
    await new Promise<void>((resolve, reject) => { ws.on('open', () => resolve()); ws.on('error', reject); });
    expect((await nextFrame(ws)).w).toBe(1440);
    expect(live.getMode()).toBe('read'); // accepted regardless of mode: it carries no input
    ws.send(JSON.stringify({ t: 'view', w: 480, h: 300 }));
    // The first frame(s) after the message may still be in flight at the old
    // size; wait until one arrives at the new cap.
    const deadline = Date.now() + 5000;
    let got = { w: 0, h: 0 };
    while (Date.now() < deadline) {
      got = await nextFrame(ws);
      if (got.w <= 480) break;
    }
    expect(got.w).toBeLessThanOrEqual(480);
    expect(got.h).toBeLessThanOrEqual(300);
    ws.close();
  });

  // Cloudflare (the tunnel the phone comes through) closes a websocket that
  // carries no traffic for ~100s (measured: 1006 at 125s). A static page
  // emits no screencast frame, so the server must keep the link warm with
  // protocol pings on its own.
  it('sends websocket pings on its own so an idle tunnel link stays up', async () => {
    const pinger = new LiveView(driver, { secret, pingMs: 100 });
    await pinger.start(PORT + 1);
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT + 1}/?token=${mintToken(secret, 60)}`);
      const gotPing = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no ping within 3s')), 3000);
        ws.on('ping', () => { clearTimeout(timer); resolve(); });
        ws.on('error', reject);
      });
      await gotPing;
      ws.close();
    } finally {
      await pinger.stop();
    }
  });

  // The viewer page must come back by itself after a drop (tunnel idle cut,
  // phone screen lock, MCP server restart), as long as its token is valid.
  it('viewer page reconnects on its own after the server goes away and comes back', async () => {
    const lv = new LiveView(driver, { secret });
    const { url } = await lv.start(PORT + 2);
    const viewer = await driver.context().newPage();
    try {
      await viewer.goto(url(300));
      await viewer.waitForSelector('#dot.on', { timeout: 5000 });
      await lv.stop();
      await viewer.waitForSelector('#dot:not(.on)', { timeout: 5000 });
      await lv.ensureStarted();
      await viewer.waitForSelector('#dot.on', { timeout: 10000 });
    } finally {
      await viewer.close().catch(() => {});
      await lv.stop();
    }
  });

  // The page scrubs the token from the URL on load (n4). A plain reload —
  // the first thing anyone does when a view looks stuck — must NOT turn a
  // valid link into "lien expire": the token is kept per tab (sessionStorage)
  // so the reload reconnects. It is still never sent to the server in a URL
  // path/query and never lands in history.
  it('viewer page survives a reload without the token in the URL', async () => {
    const lv = new LiveView(driver, { secret });
    const { url } = await lv.start(PORT + 3);
    const viewer = await driver.context().newPage();
    try {
      await viewer.goto(url(300));
      await viewer.waitForSelector('#dot.on', { timeout: 5000 });
      expect(viewer.url()).not.toContain('token='); // scrubbed
      await viewer.reload();
      await viewer.waitForSelector('#dot.on', { timeout: 5000 });
      expect(await viewer.textContent('#hint')).not.toContain('expire');
    } finally {
      await viewer.close().catch(() => {});
      await lv.stop();
    }
  });

  // William can take the wheel himself from the page: a {t:'mode'} message
  // from a token holder flips the server mode exactly like the live_mode
  // tool does, and the change is broadcast to every viewer.
  it('a viewer can toggle the mode itself with {t:"mode"} (take / give back the wheel)', async () => {
    const ws = await connectAttached(wsUrlFor(PORT));
    try {
      expect(live.getMode()).toBe('read');
      const pushed = new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no mode push within 2s')), 2000);
        ws.on('message', (data) => {
          let m: any; try { m = JSON.parse(data.toString()); } catch { return; }
          if (m && m.mode === 'input' && m.data === undefined) { clearTimeout(timer); resolve(m); }
        });
      });
      ws.send(JSON.stringify({ t: 'mode', mode: 'input' }));
      await pushed;
      expect(live.getMode()).toBe('input');
      ws.send(JSON.stringify({ t: 'mode', mode: 'garbage' }));
      await new Promise((r) => setTimeout(r, 200));
      expect(live.getMode()).toBe('input'); // an invalid value is ignored
      ws.send(JSON.stringify({ t: 'mode', mode: 'read' }));
      await new Promise((r) => setTimeout(r, 200));
      expect(live.getMode()).toBe('read');
    } finally {
      live.setMode('read');
      ws.close();
    }
  });

  it('the viewer page has an Auto/Manuel toggle that takes and gives back the wheel', async () => {
    const lv = new LiveView(driver, { secret });
    const { url } = await lv.start(PORT + 4);
    const viewer = await driver.context().newPage();
    try {
      await viewer.goto(url(300));
      await viewer.waitForSelector('#dot.on', { timeout: 5000 });
      await viewer.click('#seg-manual');
      await viewer.waitForSelector('#mode.input', { timeout: 3000 });
      expect(lv.getMode()).toBe('input');
      await viewer.click('#seg-auto');
      await viewer.waitForSelector('#mode.read', { timeout: 3000 });
      expect(lv.getMode()).toBe('read');
    } finally {
      await viewer.close().catch(() => {});
      await lv.stop();
    }
  });

  it('pushes a mode change to attached viewers at once, without waiting for a frame (N1)', async () => {
    const ws = await connectAttached(wsUrlFor(PORT));
    try {
      const modePush = new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no standalone mode push within 2s')), 2000);
        ws.on('message', (data) => {
          let m: any;
          try { m = JSON.parse(data.toString()); } catch { return; }
          // Isolate the standalone {mode} broadcast from screencast frames,
          // which carry {data,...}. On a static page no frame flows, so this
          // push is the ONLY thing that would flip the viewer to input mode.
          if (m && typeof m.mode === 'string' && m.data === undefined) { clearTimeout(timer); resolve(m); }
        });
      });
      live.setMode('input');
      expect((await modePush).mode).toBe('input');
    } finally {
      live.setMode('read'); // restore shared state for later tests
      ws.close();
    }
  });

  it('closes the connection when the token is expired', async () => {
    const expiredUrl = `ws://127.0.0.1:${PORT}/?token=${mintToken(secret, -1)}`;
    const ws = new WebSocket(expiredUrl);
    const closeCode = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for close')), 4000);
      ws.on('close', (code) => { clearTimeout(timer); resolve(code); });
      ws.on('message', () => { clearTimeout(timer); reject(new Error('should not receive frames on expired token')); });
      ws.on('error', () => { /* a connection reset also counts as refused; close handler resolves */ });
    });
    expect(closeCode).toBe(1008);
  });

  it('closes with 1008 when no token is supplied — a frame is never sent without a valid token (C2)', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/`);
    const code = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for close')), 4000);
      ws.on('close', (c) => { clearTimeout(timer); resolve(c); });
      ws.on('message', () => { clearTimeout(timer); reject(new Error('frame sent without a token')); });
      ws.on('error', () => {});
    });
    expect(code).toBe(1008);
  });

  it('serves the inert viewer page on a plain GET without a token — HTML, not 426 (C2)', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/`);
    expect(res.status).toBe(200);
    expect(res.status).not.toBe(426);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain('id="screen"');   // the frame surface
    expect(body).toContain('Scry');           // the page identifies itself
    // Inert: no real minted token is baked into the served page (it reads one
    // from the fragment at runtime, which never reaches this server). The JS
    // string literal "token=" is fine; a minted token value would not be.
    expect(body).not.toMatch(/#token=\d+\.[0-9a-f]{16,}/);
  });

  it('url() returns a #token browser link (n4), never a ?token query', () => {
    const link = live.url();
    expect(link).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${PORT}/#token=\\d+\\.[0-9a-f]+$`));
    expect(link).not.toContain('?token=');
  });

  it('url() clamps ttl to [30, 3600] and defaults to ~900 (m4)', () => {
    const expOf = (link: string) => Number(link.split('#token=')[1].split('.')[0]);
    const now = () => Math.floor(Date.now() / 1000);
    expect(expOf(live.url()) - now()).toBeGreaterThan(870);        // default 900
    expect(expOf(live.url()) - now()).toBeLessThanOrEqual(900);
    expect(expOf(live.url(5)) - now()).toBeGreaterThanOrEqual(29); // clamped up to 30
    expect(expOf(live.url(5)) - now()).toBeLessThanOrEqual(31);
    expect(expOf(live.url(999999)) - now()).toBeLessThanOrEqual(3600); // clamped down
    expect(expOf(live.url(999999)) - now()).toBeGreaterThan(3560);
  });

  it('url() mints from SCRY_LIVE_PUBLIC_URL when set (m6)', async () => {
    const lv = new LiveView(driver, { secret, publicUrl: 'https://scry.example.com' });
    await lv.start(9407);
    try {
      expect(lv.url()).toMatch(/^https:\/\/scry\.example\.com\/#token=\d+\.[0-9a-f]+$/);
    } finally {
      await lv.stop();
    }
  });

  it('read mode (the default) ignores an input message — no effect on the page', async () => {
    live.setMode('read');
    await driver.page().evaluate(() => { (document.getElementById('name') as HTMLInputElement).value = ''; });

    const ws = await connectAttached(wsUrlFor(PORT));
    ws.send(JSON.stringify({ t: 'key', type: 'char', text: 'z' }));
    await new Promise((r) => setTimeout(r, 300));

    expect(await driver.page().locator('#name').inputValue()).toBe('');
    ws.close();
  });

  it('input mode relays mouse + key events to CDP, typing into the page — and retains none of it', async () => {
    await driver.page().evaluate(() => { (document.getElementById('name') as HTMLInputElement).value = ''; });
    const keysBefore = Object.keys(live as unknown as Record<string, unknown>).sort();

    // Spy the three console sinks: a keystroke that reached any of them would
    // defeat no-capture even without a retained field (m9c / M4.3).
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // A temp dir standing in for the artifact store: the relay owns no store,
    // so nothing must ever be written here on account of the input.
    const artifactDir = mkdtempSync(join(tmpdir(), 'scry-nocap-'));

    live.setMode('input');
    expect(live.getMode()).toBe('input');

    const box = await driver.page().locator('#name').boundingBox();
    if (!box) throw new Error('no bounding box for #name');
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;

    const ws = await connectAttached(wsUrlFor(PORT));

    // Distinctive string, unlikely to appear anywhere else in LiveView's own
    // state — the no-capture assertions below check for exactly this text.
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

    live.setMode('read');
    ws.close();

    // NO-CAPTURE (Spec §5.8). This must not be defeatable by a newly ADDED
    // field, so we inspect CONTENTS, not just the key set:
    // 1) key set unchanged (a retained buffer would add a property);
    const keysAfter = Object.keys(live as unknown as Record<string, unknown>).sort();
    expect(keysAfter).toEqual(keysBefore);
    // 2) deep-walk every own enumerable prop except the driver/server/session
    //    HANDLES (complex/circular by nature, and not capture surfaces), and
    //    assert the serialized state never contains the typed text — this is
    //    what a `log: string[]` or a stashed `lastMsg` would show up in;
    const skip = new Set(['driver', 'server', 'httpServer', 'sessions']);
    const own: Record<string, unknown> = {};
    for (const k of Object.keys(live as unknown as Record<string, unknown>)) {
      if (!skip.has(k)) own[k] = (live as unknown as Record<string, unknown>)[k];
    }
    expect(JSON.stringify(own)).not.toContain(typed);
    // 3) nothing was logged to any console sink;
    for (const spy of [logSpy, errSpy, warnSpy]) {
      for (const call of spy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain(typed);
      }
    }
    // 4) nothing hit disk.
    for (const f of readdirSync(artifactDir)) {
      expect(readFileSync(join(artifactDir, f), 'utf8')).not.toContain(typed);
    }

    logSpy.mockRestore();
    errSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('back in read mode, the same input message is ignored again (gating is dynamic, not one-shot)', async () => {
    live.setMode('read');
    await driver.page().evaluate(() => { (document.getElementById('name') as HTMLInputElement).value = ''; });

    const ws = await connectAttached(wsUrlFor(PORT));
    ws.send(JSON.stringify({ t: 'key', type: 'char', text: 'z' }));
    await new Promise((r) => setTimeout(r, 300));

    expect(await driver.page().locator('#name').inputValue()).toBe('');
    ws.close();
  });

  // --- Lifecycle (M2): live_start -> live_stop -> live_start must keep working ---

  it('url() throws when the view has not been started', () => {
    const lv = new LiveView(driver, { secret });
    expect(() => lv.url()).toThrow(/vue live non demarree/);
  });

  it('re-serves after stop then restart — url() is dead in between, a client streams after', async () => {
    const lv = new LiveView(driver, { secret });
    await lv.start(9404);
    await lv.stop();
    // Between stop and restart the link is dead, not a URL to a closed port.
    expect(() => lv.url()).toThrow(/vue live non demarree/);
    await lv.ensureStarted(); // what live_start does after a live_stop
    const ws = await connectAttached(wsUrlFor(9404));
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
    await lv.stop();
  });

  it('stop() is idempotent — a second stop resolves without throwing', async () => {
    const lv = new LiveView(driver, { secret });
    await lv.start(9405);
    await lv.stop();
    await expect(lv.stop()).resolves.toBeUndefined();
  });

  it('stop() terminates an attached client promptly and closes the port (M5)', async () => {
    const lv = new LiveView(driver, { secret });
    await lv.start(9410);
    const ws = await connectAttached(`ws://127.0.0.1:9410/?token=${mintToken(secret, 60)}`);
    ws.on('error', () => {}); // terminate() shows up as a reset here — expected
    const closed = new Promise<void>((resolve) => ws.on('close', () => resolve()));

    const t0 = Date.now();
    await lv.stop();
    await closed;
    expect(Date.now() - t0).toBeLessThan(5000); // no 30s graceful-close hang

    // The port is genuinely released: a fresh connection is refused.
    const outcome = await new Promise<string>((resolve) => {
      const probe = new WebSocket(`ws://127.0.0.1:9410/?token=${mintToken(secret, 60)}`);
      probe.on('open', () => { probe.close(); resolve('open'); });
      probe.on('error', (e: NodeJS.ErrnoException) => resolve(e?.code ?? 'error'));
    });
    expect(outcome).toBe('ECONNREFUSED');
  });

  it('a second bind on a busy port rejects while the first keeps serving (graceful degradation)', async () => {
    const a = new LiveView(driver, { secret });
    await a.start(9406);
    const b = new LiveView(driver, { secret });
    await expect(b.start(9406)).rejects.toBeTruthy();
    // The first instance is unaffected and still streams to a token-holder.
    const ws = await connectAttached(wsUrlFor(9406));
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
    await a.stop();
  });

  // Runs the ACTUAL viewer-page JS in a real browser (it is never type-checked,
  // so a syntax slip would otherwise ship silently). Loads the served page with
  // a token in the fragment and asserts: the JS runs top-to-bottom with no
  // page error, it scrubs the token out of the URL (n4), and it opens the
  // token-gated websocket. Kept last so the viewer tab it foregrounds can't
  // starve an earlier frame-dependent test of screencast frames.
  it('the served viewer page runs, scrubs its #token (n4), and opens the ws (C2)', async () => {
    const lv = new LiveView(driver, { secret });
    await lv.start(9409);
    const viewer = await driver.context().newPage();
    const errors: string[] = [];
    viewer.on('pageerror', (e) => errors.push(String(e)));
    viewer.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    try {
      const link = `http://127.0.0.1:9409/#token=${mintToken(secret, 60)}`;
      await viewer.goto(link, { waitUntil: 'domcontentloaded' });
      // ws.onopen flips the status dot to green; wait for that as proof the
      // token made it from the fragment into the query and was accepted.
      await viewer.waitForFunction(() => document.getElementById('dot')?.classList.contains('on'), { timeout: 8000 });
      expect(await viewer.evaluate(() => location.hash)).toBe(''); // scrubbed
      expect(errors).toEqual([]);
    } finally {
      await viewer.close();
      await driver.page().bringToFront().catch(() => {});
      await lv.stop();
    }
  });
});
