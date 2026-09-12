import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { startBrowser } from './helpers.js';
import { Driver } from '../src/driver.js';
import { ArtifactStore } from '../src/artifact-store.js';
import { Perception } from '../src/perception.js';
import { Action } from '../src/action.js';
import { Network } from '../src/network.js';
import { buildServer } from '../src/server.js';
import { LiveView } from '../src/live-view.js';

// Exercises the ACTUAL MCP surface (server.connect + a real Client over an
// in-memory transport pair), not the callTool/listToolNames shims that bypass
// the protocol layer.
let env: Awaited<ReturnType<typeof startBrowser>>;
let driver: Driver;
let client: Client;
beforeAll(async () => {
  env = await startBrowser();
  driver = await Driver.connect(env.cdpUrl, { viewport: { width: 1440, height: 900 }, defaultTimeoutMs: 15000 });
  const store = new ArtifactStore(mkdtempSync(join(tmpdir(), 'scry-')));
  const perception = new Perception(driver, store, 8000);
  const action = new Action(driver, (ref) => perception.resolveRefNode(ref));
  const server = buildServer({ perception, action, network: new Network(driver, store) });
  await driver.navigate(env.pageUrl); await driver.waitReady();

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'scry-test-client', version: '0.0.0' });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
});
afterAll(async () => { await client.close(); await driver.close(); await env.stop(); });

describe('MCP transport integration', () => {
  it('lists the registered tools through a real MCP client', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('state');
    expect(names).toContain('snapshot');
  });

  it('every tool carries a real description, and tabs_select says the target moves (perception/action/live view follow)', async () => {
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
    for (const t of tools) {
      expect(t.description ?? '', `tool ${t.name} has no description`).not.toBe('');
      expect((t.description ?? '').length).toBeGreaterThan(15);
    }
    const select = tools.find((t) => t.name === 'tabs_select');
    expect(select?.description).toMatch(/cible/i);
  });

  it('calls a tool through the real MCP path and gets the tool result back', async () => {
    const res: any = await client.callTool({ name: 'snapshot', arguments: {} });
    expect(Array.isArray(res.content)).toBe(true);
    const text = res.content.map((c: any) => c.text).join('');
    expect(text).toMatch(/^\[state\] url=/);
    expect(text).toContain('button "Go"');
  });
});

describe('Claude Code channel (server -> conversation pushes)', () => {
  it('declares claude/channel and pushes a notification when William says/points/takes control', async () => {
    const store = new ArtifactStore(mkdtempSync(join(tmpdir(), 'scry-')));
    const perception = new Perception(driver, store, 8000);
    const live = new LiveView(driver, { secret: 'chan-secret' });
    await live.start(9431);
    const server = buildServer({ perception, action: new Action(driver), network: new Network(driver, store), liveView: live });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: 'chan-client', version: '0' });
    const got: any[] = [];
    c.fallbackNotificationHandler = async (n) => { got.push(n); };
    await Promise.all([server.connect(st), c.connect(ct)]);
    try {
      expect(c.getServerCapabilities()?.experimental).toHaveProperty('claude/channel');
      live.pushInbox('William dit : allo');
      live.setMode('input');
      await new Promise((r) => setTimeout(r, 300));
      const chan = got.filter((n) => n.method === 'notifications/claude/channel');
      expect(chan.length).toBeGreaterThanOrEqual(2);
      expect(chan[0].params.content).toContain('allo');
      expect(chan[0].params.meta.kind).toBe('inbox');
      expect(chan.some((n) => n.params.meta.kind === 'mode' && /Manuel/.test(n.params.content))).toBe(true);
    } finally {
      live.setMode('read');
      await c.close();
      await live.stop();
    }
  });
});
