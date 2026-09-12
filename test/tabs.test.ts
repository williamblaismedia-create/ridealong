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

  it('keeps the right tab active by identity when a lower-indexed tab is closed and indices shift', async () => {
    const tabs = new Tabs(driver);
    const urlA = `${env.pageUrl}?t=a`;
    const urlB = `${env.pageUrl}?t=b`;
    const idA = await tabs.open(urlA); // primary=0, so idA===1
    const idB = await tabs.open(urlB); // idB===2
    await tabs.select(idB);

    const before = await tabs.list();
    expect(before.length).toBe(3);
    expect(before.find((t) => t.url === urlB)?.active).toBe(true);

    // idA < idB: closing it shifts idB's tab down to numeric index 1.
    await tabs.close(idA);

    const after = await tabs.list();
    expect(after.length).toBe(2);
    const stillActive = after.find((t) => t.active);
    expect(stillActive?.url).toBe(urlB);
  });

  // Earlier tests may leave extra tabs behind: reduce to one first.
  async function onlyOne(tabs: Tabs): Promise<void> {
    while ((await tabs.list()).length > 1) {
      const l = await tabs.list();
      await tabs.close(l[l.length - 1].id);
    }
    await tabs.select(0);
  }

  it('refuses to close the last remaining tab', async () => {
    const tabs = new Tabs(driver);
    await onlyOne(tabs);
    expect((await tabs.list()).length).toBe(1);
    await expect(tabs.close(0)).rejects.toThrow(/dernier onglet/);
  });

  // The TARGET moves: perception, action and the live view follow the tab
  // that tabs_select / tabs_open chose (v1 was pinned to the first tab).
  it('select/open move the driver target; closing the target falls back to a neighbour', async () => {
    const tabs = new Tabs(driver);
    await onlyOne(tabs);
    const urlB = `${env.pageUrl}?t=b`;
    const idB = await tabs.open(urlB);
    expect(driver.page().url()).toBe(urlB);            // open -> target
    await tabs.select(0);
    expect(driver.page()).toBe(driver.context().pages()[0]); // select -> target
    await tabs.select(idB);
    expect(driver.page().url()).toBe(urlB);
    await tabs.close(idB);                              // closing the target
    expect(driver.page()).toBe(driver.context().pages()[0]);
    expect((await tabs.list()).find((x) => x.active)?.id).toBe(0);
  });

  it('driver.setPage emits a "page" event that dependents (network, live view) hook', async () => {
    const tabs = new Tabs(driver);
    const seen: import('playwright').Page[] = [];
    driver.on('page', (p) => seen.push(p));
    const id = await tabs.open(`${env.pageUrl}?t=ev`);
    // Emitted BEFORE the navigation (so network capture sees the document
    // request): the event carries the new target, whose url lands afterwards.
    expect(seen.at(-1)).toBe(driver.page());
    expect(driver.page().url()).toContain('t=ev');
    await tabs.close(id);
    expect(seen.length).toBeGreaterThanOrEqual(2);
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
