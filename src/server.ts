import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfig } from './config.js';
import { Driver } from './driver.js';
import { ArtifactStore } from './artifact-store.js';
import { Perception, type StateHeader } from './perception.js';
import { Action } from './action.js';
import { Network } from './network.js';

function headerLine(s: StateHeader): string {
  return `[state] url=${s.url} title=${JSON.stringify(s.title)} ready=${s.ready} dialog=${s.dialogOpen}`;
}

interface Tool { shape: Record<string, z.ZodTypeAny>; run: (args: any) => Promise<string> }

export function buildServer(deps: { perception: Perception; action: Action; network: Network }) {
  const { perception, action, network } = deps;
  const tools: Record<string, Tool> = {
    navigate: { shape: { url: z.string() }, run: async (a) => headerLine(await perception.navigate(a.url)) },
    state: { shape: {}, run: async () => headerLine(await perception.state()) },
    snapshot: { shape: {}, run: async () => { const s = await perception.snapshot(); return `${headerLine(s.state)}\n${s.text}`; } },
    find: { shape: { query: z.string() }, run: async (a) => { const hits = await perception.find(a.query); return hits.map((n) => `[${n.ref}] ${n.role} "${n.name}"`).join('\n') || '(aucun)'; } },
    read: { shape: { budget: z.number().optional() }, run: async (a) => { const r = await perception.read(a); return `${r.text}${r.truncated ? `\n[tronqué -> ${r.path}]` : ''}`; } },
    screenshot: { shape: { fullPage: z.boolean().optional() }, run: async (a) => (await perception.screenshot(a)).summary },
    act: { shape: { ref: z.string(), verb: z.enum(['click', 'hover', 'type', 'press']), text: z.string().optional() }, run: async (a) => { await action.act(a.ref, a.verb, a.text); return headerLine(await perception.state()); } },
    fill: { shape: { fields: z.array(z.object({ ref: z.string(), value: z.string() })) }, run: async (a) => { await action.fill(a.fields); return headerLine(await perception.state()); } },
    scroll: { shape: { dir: z.enum(['up', 'down']), amount: z.number().optional() }, run: async (a) => { await action.scroll(a.dir, a.amount); return headerLine(await perception.state()); } },
    network_requests: { shape: { filter: z.string().optional() }, run: async (a) => network.requests(a.filter).map((r) => `${r.status} ${r.type} ${r.url}`).join('\n') || '(aucune)' },
    fetch_with_session: { shape: { url: z.string() }, run: async (a) => (await network.fetchWithSession(a.url)).summary },
  };

  const server = new McpServer({ name: 'scry', version: '0.1.0' });
  for (const [name, t] of Object.entries(tools)) {
    server.tool(name, t.shape, async (args: any) => ({ content: [{ type: 'text', text: await t.run(args) }] }));
  }

  return Object.assign(server, {
    listToolNames: () => Object.keys(tools),
    callTool: (name: string, args: any) => tools[name].run(args),
  });
}

export async function main(): Promise<void> {
  const cfg = loadConfig();
  const driver = await Driver.connect(cfg.cdpUrl, { viewport: cfg.viewport, defaultTimeoutMs: cfg.defaultTimeoutMs });
  const store = new ArtifactStore(cfg.dataDir);
  const network = new Network(driver, store); network.start();
  const server = buildServer({ perception: new Perception(driver, store, cfg.readBudgetChars), action: new Action(driver), network });
  await server.connect(new StdioServerTransport());
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
