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
});
