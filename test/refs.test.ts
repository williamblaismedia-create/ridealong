import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startBrowser } from './helpers.js';
import { Driver } from '../src/driver.js';
import { snapshotWithRefs, resolveRef } from '../src/refs.js';

let env: Awaited<ReturnType<typeof startBrowser>>;
let driver: Driver;
beforeAll(async () => {
  env = await startBrowser();
  driver = await Driver.connect(env.cdpUrl, { viewport: { width: 1440, height: 900 }, defaultTimeoutMs: 15000 });
  await driver.navigate(env.pageUrl); await driver.waitReady();
});
afterAll(async () => { await driver.close(); await env.stop(); });

describe('refs', () => {
  it('assigns a ref to the button and to the heading', async () => {
    const { nodes, text } = await snapshotWithRefs(driver.page());
    const button = nodes.find((n) => n.role === 'button' && n.name === 'Go');
    const heading = nodes.find((n) => n.role === 'heading' && n.name === 'Scry Fixture');
    expect(button).toBeTruthy();
    expect(heading).toBeTruthy();
    expect(button!.ref).toMatch(/^e\d+$/);
    expect(text).toContain('button "Go"');
  });

  it('resolves a ref back to a clickable element', async () => {
    const { nodes } = await snapshotWithRefs(driver.page());
    const button = nodes.find((n) => n.role === 'button' && n.name === 'Go')!;
    const loc = resolveRef(driver.page(), button);
    await loc.click();
    expect(await driver.page().locator('#status').textContent()).toBe('done');
  });
});
