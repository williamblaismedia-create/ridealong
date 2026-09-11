import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startBrowser } from './helpers.js';
import { Driver } from '../src/driver.js';

let env: Awaited<ReturnType<typeof startBrowser>>;
let driver: Driver;

beforeAll(async () => {
  env = await startBrowser();
  driver = await Driver.connect(env.cdpUrl, { viewport: { width: 1440, height: 900 }, defaultTimeoutMs: 15000 });
});
afterAll(async () => { await driver.close(); await env.stop(); });

describe('Driver', () => {
  it('navigates and reads the title via evaluate', async () => {
    await driver.navigate(env.pageUrl);
    await driver.waitReady();
    const title = await driver.evaluate(() => document.title);
    expect(title).toBe('Scry Fixture');
  });

  it('produces a non-empty screenshot buffer', async () => {
    const png = await driver.screenshot();
    expect(png.length).toBeGreaterThan(1000);
  });

  it('auto-dismisses a native dialog without hanging and records it', async () => {
    await driver.navigate(env.pageUrl);
    await driver.waitReady();
    // The Driver's page.on('dialog') handler dismisses the dialog, so this evaluate resolves instead of hanging.
    await driver.evaluate(() => { alert('boom'); });
    expect(driver.dialogWasHandled()).toBe(true);
  });
});
