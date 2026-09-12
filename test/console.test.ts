import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBrowser } from './helpers.js';
import { Driver } from '../src/driver.js';
import { PageLog } from '../src/console.js';
import { ArtifactStore } from '../src/artifact-store.js';
import { Perception } from '../src/perception.js';
import { Action } from '../src/action.js';
import { Network } from '../src/network.js';
import { buildServer } from '../src/server.js';

let env: Awaited<ReturnType<typeof startBrowser>>;
let driver: Driver; let log: PageLog;
beforeAll(async () => {
  env = await startBrowser();
  driver = await Driver.connect(env.cdpUrl, { viewport: { width: 1440, height: 900 }, defaultTimeoutMs: 15000 });
  log = new PageLog(driver); log.start();
  await driver.navigate(env.pageUrl); await driver.waitReady();
});
afterAll(async () => { await driver.close(); await env.stop(); });

describe('PageLog / console_errors', () => {
  it('captures console.error, an uncaught exception and an HTTP 404 from the target page', async () => {
    await driver.page().click('#err');
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && log.entries().length < 3) await new Promise((r) => setTimeout(r, 100));
    const kinds = log.entries().map((e) => e.kind);
    expect(kinds).toContain('console.error');
    expect(kinds).toContain('pageerror');
    expect(kinds).toContain('http');
    const txt = log.format();
    expect(txt).toContain('boom-console');
    expect(txt).toContain('boom-page');
    expect(txt).toMatch(/404 GET/);
  });

  it('keeps following the target after a tab switch', async () => {
    const p = await driver.context().newPage();
    driver.setPage(p);
    try {
      await p.goto(`${env.pageUrl}missing-tab`).catch(() => {});
      await new Promise((r) => setTimeout(r, 300));
      expect(log.entries().some((e) => e.kind === 'http' && e.url?.includes('missing-tab'))).toBe(true);
    } finally { driver.setPage(driver.context().pages()[0]); await p.close(); }
  });

  it('the server exposes console_errors (with clear) and diff', async () => {
    const store = new ArtifactStore(mkdtempSync(join(tmpdir(), 'scry-')));
    const perception = new Perception(driver, store, 8000);
    const server = buildServer({ perception, action: new Action(driver), network: new Network(driver, store), pageLog: log });
    expect(server.listToolNames()).toContain('console_errors');
    expect(server.listToolNames()).toContain('diff');
    const out = await server.callTool('console_errors', { clear: true });
    expect(out).toContain('boom-console');
    expect(await server.callTool('console_errors', {})).toMatch(/rien/);
    await server.callTool('snapshot', {});
    await driver.page().evaluate(() => { const li = document.createElement('li'); li.textContent = 'delta-item'; document.getElementById('list')!.appendChild(li); });
    const d = await server.callTool('diff', {});
    expect(d).toMatch(/apparus \(1\)/);
    expect(d).toContain('delta-item');
  });
});
