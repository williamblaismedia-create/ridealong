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

  it('live_start returns a signed URL for the live view', async () => {
    const out = await serverWithLive.callTool('live_start', {});
    expect(out).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${LIVE_PORT}/\\?token=\\d+\\.[0-9a-f]+$`));
  });

  it('live_mode flips the LiveView mode', async () => {
    expect(liveView.getMode()).toBe('read');
    await serverWithLive.callTool('live_mode', { mode: 'input' });
    expect(liveView.getMode()).toBe('input');
    await serverWithLive.callTool('live_mode', { mode: 'read' });
    expect(liveView.getMode()).toBe('read');
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
