import type { Driver } from './driver.js';
import type { ArtifactStore } from './artifact-store.js';

interface Rec { url: string; status: number; type: string }

export class Network {
  private records: Rec[] = [];

  constructor(private driver: Driver, private store: ArtifactStore) {}

  private attached = new WeakSet<import('playwright').Page>();

  start(): void {
    this.attach(this.driver.page());
    this.driver.on('page', (p) => this.attach(p)); // follow the target across tabs
  }

  private attach(page: import('playwright').Page): void {
    if (this.attached.has(page)) return;
    this.attached.add(page);
    page.on('response', (res) => {
      this.records.push({ url: res.url(), status: res.status(), type: res.request().resourceType() });
    });
  }

  requests(filter?: string): Rec[] {
    return filter ? this.records.filter((r) => r.url.includes(filter)) : this.records.slice();
  }

  // NOTE: refetches the matching URL (GET) within the page session — this is NOT the page's
  // original captured response body. Proper captured-body semantics deferred to Plan B.
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
