import { chromium, type Browser } from 'playwright';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const DEBUG_PORT = 9333;

export async function startBrowser(): Promise<{ cdpUrl: string; pageUrl: string; stop: () => Promise<void> }> {
  const html = readFileSync(join(here, 'fixtures', 'page.html'), 'utf8');
  let counter = 0;
  const server: Server = createServer((req, res) => {
    if (req.url?.startsWith('/counter')) {
      // Aggressively cacheable: without "disable cache" Chrome would keep
      // showing the first value on later navigations.
      counter++;
      res.setHeader('content-type', 'text/html');
      res.setHeader('cache-control', 'public, max-age=3600');
      res.end(`<title>counter</title><p id="n">${counter}</p>`);
      return;
    }
    res.setHeader('content-type', 'text/html'); res.end(html);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as any).port;
  const pageUrl = `http://127.0.0.1:${port}/`;
  const browser: Browser = await chromium.launch({ args: [`--remote-debugging-port=${DEBUG_PORT}`, '--remote-debugging-address=127.0.0.1'] });
  const cdpUrl = `http://127.0.0.1:${DEBUG_PORT}`;
  return {
    cdpUrl,
    pageUrl,
    stop: async () => { await browser.close(); await new Promise<void>((r) => server.close(() => r())); },
  };
}
