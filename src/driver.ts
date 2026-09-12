import { EventEmitter } from 'node:events';
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from 'playwright';

// Transient CDP/Playwright errors: the target or session flickered but the
// browser is still usable, so a short retry is worth it. Anything else
// (assertion failures, bad selectors, application logic errors) is not
// transient and must fail fast.
const TRANSIENT_ERROR = /Target closed|renderer|timeout|detached|not attached|Session closed/i;

export async function withRetry<T>(fn: () => Promise<T>, opts?: { tries?: number; baseMs?: number }): Promise<T> {
  const tries = opts?.tries ?? 3;
  const baseMs = opts?.baseMs ?? 100;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isTransient = TRANSIENT_ERROR.test(String((err as { message?: unknown } | undefined)?.message));
      if (!isTransient || attempt >= tries - 1) throw err;
      await new Promise((resolve) => setTimeout(resolve, baseMs * 2 ** attempt));
    }
  }
}

/**
 * The driver has ONE target page at a time: perception, action, network
 * capture and the live view all follow `page()`. `setPage()` moves the
 * target (tabs_select / tabs_open / a chip tap on the viewer) and emits
 * 'page' so dependents re-attach.
 */
export class Driver extends EventEmitter {
  private dialogHandled = false;
  private dialogOpen = false;
  private wired = new WeakSet<Page>();

  private constructor(private browser: Browser, private _page: Page, private opts: { viewport: { width: number; height: number }; defaultTimeoutMs: number }) {
    super();
  }

  private wire(page: Page): void {
    if (this.wired.has(page)) return;
    this.wired.add(page);
    page.setDefaultTimeout(this.opts.defaultTimeoutMs);
    // Native dialogs must never freeze the session: auto-dismiss, record that one
    // appeared, and track live open/closed state (dialogOpen is only true while a
    // dialog is actually up — it must not stick true after dismissal).
    page.on('dialog', async (d) => {
      this.dialogHandled = true;
      this.dialogOpen = true;
      await d.dismiss().catch(() => {});
      this.dialogOpen = false;
    });
  }

  /** Current viewport (CSS px) applied to every target. */
  viewport(): { width: number; height: number } { return { ...this.opts.viewport }; }

  /** Change the viewport for the current target and every later one; emits 'viewport'. */
  async setViewport(v: { width: number; height: number }): Promise<void> {
    this.opts.viewport = { width: v.width, height: v.height };
    await this._page.setViewportSize(this.opts.viewport);
    this.emit('viewport', { ...this.opts.viewport });
  }

  /** Move the target to another open tab. No-op when it's already the target. */
  setPage(page: Page): void {
    if (page === this._page) return;
    this._page = page;
    this.wire(page);
    void page.setViewportSize(this.opts.viewport).catch(() => {});
    this.emit('page', page);
  }

  static async connect(cdpUrl: string, opts: { viewport: { width: number; height: number }; defaultTimeoutMs: number }): Promise<Driver> {
    const browser = await chromium.connectOverCDP(cdpUrl);
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = context.pages()[0] ?? (await context.newPage());
    await page.setViewportSize(opts.viewport);
    const driver = new Driver(browser, page, opts);
    driver.wire(page);
    return driver;
  }

  page(): Page { return this._page; }

  context(): BrowserContext { return this._page.context(); }

  async cdpSession(): Promise<CDPSession> { return this._page.context().newCDPSession(this._page); }

  async navigate(url: string): Promise<void> {
    await withRetry(() => this._page.goto(url, { waitUntil: 'domcontentloaded' }));
  }

  async waitReady(): Promise<void> {
    await this._page.waitForLoadState('networkidle').catch(() => {});
  }

  async screenshot(opts: { fullPage?: boolean } = {}): Promise<Buffer> {
    return withRetry(() => this._page.screenshot({ fullPage: opts.fullPage ?? false, type: 'jpeg', quality: 80 }));
  }

  async evaluate<T>(fn: string | ((...a: any[]) => T), arg?: any): Promise<T> {
    return withRetry(() => this._page.evaluate(fn as any, arg));
  }

  dialogWasHandled(): boolean { return this.dialogHandled; }

  isDialogOpen(): boolean { return this.dialogOpen; }

  async close(): Promise<void> { await this.browser.close(); }
}
