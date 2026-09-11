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
import { Tabs } from '../src/tabs.js';

let env: Awaited<ReturnType<typeof startBrowser>>;
let driver: Driver;

beforeAll(async () => {
  env = await startBrowser();
  driver = await Driver.connect(env.cdpUrl, { viewport: { width: 1440, height: 900 }, defaultTimeoutMs: 15000 });
  await driver.navigate(env.pageUrl); await driver.waitReady();
});
afterAll(async () => { await driver.close(); await env.stop(); });

describe('Tabs', () => {
  it('opens a second tab, lists both, selects one active, then closes back to one', async () => {
    const tabs = new Tabs(driver);
    const id = await tabs.open(env.pageUrl);
    expect(id).toBe(1);
    expect((await tabs.list()).length).toBe(2);

    await tabs.select(0);
    expect((await tabs.list())[0].active).toBe(true);

    await tabs.close(1);
    expect((await tabs.list()).length).toBe(1);
  });

  it('guards out-of-range ids on close/select', async () => {
    const tabs = new Tabs(driver);
    await expect(tabs.close(99)).rejects.toThrow(/onglet 99 inexistant/);
    await expect(tabs.select(99)).rejects.toThrow(/onglet 99 inexistant/);
  });
});

describe('buildServer multi-tab tools', () => {
  it('registers tabs_list, tabs_open, tabs_close, tabs_select', () => {
    const store = new ArtifactStore(mkdtempSync(join(tmpdir(), 'scry-')));
    const perception = new Perception(driver, store, 8000);
    const action = new Action(driver, (ref) => perception.resolveRefNode(ref));
    const server = buildServer({ perception, action, network: new Network(driver, store) });
    const names = server.listToolNames();
    for (const t of ['tabs_list', 'tabs_open', 'tabs_close', 'tabs_select']) {
      expect(names).toContain(t);
    }
  });
});
