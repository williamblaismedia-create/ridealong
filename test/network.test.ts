import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBrowser } from './helpers.js';
import { Driver } from '../src/driver.js';
import { ArtifactStore } from '../src/artifact-store.js';
import { Network } from '../src/network.js';

let env: Awaited<ReturnType<typeof startBrowser>>;
let driver: Driver; let net: Network;
beforeAll(async () => {
  env = await startBrowser();
  driver = await Driver.connect(env.cdpUrl, { viewport: { width: 1440, height: 900 }, defaultTimeoutMs: 15000 });
  net = new Network(driver, new ArtifactStore(mkdtempSync(join(tmpdir(), 'scry-'))));
  net.start();
  await driver.navigate(env.pageUrl); await driver.waitReady();
});
afterAll(async () => { await driver.close(); await env.stop(); });

describe('Network', () => {
  it('keeps recording after the target moves to another tab', async () => {
    const p = await driver.context().newPage();
    driver.setPage(p);
    try {
      await p.goto(`${env.pageUrl}?t=net`, { waitUntil: 'domcontentloaded' });
      expect(net.requests('t=net').some((r) => r.status === 200)).toBe(true);
    } finally {
      driver.setPage(driver.context().pages()[0]);
      await p.close();
    }
  });

  it('records the document request', () => {
    const reqs = net.requests();
    expect(reqs.some((r) => r.url === env.pageUrl && r.status === 200)).toBe(true);
  });

  it('fetchWithSession stores the fetched body and returns a path', async () => {
    const r = await net.fetchWithSession(env.pageUrl);
    expect(r.path).toBeTruthy();
    expect(r.summary).toContain('octets');
  });
});
