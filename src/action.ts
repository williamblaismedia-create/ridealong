import type { Driver } from './driver.js';
import { snapshotWithRefs, resolveRef, type RefNode } from './refs.js';

/**
 * What the live view is told about an action BEFORE it runs: the verb, a
 * human label (role + accessible name, never the typed text), and the
 * target's centre in page CSS pixels when it has a box. Drives Claude's
 * visible cursor and the action journal on the viewer.
 */
export interface ActionEvent { verb: string; label: string; x?: number; y?: number }

export class Action {
  constructor(
    private driver: Driver,
    private lookup?: (ref: string) => RefNode | undefined,
    private onTarget?: (ev: ActionEvent) => void,
  ) {}

  private async resolve(ref: string): Promise<RefNode> {
    // Prefer the perception registry (what the model last saw); refs are stable
    // across the perceive->act boundary. Fall back to a fresh snapshot only when
    // no lookup was wired.
    if (this.lookup) {
      const node = this.lookup(ref);
      if (!node) throw new Error(`ref ${ref} introuvable dans le snapshot courant`);
      return node;
    }
    const { nodes } = await snapshotWithRefs(this.driver.page());
    const node = nodes.find((n) => n.ref === ref);
    if (!node) throw new Error(`ref ${ref} introuvable dans le snapshot courant`);
    return node;
  }

  async act(ref: string, verb: 'click' | 'hover' | 'type' | 'press', text?: string): Promise<void> {
    const node = await this.resolve(ref);
    const loc = resolveRef(this.driver.page(), node);
    if (this.onTarget) {
      // Best-effort: a missing box (detached, hidden) still announces the verb.
      const box = await loc.boundingBox().catch(() => null);
      const ev: ActionEvent = { verb, label: `${verb} ${node.role}${node.name ? ` « ${node.name} »` : ''}` };
      if (box) { ev.x = Math.round(box.x + box.width / 2); ev.y = Math.round(box.y + box.height / 2); }
      try { this.onTarget(ev); } catch { /* an observer must never break the action */ }
    }
    switch (verb) {
      case 'click': await loc.click(); break;
      case 'hover': await loc.hover(); break;
      case 'type': await loc.fill(text ?? ''); break;
      case 'press': await loc.press(text ?? 'Enter'); break;
      default: throw new Error(`verbe inconnu: ${verb}`);
    }
  }

  async fill(fields: { ref: string; value: string }[]): Promise<void> {
    for (const f of fields) await this.act(f.ref, 'type', f.value);
  }

  async scroll(dir: 'up' | 'down', amount = 600): Promise<void> {
    const dy = dir === 'down' ? amount : -amount;
    try { this.onTarget?.({ verb: 'scroll', label: `scroll ${dir === 'down' ? 'vers le bas' : 'vers le haut'} (${amount}px)` }); } catch { /* observer */ }
    await this.driver.evaluate((y: number) => window.scrollBy(0, y), dy);
  }
}
