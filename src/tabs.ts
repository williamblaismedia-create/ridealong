import type { Driver } from './driver.js';

export interface TabInfo { id: number; url: string; title: string; active: boolean }

export class Tabs {
  private activeId = 0;

  constructor(private driver: Driver) {}

  async list(): Promise<TabInfo[]> {
    const pages = this.driver.context().pages();
    return Promise.all(
      pages.map(async (p, id) => ({ id, url: p.url(), title: await p.title(), active: id === this.activeId }))
    );
  }

  async open(url: string): Promise<number> {
    const p = await this.driver.context().newPage();
    await p.goto(url, { waitUntil: 'domcontentloaded' });
    const id = this.driver.context().pages().indexOf(p);
    this.activeId = id;
    return id;
  }

  async close(id: number): Promise<void> {
    const pages = this.driver.context().pages();
    if (id < 0 || id >= pages.length) throw new Error(`onglet ${id} inexistant`);
    await pages[id].close();
    if (this.activeId === id) this.activeId = 0;
  }

  async select(id: number): Promise<void> {
    const pages = this.driver.context().pages();
    if (id < 0 || id >= pages.length) throw new Error(`onglet ${id} inexistant`);
    await pages[id].bringToFront();
    this.activeId = id;
  }
}
