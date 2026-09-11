import type { Driver } from './driver.js';
import type { Page } from 'playwright';

export interface TabInfo { id: number; url: string; title: string; active: boolean }

export class Tabs {
  private activePage: Page | null = null;

  constructor(private driver: Driver) {}

  async list(): Promise<TabInfo[]> {
    const pages = this.driver.context().pages();
    const cur = this.activePage ?? this.driver.page();
    return Promise.all(
      pages.map(async (p, id) => ({ id, url: p.url(), title: await p.title(), active: p === cur }))
    );
  }

  async open(url: string): Promise<number> {
    const p = await this.driver.context().newPage();
    await p.goto(url, { waitUntil: 'domcontentloaded' });
    this.activePage = p;
    return this.driver.context().pages().indexOf(p);
  }

  async close(id: number): Promise<void> {
    const pages = this.driver.context().pages();
    if (id < 0 || id >= pages.length) throw new Error(`onglet ${id} inexistant`);
    if (pages[id] === this.driver.page()) throw new Error('impossible de fermer l onglet principal');
    await pages[id].close();
    if (pages[id] === this.activePage) this.activePage = this.driver.page();
  }

  async select(id: number): Promise<void> {
    const pages = this.driver.context().pages();
    if (id < 0 || id >= pages.length) throw new Error(`onglet ${id} inexistant`);
    const p = pages[id];
    await p.bringToFront();
    this.activePage = p;
  }
}
