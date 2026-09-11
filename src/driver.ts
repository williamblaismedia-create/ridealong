import { chromium, type Browser, type Page } from 'playwright';

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
    await this._page.goto(url, { waitUntil: 'domcontentloaded' });
  }

  async waitReady(): Promise<void> {
    await this._page.waitForLoadState('networkidle').catch(() => {});
  }

  async screenshot(opts: { fullPage?: boolean } = {}): Promise<Buffer> {
    return this._page.screenshot({ fullPage: opts.fullPage ?? false, type: 'jpeg', quality: 80 });
  }

  async evaluate<T>(fn: string | ((...a: any[]) => T), arg?: any): Promise<T> {
    return this._page.evaluate(fn as any, arg);
  }

  dialogWasHandled(): boolean { return this.dialogHandled; }

  isDialogOpen(): boolean { return this.dialogOpen; }

  async close(): Promise<void> { await this.browser.close(); }
}
