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
      dialogOpen: this.driver.isDialogOpen(),
    };
  }

  async navigate(url: string): Promise<StateHeader> {
    await this.driver.navigate(url);
    await this.driver.waitReady();
    return this.state();
  }

  async snapshot(opts: { budget?: number } = {}): Promise<{ state: StateHeader; text: string; nodes: RefNode[]; truncated: boolean; path?: string }> {
    const budget = opts.budget ?? this.budgetChars;
    const { nodes, text: fullText } = await snapshotWithRefs(this.driver.page());
    this.lastNodes = nodes;
    const state = await this.state();
    if (fullText.length <= budget) return { state, text: fullText, nodes, truncated: false };
    const saved = await this.store.save('snapshot', fullText, 'txt');
    return { state, text: fullText.slice(0, budget), nodes, truncated: true, path: saved.path };
  }

  /** Resolve a ref against the nodes captured at the last snapshot()/find(), so
   *  act/fill target what the model actually saw — not a fresh re-enumeration
   *  whose sequence numbers may have shifted if the DOM changed meanwhile. */
  resolveRefNode(ref: string): RefNode | undefined {
    return this.lastNodes.find((n) => n.ref === ref);
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
