import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBrowser } from './helpers.js';
import { Driver } from '../src/driver.js';
import { ArtifactStore } from '../src/artifact-store.js';
import { Perception } from '../src/perception.js';
import { Action } from '../src/action.js';
import { Network } from '../src/network.js';
import { buildServer } from '../src/server.js';
import { LiveView } from '../src/live-view.js';

let env: Awaited<ReturnType<typeof startBrowser>>;
let driver: Driver; let server: ReturnType<typeof buildServer>;
beforeAll(async () => {
  env = await startBrowser();
  driver = await Driver.connect(env.cdpUrl, { viewport: { width: 1440, height: 900 }, defaultTimeoutMs: 15000 });
  const store = new ArtifactStore(mkdtempSync(join(tmpdir(), 'scry-')));
  server = buildServer({ perception: new Perception(driver, store, 8000), action: new Action(driver), network: new Network(driver, store) });
  await driver.navigate(env.pageUrl); await driver.waitReady();
});
afterAll(async () => { await driver.close(); await env.stop(); });

describe('buildServer', () => {
  it('registers the Spec §7 tools', () => {
    const names = server.listToolNames();
    for (const t of ['navigate', 'snapshot', 'find', 'read', 'state', 'screenshot', 'act', 'fill', 'scroll', 'network_requests', 'fetch_with_session']) {
      expect(names).toContain(t);
    }
  });

  it('snapshot returns a state header line then the tree text', async () => {
    const out = await server.callTool('snapshot', {});
    expect(out).toMatch(/^\[state\] url=/);
    expect(out).toContain('button "Go"');
  });

  it('callTool rejects an unknown tool name', () => {
    expect(() => server.callTool('does-not-exist', {})).toThrow(/outil inconnu/);
  });

  it('does not register live_* tools when no liveView is supplied', () => {
    const names = server.listToolNames();
    expect(names).not.toContain('live_start');
    expect(names).not.toContain('live_mode');
    expect(names).not.toContain('live_stop');
  });
});

describe('buildServer with a liveView', () => {
  const LIVE_PORT = 9402;
  let liveView: LiveView;
  let serverWithLive: ReturnType<typeof buildServer>;

  beforeAll(async () => {
    liveView = new LiveView(driver, { secret: 'test-secret' });
    await liveView.start(LIVE_PORT);
    serverWithLive = buildServer({
      perception: new Perception(driver, new ArtifactStore(mkdtempSync(join(tmpdir(), 'scry-'))), 8000),
      action: new Action(driver),
      network: new Network(driver, new ArtifactStore(mkdtempSync(join(tmpdir(), 'scry-')))),
      liveView,
    });
  });

  afterAll(async () => {
    await liveView.stop();
  });

  it('registers live_start/live_mode/live_stop', () => {
    const names = serverWithLive.listToolNames();
    expect(names).toContain('live_start');
    expect(names).toContain('live_mode');
    expect(names).toContain('live_stop');
  });

  it('live_start returns a signed #token URL for the live view', async () => {
    const out = await serverWithLive.callTool('live_start', {});
    expect(out.split('\n')[0]).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${LIVE_PORT}/#token=\\d+\\.[0-9a-f]+$`));
    expect(out).toMatch(/adresse nue/); // bare url works on paired devices
  });

  it('action tools wait while the viewer has paused Claude; navigate/act resume on unpause', async () => {
    liveView.setPaused(true);
    let done = false;
    const p = serverWithLive.callTool('scroll', { dir: 'down', amount: 10 }).then(() => { done = true; });
    await new Promise((r) => setTimeout(r, 300));
    expect(done).toBe(false);
    liveView.setPaused(false);
    await p;
    expect(done).toBe(true);
  });

  it('ask_approval returns a clear verdict, and says so when nobody is watching', async () => {
    expect(serverWithLive.listToolNames()).toContain('ask_approval');
    const out = await serverWithLive.callTool('ask_approval', { question: 'Payer ?', timeoutSec: 1 });
    expect(out).toMatch(/aucun spectateur/i);
    expect(out).toMatch(/#token=/); // the link to hand to William
  });

  it('inbox items are appended to the next tool result, and the inbox tool waits for them', async () => {
    liveView.pushInbox('William dit : test-inbox');
    const out = await serverWithLive.callTool('state', {});
    expect(out).toMatch(/\[william\] William dit : test-inbox/);
    expect(await serverWithLive.callTool('state', {})).not.toMatch(/william/);
    expect(serverWithLive.listToolNames()).toContain('inbox');
    expect(await serverWithLive.callTool('inbox', { waitSec: 1 })).toMatch(/rien/);
  });

  it('live_mode flips the LiveView mode', async () => {
    expect(liveView.getMode()).toBe('read');
    await serverWithLive.callTool('live_mode', { mode: 'input' });
    expect(liveView.getMode()).toBe('input');
    await serverWithLive.callTool('live_mode', { mode: 'read' });
    expect(liveView.getMode()).toBe('read');
  });

  it('suspends perception (snapshot/find/read/screenshot) while in input mode, resumes in read (M4, Spec §5.8)', async () => {
    await serverWithLive.callTool('live_mode', { mode: 'input' });
    for (const [name, args] of [['snapshot', {}], ['find', { query: 'x' }], ['read', {}], ['screenshot', {}]] as const) {
      await expect(serverWithLive.callTool(name, args)).rejects.toThrow(/perception suspendue \(spec §5\.8\)/);
    }
    // Back in read mode, perception works again — the gate is dynamic.
    await serverWithLive.callTool('live_mode', { mode: 'read' });
    expect(await serverWithLive.callTool('snapshot', {})).toMatch(/^\[state\] url=/);
  });

  it('live_stop tears down its live view (no leaked sessions)', async () => {
    // Scoped to its own LiveView/port so stopping it doesn't affect the
    // shared instance the other tests in this block still use.
    const lv = new LiveView(driver, { secret: 'test-secret-2' });
    await lv.start(9403);
    const s = buildServer({
      perception: new Perception(driver, new ArtifactStore(mkdtempSync(join(tmpdir(), 'scry-'))), 8000),
      action: new Action(driver),
      network: new Network(driver, new ArtifactStore(mkdtempSync(join(tmpdir(), 'scry-')))),
      liveView: lv,
    });
    await s.callTool('live_stop', {});
    expect(lv.sessionCount()).toBe(0);
  });
});
