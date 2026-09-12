import type { Page } from 'playwright';
import type { Driver } from './driver.js';

export interface LogEntry { at: number; kind: 'console.error' | 'console.warn' | 'pageerror' | 'requestfailed' | 'http'; text: string; url?: string }

/**
 * What the page complained about: console errors/warnings, uncaught
 * exceptions, failed requests, HTTP 4xx/5xx. Follows the driver's target
 * across tabs; ring buffer of the last 200 entries. Read through the
 * `console_errors` tool — the thing you want when testing an app you just
 * deployed.
 */
export class PageLog {
  private entries_: LogEntry[] = [];
  private attached = new WeakSet<Page>();

  constructor(private driver: Driver, private max = 200) {}

  start(): void {
    this.attach(this.driver.page());
    this.driver.on('page', (p: Page) => this.attach(p));
  }

  private push(e: LogEntry): void {
    this.entries_.push(e);
    if (this.entries_.length > this.max) this.entries_.splice(0, this.entries_.length - this.max);
  }

  private attach(page: Page): void {
    if (this.attached.has(page)) return;
    this.attached.add(page);
    page.on('console', (m) => {
      const t = m.type();
      if (t === 'error' || t === 'warning') this.push({ at: Date.now(), kind: t === 'error' ? 'console.error' : 'console.warn', text: m.text().slice(0, 500), url: m.location()?.url });
    });
    page.on('pageerror', (err) => this.push({ at: Date.now(), kind: 'pageerror', text: String(err.message ?? err).slice(0, 500) }));
    page.on('requestfailed', (req) => this.push({ at: Date.now(), kind: 'requestfailed', text: req.failure()?.errorText ?? 'failed', url: req.url() }));
    page.on('response', (res) => { if (res.status() >= 400) this.push({ at: Date.now(), kind: 'http', text: `${res.status()} ${res.request().method()}`, url: res.url() }); });
  }

  entries(): LogEntry[] { return this.entries_.slice(); }
  clear(): void { this.entries_ = []; }

  /** Compact text for the tool: newest last, one line each. */
  format(): string {
    if (!this.entries_.length) return '(rien : aucune erreur console, exception, requete echouee ou reponse 4xx/5xx)';
    return this.entries_.map((e) => `${new Date(e.at).toISOString().slice(11, 19)} ${e.kind} ${e.text}${e.url ? ` — ${e.url.slice(0, 160)}` : ''}`).join('\n');
  }
}
