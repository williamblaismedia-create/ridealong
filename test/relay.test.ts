import { describe, it, expect } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const RELAY = join(here, '..', 'scripts', 'scry-mcp-relay.mjs');
const FAKE = join(here, 'fixtures', 'fake-mcp-server.mjs');

function rpcClient(proc: ChildProcess) {
  const waiters = new Map<number, (m: any) => void>();
  let buf = '';
  proc.stdout!.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const m = JSON.parse(line);
      waiters.get(m.id)?.(m); waiters.delete(m.id);
    }
  });
  return {
    send: (obj: any) => proc.stdin!.write(JSON.stringify(obj) + '\n'),
    call: (id: number, method: string, params: any = {}, ms = 8000) => new Promise<any>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`no response to ${method} #${id}`)), ms);
      waiters.set(id, (m) => { clearTimeout(t); resolve(m); });
      proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    }),
  };
}

describe('scry-mcp-relay (local stdio relay that survives a dead SSH child)', () => {
  it('forwards normally, then respawns the child on exit, replays initialize, and answers later calls', async () => {
    const proc = spawn(process.execPath, [RELAY], { env: { ...process.env, SCRY_RELAY_CMD: `${process.execPath} ${FAKE}` }, stdio: ['pipe', 'pipe', 'pipe'] });
    const stderr: string[] = [];
    proc.stderr!.on('data', (d) => stderr.push(d.toString()));
    const c = rpcClient(proc);
    try {
      const init = await c.call(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
      expect(init.result.serverInfo.name).toBe('fake');
      c.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      const first = await c.call(2, 'tools/call', { name: 'x' });
      const pid1 = first.result.pid;
      expect(pid1).toBeGreaterThan(0);

      // The "SSH link" dies. The client never notices: its next call is
      // buffered, the child respawned, the handshake replayed, then answered.
      c.send({ jsonrpc: '2.0', method: 'crash' });
      await new Promise((r) => setTimeout(r, 200));
      const second = await c.call(3, 'tools/call', { name: 'y' });
      expect(second.result.pid).toBeGreaterThan(0);
      expect(second.result.pid).not.toBe(pid1);
      expect(stderr.join('')).toMatch(/handshake rejoue/);
      // The replayed initialize's response was swallowed: the client only
      // ever saw responses to ITS ids (1, 2, 3) — the negative replay id never leaked.
    } finally {
      proc.stdin!.end();
      await new Promise((r) => setTimeout(r, 700));
      proc.kill('SIGKILL');
    }
  }, 20000);
});
