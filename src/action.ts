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
