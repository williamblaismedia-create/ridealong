import type { Driver } from './driver.js';

export interface TabInfo { id: number; url: string; title: string; active: boolean }

/**
 * Tabs of the shared Chrome. `active` is the driver's TARGET: the tab that
 * perception, action and the live view follow. select/open move it; closing
 * the target falls back to a neighbour; the last tab can't be closed.
 */
export class Tabs {
  constructor(private driver: Driver) {}

  async list(): Promise<TabInfo[]> {
    const pages = this.driver.context().pages();
    const cur = this.driver.page();
    return Promise.all(
      pages.map(async (p, id) => ({ id, url: p.url(), title: await p.title().catch(() => ''), active: p === cur }))
    );
  }

  async open(url: string): Promise<number> {
    const p = await this.driver.context().newPage();
    this.driver.setPage(p);
    await this.driver.cacheReady(p); // bypass in place before the first load
    await p.goto(url, { waitUntil: 'domcontentloaded' });
    return this.driver.context().pages().indexOf(p);
  }

  async close(id: number): Promise<void> {
    const pages = this.driver.context().pages();
    if (id < 0 || id >= pages.length) throw new Error(`onglet ${id} inexistant`);
    if (pages.length === 1) throw new Error('impossible de fermer le dernier onglet');
    const closing = pages[id];
    if (closing === this.driver.page()) {
      // The target goes away: fall back to the left neighbour (or the first),
      // and foreground it so the screencast keeps flowing (M3).
      const next = pages[id > 0 ? id - 1 : 1];
      this.driver.setPage(next);
      await next.bringToFront().catch(() => {});
    }
    await closing.close();
  }

  async select(id: number): Promise<void> {
    const pages = this.driver.context().pages();
    if (id < 0 || id >= pages.length) throw new Error(`onglet ${id} inexistant`);
    const p = pages[id];
    await p.bringToFront();
    this.driver.setPage(p);
  }
}
