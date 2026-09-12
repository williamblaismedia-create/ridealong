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
  it('setViewport resizes the current page, applies to later targets, and emits "viewport"', async () => {
    const seen: any[] = [];
    driver.on('viewport', (v) => seen.push(v));
    await driver.setViewport({ width: 1280, height: 720 });
    expect(driver.page().viewportSize()).toEqual({ width: 1280, height: 720 });
    expect(seen.at(-1)).toEqual({ width: 1280, height: 720 });
    const p = await driver.context().newPage();
    driver.setPage(p);
    await new Promise((r) => setTimeout(r, 200));
    expect(p.viewportSize()).toEqual({ width: 1280, height: 720 });
    driver.setPage(driver.context().pages()[0]);
    await p.close();
    await driver.setViewport({ width: 1440, height: 900 });
  });

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
    // dialogOpen must reflect the CURRENT state: after the auto-dismiss settles it is
    // false again — it must not stick to true forever after the first dialog.
    await new Promise((r) => setTimeout(r, 0));
    expect(driver.isDialogOpen()).toBe(false);
  });
});
