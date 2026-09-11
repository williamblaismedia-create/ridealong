import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBrowser } from './helpers.js';
import { Driver } from '../src/driver.js';
import { ArtifactStore } from '../src/artifact-store.js';
import { Perception } from '../src/perception.js';
import { Action } from '../src/action.js';

let env: Awaited<ReturnType<typeof startBrowser>>;
let driver: Driver;
let per: Perception;
beforeAll(async () => {
  env = await startBrowser();
  driver = await Driver.connect(env.cdpUrl, { viewport: { width: 1440, height: 900 }, defaultTimeoutMs: 15000 });
  const store = new ArtifactStore(mkdtempSync(join(tmpdir(), 'scry-')));
  per = new Perception(driver, store, 8000);
  await driver.navigate(env.pageUrl); await driver.waitReady();
});
afterAll(async () => { await driver.close(); await env.stop(); });

describe('Perception', () => {
  it('state() reports url, title, ready', async () => {
    const s = await per.state();
    expect(s.title).toBe('Scry Fixture');
    expect(s.url).toBe(env.pageUrl);
    expect(s.ready).toBe(true);
  });

  it('find() returns refs matching a query', async () => {
    const hits = await per.find('Go');
    expect(hits.some((n) => n.role === 'button' && n.name === 'Go')).toBe(true);
  });

  it('read() truncates to budget and spills full text to disk', async () => {
    const r = await per.read({ budget: 20 });
    expect(r.text.length).toBeLessThanOrEqual(20);
    expect(r.truncated).toBe(true);
    expect(r.path).toBeTruthy();
  });

  it('snapshot() truncates to budget and spills the full tree to disk', async () => {
    const small = await per.snapshot({ budget: 10 });
    expect(small.text.length).toBeLessThanOrEqual(10);
    expect(small.truncated).toBe(true);
    expect(small.path).toBeTruthy();
    expect(small.nodes.length).toBeGreaterThan(0);
    const big = await per.snapshot({ budget: 8000 });
    expect(big.truncated).toBe(false);
    expect(big.path).toBeUndefined();
    expect(big.text).toContain('button "Go"');
  });

  it('diff() reports the appended list item after a click', async () => {
    await per.snapshot();
    await driver.page().locator('#go').click();
    const d = await per.diff();
    expect(d.added.some((n) => n.name === 'gamma')).toBe(true);
  });

  it('screenshot() writes a file and returns its path', async () => {
    const s = await per.screenshot();
    expect(s.path).toMatch(/\.jpg$/);
  });

  it('act() resolves an originally-captured ref even after the DOM shifts above it', async () => {
    // Reset to a clean fixture so earlier tests' mutations don't skew ref numbering.
    await driver.navigate(env.pageUrl); await driver.waitReady();
    const wired = new Action(driver, (ref) => per.resolveRefNode(ref));
    const snap = await per.snapshot();
    const go = snap.nodes.find((n) => n.role === 'button' && n.name === 'Go')!;
    // Prepend a NEW button before #go: a fresh re-enumeration would renumber refs,
    // so the captured "Go" ref would denote this intruder instead. Resolving against
    // the captured registry must still target the real Go button.
    await driver.page().evaluate(() => {
      const b = document.createElement('button');
      b.textContent = 'Intrus';
      document.body.insertBefore(b, document.getElementById('go'));
    });
    await wired.act(go.ref, 'click');
    // #go's handler sets status to 'done'; the intruder has no handler.
    expect(await driver.page().locator('#status').textContent()).toBe('done');
  });
});
