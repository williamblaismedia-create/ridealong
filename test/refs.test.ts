import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBrowser } from './helpers.js';
import { Driver } from '../src/driver.js';
import { ArtifactStore } from '../src/artifact-store.js';
import { Perception } from '../src/perception.js';
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

  it('never leaks a filled password value — absent from the snapshot text AND the spilled artifact (M4, Spec §5.8)', async () => {
    const SECRET = 'hunter2-SECRET-xyz';
    // Both an UNLABELLED password field (renders as `- textbox: <value>`, the
    // colon-value path) and a LABELLED one (renders as `- textbox "Pass": …`).
    // Playwright 1.63 renders the value in aria-snapshot for both — the parser
    // must drop it either way.
    await driver.page().setContent(
      `<input id="p1" type="password">` +
      `<label>Pass <input id="p2" type="password"></label>`,
    );
    await driver.page().locator('#p1').fill(SECRET);
    await driver.page().locator('#p2').fill(SECRET);

    const { text, nodes } = await snapshotWithRefs(driver.page());
    expect(text).not.toContain(SECRET);
    expect(nodes.some((n) => n.name.includes(SECRET))).toBe(false);

    // The full tree spilled to disk (what Claude could later read back) must
    // not contain it either. Force truncation so an artifact is written.
    const store = new ArtifactStore(mkdtempSync(join(tmpdir(), 'scry-pwd-')));
    const per = new Perception(driver, store, 8000);
    const snap = await per.snapshot({ budget: 1 });
    expect(snap.truncated).toBe(true);
    const spilled = (await store.read(snap.path!)).toString('utf8');
    expect(spilled).not.toContain(SECRET);
  });
});
