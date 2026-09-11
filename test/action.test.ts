import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startBrowser } from './helpers.js';
import { Driver } from '../src/driver.js';
import { snapshotWithRefs } from '../src/refs.js';
import { Action } from '../src/action.js';

let env: Awaited<ReturnType<typeof startBrowser>>;
let driver: Driver; let action: Action;
beforeAll(async () => {
  env = await startBrowser();
  driver = await Driver.connect(env.cdpUrl, { viewport: { width: 1440, height: 900 }, defaultTimeoutMs: 15000 });
  action = new Action(driver);
  await driver.navigate(env.pageUrl); await driver.waitReady();
});
afterAll(async () => { await driver.close(); await env.stop(); });

describe('Action', () => {
  it('clicks a button by ref', async () => {
    const { nodes } = await snapshotWithRefs(driver.page());
    const go = nodes.find((n) => n.role === 'button' && n.name === 'Go')!;
    await action.act(go.ref, 'click');
    expect(await driver.page().locator('#status').textContent()).toBe('done');
  });

  it('types into a field by ref', async () => {
    const { nodes } = await snapshotWithRefs(driver.page());
    const input = nodes.find((n) => n.role === 'textbox' && n.name === 'Your name')!;
    await action.act(input.ref, 'type', 'Ada');
    expect(await driver.page().locator('#name').inputValue()).toBe('Ada');
  });

  it('rejects an unknown verb', async () => {
    const { nodes } = await snapshotWithRefs(driver.page());
    const go = nodes.find((n) => n.role === 'button' && n.name === 'Go')!;
    await expect(action.act(go.ref, 'bogus' as any)).rejects.toThrow(/verbe inconnu/);
  });
});
