import { chromium, type Browser, type Page } from 'playwright';

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

export class Driver {
  private dialogHandled = false;
  private dialogOpen = false;

  private constructor(private browser: Browser, private _page: Page) {}

  static async connect(cdpUrl: string, opts: { viewport: { width: number; height: number }; defaultTimeoutMs: number }): Promise<Driver> {
    const browser = await chromium.connectOverCDP(cdpUrl);
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = context.pages()[0] ?? (await context.newPage());
    await page.setViewportSize(opts.viewport);
    page.setDefaultTimeout(opts.defaultTimeoutMs);
    const driver = new Driver(browser, page);
    // Native dialogs must never freeze the session: auto-dismiss, record that one
    // appeared, and track live open/closed state (dialogOpen is only true while a
    // dialog is actually up — it must not stick true after dismissal).
    page.on('dialog', async (d) => {
      driver.dialogHandled = true;
      driver.dialogOpen = true;
      await d.dismiss().catch(() => {});
      driver.dialogOpen = false;
    });
    return driver;
  }

  page(): Page { return this._page; }

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
