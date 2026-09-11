import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { startBrowser } from './helpers.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

// C3: over SSH, Claude Code kills only the LOCAL ssh on shutdown; the remote
// `node` gets EOF on stdin and NO signal. The server MUST exit on that EOF, or
// it orphans — holding the live-view port and a CDP connection so every later
// session hits EADDRINUSE and silently loses its live_* tools. This test spawns
// the REAL built entrypoint (the file scry-mcp.sh execs), ends its stdin, and
// asserts a prompt exit.
let env: Awaited<ReturnType<typeof startBrowser>>;

beforeAll(async () => {
  execSync('npm run build', { cwd: repoRoot, stdio: 'ignore' });
  env = await startBrowser();
}, 60000);

afterAll(async () => { await env.stop(); });

describe('server shutdown (C3)', () => {
  it('exits within 2s when stdin ends (the SSH-orphan scenario)', async () => {
    const child = spawn(process.execPath, [join(repoRoot, 'dist', 'src', 'server.js')], {
      cwd: repoRoot,
      env: {
        ...process.env,
        SCRY_CDP_URL: env.cdpUrl,
        SCRY_LIVE_SECRET: '', // falsy -> live-view off; avoids binding a port
        SCRY_DATA_DIR: mkdtempSync(join(tmpdir(), 'scry-shutdown-')),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Wait until main() is past Driver.connect (it logs the live-view-disabled
    // notice to stderr right before wiring the transport).
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('server did not become ready')), 20000);
      child.stderr.on('data', () => { clearTimeout(t); resolve(); });
      child.once('exit', (code) => { clearTimeout(t); reject(new Error(`exited before ready (code ${code})`)); });
    });

    const start = Date.now();
    const exited = await new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(false), 2000);
      child.once('exit', () => { clearTimeout(t); resolve(true); });
      child.stdin.end(); // EOF — the crux of C3
    });
    if (!exited) child.kill('SIGKILL');
    expect(exited).toBe(true);
    expect(Date.now() - start).toBeLessThan(2000);
  }, 30000);
});
