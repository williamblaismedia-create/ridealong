# Scry — Cœur de perception et d'action — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Scry core — an MCP server that gives Claude structured perception and by-reference action on a Chrome reachable over CDP, keeping large payloads off Claude's context.

**Architecture:** A TypeScript/Node MCP server wraps a single Playwright `Page` obtained with `chromium.connectOverCDP(cdpUrl)`. Focused modules — `config`, `artifact-store`, `driver`, `refs`, `perception`, `action`, `network`, `server` — each with one responsibility. Tool outputs are short by default (summary + a state header); anything large (full DOM, response bodies, screenshots) is written to `~/scry-donnees/artifacts/` and only its path + a compact summary is returned.

**Tech Stack:** Node ≥ 20, TypeScript (ESM), Playwright, `@modelcontextprotocol/sdk`, vitest.

**Spec:** `docs/specs/2026-09-11-scry-design.md`

## Global Constraints

- **Session, jamais mot de passe.** Aucun code de ce plan ne saisit, lit ou stocke un mot de passe. (Spec §2, §9)
- **Données hors dépôt.** Tout artefact et toute donnée d'exécution vont sous `SCRY_DATA_DIR` (défaut `~/scry-donnees`), jamais dans l'arbre git. (Spec §10)
- **Endpoint CDP local seulement.** Défaut `http://127.0.0.1:9222` ; jamais exposé au réseau. (Spec §5.1, §10)
- **Sortie courte par défaut.** Chaque outil renvoie un résumé + un entête d'état ; le volumineux part sur disque, seul le chemin revient. (Spec §7)
- **Viewport fixe et attentes déterministes.** Pas de `sleep` aveugle ; dimensions verrouillées. (Spec §8)
- **Langage :** TypeScript ESM, `"type": "module"`, cible Node 20.

---

## File Structure

```
scry/
  package.json            # deps, scripts, ESM
  tsconfig.json           # TS config, NodeNext
  vitest.config.ts        # test runner
  .env.example            # SCRY_CDP_URL, SCRY_DATA_DIR, viewport, timeouts
  src/
    config.ts             # env -> Config
    artifact-store.ts     # save(kind, bytes, ext) -> {path, bytes, summary}; read(path)
    driver.ts             # connectOverCDP, page, navigate, waitReady, screenshot, evaluate, dialogs, close
    refs.ts               # snapshotWithRefs(page) -> {nodes, text}; resolveRef(page, node) -> Locator
    perception.ts         # snapshot, state, find, read (budget), diff, screenshot
    action.ts             # act(ref, verb, text?), fill, scroll
    network.ts            # start, requests(filter), readResponse(match), fetchWithSession(url)
    server.ts             # MCP server: registers tools, wires modules, formats output
  test/
    fixtures/page.html    # deterministic local test page
    helpers.ts            # launch a debug Chrome + serve the fixture; return {cdpUrl, pageUrl, stop}
    config.test.ts
    artifact-store.test.ts
    driver.test.ts
    refs.test.ts
    perception.test.ts
    action.test.ts
    network.test.ts
    server.test.ts
```

Shared types (declared in the module that owns them, imported elsewhere):

```typescript
// config.ts
export interface Config {
  cdpUrl: string;
  dataDir: string;
  viewport: { width: number; height: number };
  defaultTimeoutMs: number;
  readBudgetChars: number;
}

// refs.ts
export interface RefNode { ref: string; role: string; name: string; level: number; nth: number; }

// perception.ts
export interface StateHeader { url: string; title: string; viewport: { width: number; height: number }; ready: boolean; dialogOpen: boolean; }
export interface Delta { added: RefNode[]; removed: RefNode[]; changedText: { ref: string; from: string; to: string }[]; }
```

---

## Task 1: Scaffolding and config

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.env.example`, `src/config.ts`
- Test: `test/config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `loadConfig(env?: NodeJS.ProcessEnv): Config` and the `Config` interface (see File Structure).

- [ ] **Step 1: Write `package.json`, `tsconfig.json`, `vitest.config.ts`, `.env.example`**

`package.json`:
```json
{
  "name": "scry",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "engines": { "node": ">=20" },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "playwright": "^1.47.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": ".",
    "declaration": true
  },
  "include": ["src", "test"]
}
```

`vitest.config.ts`:
```typescript
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'node', testTimeout: 30000, hookTimeout: 30000 } });
```

`.env.example`:
```
SCRY_CDP_URL=http://127.0.0.1:9222
SCRY_DATA_DIR=~/scry-donnees
SCRY_VIEWPORT_WIDTH=1440
SCRY_VIEWPORT_HEIGHT=900
SCRY_DEFAULT_TIMEOUT_MS=15000
SCRY_READ_BUDGET_CHARS=8000
```

- [ ] **Step 2: Write the failing test**

`test/config.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { homedir } from 'node:os';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('applies defaults when env is empty', () => {
    const c = loadConfig({});
    expect(c.cdpUrl).toBe('http://127.0.0.1:9222');
    expect(c.viewport).toEqual({ width: 1440, height: 900 });
    expect(c.defaultTimeoutMs).toBe(15000);
    expect(c.readBudgetChars).toBe(8000);
    expect(c.dataDir).toBe(`${homedir()}/scry-donnees`);
  });

  it('expands a leading ~ in dataDir and reads overrides', () => {
    const c = loadConfig({ SCRY_DATA_DIR: '~/ailleurs', SCRY_VIEWPORT_WIDTH: '1280', SCRY_CDP_URL: 'http://127.0.0.1:9333' });
    expect(c.dataDir).toBe(`${homedir()}/ailleurs`);
    expect(c.viewport.width).toBe(1280);
    expect(c.cdpUrl).toBe('http://127.0.0.1:9333');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- config`
Expected: FAIL — cannot find `../src/config.js`.

- [ ] **Step 4: Write `src/config.ts`**

```typescript
import { homedir } from 'node:os';

export interface Config {
  cdpUrl: string;
  dataDir: string;
  viewport: { width: number; height: number };
  defaultTimeoutMs: number;
  readBudgetChars: number;
}

function expandHome(p: string): string {
  return p.startsWith('~') ? p.replace(/^~/, homedir()) : p;
}

function intOr(v: string | undefined, dflt: number): number {
  const n = v ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : dflt;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    cdpUrl: env.SCRY_CDP_URL ?? 'http://127.0.0.1:9222',
    dataDir: expandHome(env.SCRY_DATA_DIR ?? '~/scry-donnees'),
    viewport: {
      width: intOr(env.SCRY_VIEWPORT_WIDTH, 1440),
      height: intOr(env.SCRY_VIEWPORT_HEIGHT, 900),
    },
    defaultTimeoutMs: intOr(env.SCRY_DEFAULT_TIMEOUT_MS, 15000),
    readBudgetChars: intOr(env.SCRY_READ_BUDGET_CHARS, 8000),
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm install` then `npm test -- config`
Expected: PASS (both tests).

- [ ] **Step 6: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts .env.example src/config.ts test/config.test.ts
git commit -m "feat(config): env-driven Config with defaults and ~ expansion"
```

---

## Task 2: Artifact store

**Files:**
- Create: `src/artifact-store.ts`
- Test: `test/artifact-store.test.ts`

**Interfaces:**
- Consumes: `Config.dataDir`.
- Produces: `class ArtifactStore { constructor(dataDir: string); save(kind: string, bytes: Buffer | string, ext: string): Promise<{ path: string; bytes: number; summary: string }>; read(path: string): Promise<Buffer> }`. Files land in `${dataDir}/artifacts/${kind}-${hash8}.${ext}`.

- [ ] **Step 1: Write the failing test**

`test/artifact-store.test.ts`:
```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore } from '../src/artifact-store.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'scry-')); });

describe('ArtifactStore', () => {
  it('saves bytes under artifacts/ and returns path + size + summary', async () => {
    const store = new ArtifactStore(dir);
    const r = await store.save('dom', '<html>hi</html>', 'html');
    expect(r.path.startsWith(join(dir, 'artifacts'))).toBe(true);
    expect(r.path.endsWith('.html')).toBe(true);
    expect(r.bytes).toBe(15);
    expect(existsSync(r.path)).toBe(true);
    expect(readFileSync(r.path, 'utf8')).toBe('<html>hi</html>');
    expect(r.summary).toContain('15');
  });

  it('reads back what it saved', async () => {
    const store = new ArtifactStore(dir);
    const r = await store.save('img', Buffer.from([1, 2, 3]), 'png');
    const back = await store.read(r.path);
    expect([...back]).toEqual([1, 2, 3]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- artifact-store`
Expected: FAIL — cannot find `../src/artifact-store.js`.

- [ ] **Step 3: Write `src/artifact-store.ts`**

```typescript
import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export class ArtifactStore {
  constructor(private dataDir: string) {}

  async save(kind: string, bytes: Buffer | string, ext: string): Promise<{ path: string; bytes: number; summary: string }> {
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'utf8');
    const hash = createHash('sha1').update(buf).digest('hex').slice(0, 8);
    const dir = join(this.dataDir, 'artifacts');
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${kind}-${hash}.${ext}`);
    await writeFile(path, buf);
    return { path, bytes: buf.length, summary: `${kind} ${buf.length} octets -> ${path}` };
  }

  async read(path: string): Promise<Buffer> {
    return readFile(path);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- artifact-store`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/artifact-store.ts test/artifact-store.test.ts
git commit -m "feat(artifact-store): save/read artifacts under dataDir, return path+summary"
```

---

## Task 3: Browser harness and driver

**Files:**
- Create: `test/fixtures/page.html`, `test/helpers.ts`, `src/driver.ts`
- Test: `test/driver.test.ts`

**Interfaces:**
- Consumes: `Config` (cdpUrl, viewport, defaultTimeoutMs).
- Produces:
  - `test/helpers.ts`: `startBrowser(): Promise<{ cdpUrl: string; pageUrl: string; stop: () => Promise<void> }>` — launches a Chromium with a fixed debug port and serves `fixtures/page.html`.
  - `src/driver.ts`: `class Driver { static connect(cdpUrl: string, opts: { viewport: {width:number;height:number}; defaultTimeoutMs: number }): Promise<Driver>; page(): Page; navigate(url: string): Promise<void>; waitReady(): Promise<void>; screenshot(opts?: { fullPage?: boolean }): Promise<Buffer>; evaluate<T>(fn: string | ((...a:any[])=>T), arg?: any): Promise<T>; dialogWasHandled(): boolean; close(): Promise<void> }`.

- [ ] **Step 1: Write the fixture page**

`test/fixtures/page.html`:
```html
<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Scry Fixture</title></head>
<body>
  <h1>Scry Fixture</h1>
  <button id="go">Go</button>
  <input id="name" aria-label="Your name" />
  <p id="status">idle</p>
  <ul id="list"><li>alpha</li><li>beta</li></ul>
  <script>
    document.getElementById('go').addEventListener('click', () => {
      document.getElementById('status').textContent = 'done';
      const li = document.createElement('li'); li.textContent = 'gamma';
      document.getElementById('list').appendChild(li);
    });
  </script>
</body></html>
```

- [ ] **Step 2: Write the test harness**

`test/helpers.ts`:
```typescript
import { chromium, type Browser } from 'playwright';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const DEBUG_PORT = 9333;

export async function startBrowser(): Promise<{ cdpUrl: string; pageUrl: string; stop: () => Promise<void> }> {
  const html = readFileSync(join(here, 'fixtures', 'page.html'), 'utf8');
  const server: Server = createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end(html); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as any).port;
  const pageUrl = `http://127.0.0.1:${port}/`;
  const browser: Browser = await chromium.launch({ args: [`--remote-debugging-port=${DEBUG_PORT}`, '--remote-debugging-address=127.0.0.1'] });
  const cdpUrl = `http://127.0.0.1:${DEBUG_PORT}`;
  return {
    cdpUrl,
    pageUrl,
    stop: async () => { await browser.close(); await new Promise<void>((r) => server.close(() => r())); },
  };
}
```

- [ ] **Step 3: Write the failing test**

`test/driver.test.ts`:
```typescript
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
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npm test -- driver`
Expected: FAIL — cannot find `../src/driver.js`.

- [ ] **Step 5: Write `src/driver.ts`**

```typescript
import { chromium, type Browser, type Page } from 'playwright';

export class Driver {
  private dialogHandled = false;

  private constructor(private browser: Browser, private _page: Page) {}

  static async connect(cdpUrl: string, opts: { viewport: { width: number; height: number }; defaultTimeoutMs: number }): Promise<Driver> {
    const browser = await chromium.connectOverCDP(cdpUrl);
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = context.pages()[0] ?? (await context.newPage());
    await page.setViewportSize(opts.viewport);
    page.setDefaultTimeout(opts.defaultTimeoutMs);
    const driver = new Driver(browser, page);
    // Native dialogs must never freeze the session: auto-dismiss, record that one appeared.
    page.on('dialog', async (d) => { driver.dialogHandled = true; await d.dismiss().catch(() => {}); });
    return driver;
  }

  page(): Page { return this._page; }

  async navigate(url: string): Promise<void> {
    await this._page.goto(url, { waitUntil: 'domcontentloaded' });
  }

  async waitReady(): Promise<void> {
    await this._page.waitForLoadState('networkidle').catch(() => {});
  }

  async screenshot(opts: { fullPage?: boolean } = {}): Promise<Buffer> {
    return this._page.screenshot({ fullPage: opts.fullPage ?? false, type: 'jpeg', quality: 80 });
  }

  async evaluate<T>(fn: string | ((...a: any[]) => T), arg?: any): Promise<T> {
    return this._page.evaluate(fn as any, arg);
  }

  dialogWasHandled(): boolean { return this.dialogHandled; }

  async close(): Promise<void> { await this.browser.close(); }
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx playwright install chromium` then `npm test -- driver`
Expected: PASS (both tests).

- [ ] **Step 7: Commit**

```bash
git add test/fixtures/page.html test/helpers.ts src/driver.ts test/driver.test.ts
git commit -m "feat(driver): connectOverCDP wrapper with navigate/waitReady/screenshot/evaluate + dialog auto-dismiss"
```

---

## Task 4: References (snapshot with refs, resolve)

**Files:**
- Create: `src/refs.ts`
- Test: `test/refs.test.ts`

**Interfaces:**
- Consumes: a Playwright `Page` (from `Driver.page()`).
- Produces:
  - `interface RefNode { ref: string; role: string; name: string; level: number; nth: number }`
  - `snapshotWithRefs(page: Page): Promise<{ nodes: RefNode[]; text: string }>` — walks `page.accessibility.snapshot`, assigns `ref` = `e1, e2, …`, and `nth` = index among same role+name.
  - `resolveRef(page: Page, node: RefNode): import('playwright').Locator` — `page.getByRole(role, { name, exact: true }).nth(node.nth)`.

- [ ] **Step 1: Write the failing test**

`test/refs.test.ts`:
```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- refs`
Expected: FAIL — cannot find `../src/refs.js`.

- [ ] **Step 3: Write `src/refs.ts`**

```typescript
import type { Page, Locator } from 'playwright';

export interface RefNode { ref: string; role: string; name: string; level: number; nth: number }

interface AxNode { role?: string; name?: string; children?: AxNode[] }

export async function snapshotWithRefs(page: Page): Promise<{ nodes: RefNode[]; text: string }> {
  const root = (await page.accessibility.snapshot({ interestingOnly: true })) as AxNode | null;
  const nodes: RefNode[] = [];
  const lines: string[] = [];
  const counter = new Map<string, number>();
  let seq = 0;

  const walk = (node: AxNode | null, level: number) => {
    if (!node) return;
    const role = node.role ?? '';
    const name = node.name ?? '';
    if (role && role !== 'WebArea' && role !== 'RootWebArea') {
      const key = `${role} ${name}`;
      const nth = counter.get(key) ?? 0;
      counter.set(key, nth + 1);
      const ref = `e${++seq}`;
      nodes.push({ ref, role, name, level, nth });
      lines.push(`${'  '.repeat(level)}[${ref}] ${role}${name ? ` "${name}"` : ''}`);
    }
    for (const child of node.children ?? []) walk(child, level + 1);
  };

  walk(root, 0);
  return { nodes, text: lines.join('\n') };
}

export function resolveRef(page: Page, node: RefNode): Locator {
  return page.getByRole(node.role as any, node.name ? { name: node.name, exact: true } : {}).nth(node.nth);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- refs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/refs.ts test/refs.test.ts
git commit -m "feat(refs): a11y snapshot with stable refs + resolveRef via getByRole"
```

---

## Task 5: Perception

**Files:**
- Create: `src/perception.ts`
- Test: `test/perception.test.ts`

**Interfaces:**
- Consumes: `Driver`, `snapshotWithRefs`/`RefNode` (Task 4), `ArtifactStore` (Task 2).
- Produces: `class Perception { constructor(driver: Driver, store: ArtifactStore, budgetChars: number); readonly driver: Driver; state(): Promise<StateHeader>; navigate(url: string): Promise<StateHeader>; snapshot(): Promise<{ state: StateHeader; text: string; nodes: RefNode[] }>; find(query: string): Promise<RefNode[]>; read(opts?: { budget?: number }): Promise<{ text: string; truncated: boolean; path?: string }>; diff(): Promise<Delta>; screenshot(opts?: { fullPage?: boolean }): Promise<{ path: string; summary: string }> }` plus `StateHeader` and `Delta` interfaces (see File Structure). `snapshot()` and `diff()` update an internal `lastNodes` cache.

- [ ] **Step 1: Write the failing test**

`test/perception.test.ts`:
```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBrowser } from './helpers.js';
import { Driver } from '../src/driver.js';
import { ArtifactStore } from '../src/artifact-store.js';
import { Perception } from '../src/perception.js';

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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- perception`
Expected: FAIL — cannot find `../src/perception.js`.

- [ ] **Step 3: Write `src/perception.ts`**

```typescript
import type { Driver } from './driver.js';
import type { ArtifactStore } from './artifact-store.js';
import { snapshotWithRefs, type RefNode } from './refs.js';

export interface StateHeader { url: string; title: string; viewport: { width: number; height: number }; ready: boolean; dialogOpen: boolean }
export interface Delta { added: RefNode[]; removed: RefNode[]; changedText: { ref: string; from: string; to: string }[] }

export class Perception {
  private lastNodes: RefNode[] = [];

  constructor(public readonly driver: Driver, private store: ArtifactStore, private budgetChars: number) {}

  async state(): Promise<StateHeader> {
    const page = this.driver.page();
    const vp = page.viewportSize() ?? { width: 0, height: 0 };
    return {
      url: page.url(),
      title: await page.title(),
      viewport: vp,
      ready: await this.driver.evaluate(() => document.readyState === 'complete'),
      dialogOpen: this.driver.dialogWasHandled(),
    };
  }

  async navigate(url: string): Promise<StateHeader> {
    await this.driver.navigate(url);
    await this.driver.waitReady();
    return this.state();
  }

  async snapshot(): Promise<{ state: StateHeader; text: string; nodes: RefNode[] }> {
    const { nodes, text } = await snapshotWithRefs(this.driver.page());
    this.lastNodes = nodes;
    return { state: await this.state(), text, nodes };
  }

  async find(query: string): Promise<RefNode[]> {
    const { nodes } = await snapshotWithRefs(this.driver.page());
    this.lastNodes = nodes;
    const q = query.toLowerCase();
    return nodes.filter((n) => n.name.toLowerCase().includes(q) || n.role.toLowerCase().includes(q));
  }

  async read(opts: { budget?: number } = {}): Promise<{ text: string; truncated: boolean; path?: string }> {
    const budget = opts.budget ?? this.budgetChars;
    const full = await this.driver.evaluate(() => document.body.innerText);
    if (full.length <= budget) return { text: full, truncated: false };
    const saved = await this.store.save('text', full, 'txt');
    return { text: full.slice(0, budget), truncated: true, path: saved.path };
  }

  async diff(): Promise<Delta> {
    const before = this.lastNodes;
    const { nodes: after } = await snapshotWithRefs(this.driver.page());
    this.lastNodes = after;
    const key = (n: RefNode) => `${n.role} ${n.name}`;
    const beforeKeys = new Set(before.map(key));
    const afterKeys = new Set(after.map(key));
    return {
      added: after.filter((n) => !beforeKeys.has(key(n))),
      removed: before.filter((n) => !afterKeys.has(key(n))),
      changedText: [],
    };
  }

  async screenshot(opts: { fullPage?: boolean } = {}): Promise<{ path: string; summary: string }> {
    const png = await this.driver.screenshot(opts);
    const saved = await this.store.save('shot', png, 'jpg');
    return { path: saved.path, summary: saved.summary };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- perception`
Expected: PASS (all five).

- [ ] **Step 5: Commit**

```bash
git add src/perception.ts test/perception.test.ts
git commit -m "feat(perception): state/navigate/snapshot/find/read(budget)/diff/screenshot with disk spill"
```

---

## Task 6: Action

**Files:**
- Create: `src/action.ts`
- Test: `test/action.test.ts`

**Interfaces:**
- Consumes: `Driver`, `snapshotWithRefs`/`resolveRef`/`RefNode` (Task 4).
- Produces: `class Action { constructor(driver: Driver); act(ref: string, verb: 'click' | 'hover' | 'type' | 'press', text?: string): Promise<void>; fill(fields: { ref: string; value: string }[]): Promise<void>; scroll(dir: 'up' | 'down', amount?: number): Promise<void> }`. `act`/`fill` resolve a `ref` by taking a fresh `snapshotWithRefs`, finding the node with that `ref`, and calling `resolveRef`.

- [ ] **Step 1: Write the failing test**

`test/action.test.ts`:
```typescript
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- action`
Expected: FAIL — cannot find `../src/action.js`.

- [ ] **Step 3: Write `src/action.ts`**

```typescript
import type { Driver } from './driver.js';
import { snapshotWithRefs, resolveRef, type RefNode } from './refs.js';

export class Action {
  constructor(private driver: Driver) {}

  private async resolve(ref: string): Promise<RefNode> {
    const { nodes } = await snapshotWithRefs(this.driver.page());
    const node = nodes.find((n) => n.ref === ref);
    if (!node) throw new Error(`ref ${ref} introuvable dans le snapshot courant`);
    return node;
  }

  async act(ref: string, verb: 'click' | 'hover' | 'type' | 'press', text?: string): Promise<void> {
    const node = await this.resolve(ref);
    const loc = resolveRef(this.driver.page(), node);
    switch (verb) {
      case 'click': await loc.click(); break;
      case 'hover': await loc.hover(); break;
      case 'type': await loc.fill(text ?? ''); break;
      case 'press': await loc.press(text ?? 'Enter'); break;
    }
  }

  async fill(fields: { ref: string; value: string }[]): Promise<void> {
    for (const f of fields) await this.act(f.ref, 'type', f.value);
  }

  async scroll(dir: 'up' | 'down', amount = 600): Promise<void> {
    const dy = dir === 'down' ? amount : -amount;
    await this.driver.evaluate((y: number) => window.scrollBy(0, y), dy);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- action`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/action.ts test/action.test.ts
git commit -m "feat(action): act/fill/scroll by ref, resolving against a fresh snapshot"
```

---

## Task 7: Network

**Files:**
- Create: `src/network.ts`
- Test: `test/network.test.ts`

**Interfaces:**
- Consumes: `Driver`, `ArtifactStore`.
- Produces: `class Network { constructor(driver: Driver, store: ArtifactStore); start(): void; requests(filter?: string): { url: string; status: number; type: string }[]; readResponse(match: string): Promise<{ path: string; summary: string } | null>; fetchWithSession(url: string): Promise<{ path: string; summary: string }> }`. `start()` attaches `page.on('response')` listeners; `fetchWithSession` runs `fetch(url, {credentials:'include'})` in the page and stores the body.

- [ ] **Step 1: Write the failing test**

`test/network.test.ts`:
```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- network`
Expected: FAIL — cannot find `../src/network.js`.

- [ ] **Step 3: Write `src/network.ts`**

```typescript
import type { Driver } from './driver.js';
import type { ArtifactStore } from './artifact-store.js';

interface Rec { url: string; status: number; type: string }

export class Network {
  private records: Rec[] = [];

  constructor(private driver: Driver, private store: ArtifactStore) {}

  start(): void {
    this.driver.page().on('response', (res) => {
      this.records.push({ url: res.url(), status: res.status(), type: res.request().resourceType() });
    });
  }

  requests(filter?: string): Rec[] {
    return filter ? this.records.filter((r) => r.url.includes(filter)) : this.records.slice();
  }

  async readResponse(match: string): Promise<{ path: string; summary: string } | null> {
    // Bodies are not retained after load: refetch the matching URL within the page session.
    const rec = this.records.find((r) => r.url.includes(match));
    if (!rec) return null;
    return this.fetchWithSession(rec.url);
  }

  async fetchWithSession(url: string): Promise<{ path: string; summary: string }> {
    const b64 = await this.driver.evaluate(async (u: string) => {
      const r = await fetch(u, { credentials: 'include' });
      const buf = new Uint8Array(await r.arrayBuffer());
      let s = ''; for (const byte of buf) s += String.fromCharCode(byte);
      return btoa(s);
    }, url);
    const bytes = Buffer.from(b64, 'base64');
    const ext = url.split('.').pop()?.slice(0, 5).replace(/[^a-z0-9]/gi, '') || 'bin';
    return this.store.save('net', bytes, ext);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- network`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/network.ts test/network.test.ts
git commit -m "feat(network): request log, fetchWithSession, response spill to disk"
```

---

## Task 8: MCP server and tools

**Files:**
- Create: `src/server.ts`
- Test: `test/server.test.ts`

**Interfaces:**
- Consumes: `loadConfig`, `Driver`, `ArtifactStore`, `Perception` (with `.navigate`), `Action`, `Network`.
- Produces: `buildServer(deps: { perception: Perception; action: Action; network: Network })` — a `@modelcontextprotocol/sdk` server registering the Spec §7 tools `navigate`, `snapshot`, `find`, `read`, `state`, `screenshot`, `act`, `fill`, `scroll`, `network_requests`, `fetch_with_session`, augmented with `.listToolNames()` and `.callTool(name, args)` for tests. Every result is a text block: a one-line **state header** then the tool's short payload; large content is referenced by path. Also `main()` wiring real modules to a stdio transport.

- [ ] **Step 1: Write the failing test**

`test/server.test.ts`:
```typescript
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

let env: Awaited<ReturnType<typeof startBrowser>>;
let driver: Driver; let server: ReturnType<typeof buildServer>;
beforeAll(async () => {
  env = await startBrowser();
  driver = await Driver.connect(env.cdpUrl, { viewport: { width: 1440, height: 900 }, defaultTimeoutMs: 15000 });
  const store = new ArtifactStore(mkdtempSync(join(tmpdir(), 'scry-')));
  server = buildServer({ perception: new Perception(driver, store, 8000), action: new Action(driver), network: new Network(driver, store) });
  await driver.navigate(env.pageUrl); await driver.waitReady();
});
afterAll(async () => { await driver.close(); await env.stop(); });

describe('buildServer', () => {
  it('registers the Spec §7 tools', () => {
    const names = server.listToolNames();
    for (const t of ['navigate', 'snapshot', 'find', 'read', 'state', 'screenshot', 'act', 'fill', 'scroll', 'network_requests', 'fetch_with_session']) {
      expect(names).toContain(t);
    }
  });

  it('snapshot returns a state header line then the tree text', async () => {
    const out = await server.callTool('snapshot', {});
    expect(out).toMatch(/^\[state\] url=/);
    expect(out).toContain('button "Go"');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- server`
Expected: FAIL — cannot find `../src/server.js`.

- [ ] **Step 3: Write `src/server.ts`**

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfig } from './config.js';
import { Driver } from './driver.js';
import { ArtifactStore } from './artifact-store.js';
import { Perception, type StateHeader } from './perception.js';
import { Action } from './action.js';
import { Network } from './network.js';

function headerLine(s: StateHeader): string {
  return `[state] url=${s.url} title=${JSON.stringify(s.title)} ready=${s.ready} dialog=${s.dialogOpen}`;
}

interface Tool { shape: Record<string, z.ZodTypeAny>; run: (args: any) => Promise<string> }

export function buildServer(deps: { perception: Perception; action: Action; network: Network }) {
  const { perception, action, network } = deps;
  const tools: Record<string, Tool> = {
    navigate: { shape: { url: z.string() }, run: async (a) => headerLine(await perception.navigate(a.url)) },
    state: { shape: {}, run: async () => headerLine(await perception.state()) },
    snapshot: { shape: {}, run: async () => { const s = await perception.snapshot(); return `${headerLine(s.state)}\n${s.text}`; } },
    find: { shape: { query: z.string() }, run: async (a) => { const hits = await perception.find(a.query); return hits.map((n) => `[${n.ref}] ${n.role} "${n.name}"`).join('\n') || '(aucun)'; } },
    read: { shape: { budget: z.number().optional() }, run: async (a) => { const r = await perception.read(a); return `${r.text}${r.truncated ? `\n[tronqué -> ${r.path}]` : ''}`; } },
    screenshot: { shape: { fullPage: z.boolean().optional() }, run: async (a) => (await perception.screenshot(a)).summary },
    act: { shape: { ref: z.string(), verb: z.enum(['click', 'hover', 'type', 'press']), text: z.string().optional() }, run: async (a) => { await action.act(a.ref, a.verb, a.text); return headerLine(await perception.state()); } },
    fill: { shape: { fields: z.array(z.object({ ref: z.string(), value: z.string() })) }, run: async (a) => { await action.fill(a.fields); return headerLine(await perception.state()); } },
    scroll: { shape: { dir: z.enum(['up', 'down']), amount: z.number().optional() }, run: async (a) => { await action.scroll(a.dir, a.amount); return headerLine(await perception.state()); } },
    network_requests: { shape: { filter: z.string().optional() }, run: async (a) => network.requests(a.filter).map((r) => `${r.status} ${r.type} ${r.url}`).join('\n') || '(aucune)' },
    fetch_with_session: { shape: { url: z.string() }, run: async (a) => (await network.fetchWithSession(a.url)).summary },
  };

  const server = new McpServer({ name: 'scry', version: '0.1.0' });
  for (const [name, t] of Object.entries(tools)) {
    server.tool(name, t.shape, async (args: any) => ({ content: [{ type: 'text', text: await t.run(args) }] }));
  }

  return Object.assign(server, {
    listToolNames: () => Object.keys(tools),
    callTool: (name: string, args: any) => tools[name].run(args),
  });
}

export async function main(): Promise<void> {
  const cfg = loadConfig();
  const driver = await Driver.connect(cfg.cdpUrl, { viewport: cfg.viewport, defaultTimeoutMs: cfg.defaultTimeoutMs });
  const store = new ArtifactStore(cfg.dataDir);
  const network = new Network(driver, store); network.start();
  const server = buildServer({ perception: new Perception(driver, store, cfg.readBudgetChars), action: new Action(driver), network });
  await server.connect(new StdioServerTransport());
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- server`
Expected: PASS (both). If the SDK's `McpServer.tool` signature differs in the installed version, adapt the registration line only — the `tools` table and `callTool`/`listToolNames` (which the test drives) stay unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts test/server.test.ts
git commit -m "feat(server): MCP server wiring Spec §7 tools with state header + disk-backed outputs"
```

---

## Self-Review

**Spec coverage (§ by §):**
- §4 «lire en structure» → Tasks 4, 5. «gros paquets hors contexte» → Task 2 + `read`/`screenshot`/`fetchWithSession` disk spill (Tasks 5, 7). «agir par référence» → Tasks 4, 6.
- §5.2 driver → Task 3. §5.4 perception → Task 5. §5.5 action → Task 6. §5.6 network → Task 7. §5.7 artifact-store → Task 2. §5.3 mcp-server → Task 8.
- §7 tool surface → Task 8 (navigate, snapshot, find, read, state, screenshot, act, fill, scroll, network_requests, fetch_with_session). **Not in Plan A:** `tabs_*` and `live_*` — they belong to Plan B (hosting + live view). Deliberate, not a gap.
- §8 robustness: deterministic waits (`waitReady`), fixed viewport (`setViewportSize`), dialog auto-dismiss (Task 3). **Retry/back-off on transient CDP errors is deferred to Plan B** with the always-on host.
- §10 data hors dépôt → Global Constraints + `ArtifactStore(cfg.dataDir)`.
- §14 Playwright connectOverCDP → Task 3.

**Placeholder scan:** every step carries real code or a real command; no TBD/TODO. The Task 8 Step 4 note offers a concrete fallback for an SDK version drift, not a placeholder.

**Type consistency:** `RefNode` (refs.ts) is used identically in Tasks 4–6 and rendered in Task 8. `StateHeader`/`Delta` are defined in perception.ts and consumed in Task 8. `ArtifactStore.save` returns `{ path, bytes, summary }`, consumed as such in Tasks 5, 7. `Perception` exposes `driver` (public readonly) and `navigate`, both relied on by Task 8. `Driver` method names (`page`, `navigate`, `waitReady`, `screenshot`, `evaluate`, `dialogWasHandled`, `close`) match across Tasks 3–8.

**Deferred to Plan B (written next):** `chrome-host` always-on service (Xvfb + persistent profile + systemd), `live-view` + passe-la-main (CDP screencast, signed link, read/input modes, no-capture-during-input), `remote-access` (SSH keys, Cloudflare tunnel route), `tabs_*` tools, transient-error retry/back-off, download/upload verbs.
