import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfig } from './config.js';
import { Driver } from './driver.js';
import { ArtifactStore } from './artifact-store.js';
import { Perception, type StateHeader } from './perception.js';
import { Action } from './action.js';
import { Network } from './network.js';
import { Tabs, type TabInfo } from './tabs.js';
import { LiveView } from './live-view.js';

function headerLine(s: StateHeader): string {
  return `[state] url=${s.url} title=${JSON.stringify(s.title)} ready=${s.ready} dialog=${s.dialogOpen}`;
}

function tabsLines(list: TabInfo[]): string {
  return list.map((t) => `[${t.id}]${t.active ? ' *' : ''} ${t.url} — ${t.title}`).join('\n') || '(aucun)';
}

interface Tool { shape: Record<string, z.ZodTypeAny>; run: (args: any) => Promise<string> }

export function buildServer(deps: { perception: Perception; action: Action; network: Network; liveView?: LiveView }) {
  const { perception, action, network, liveView } = deps;
  const tabs = new Tabs(perception.driver);

  // NO-CAPTURE (Spec §5.8, hard constraint): while the live view is in `input`
  // mode, William is typing his own credentials into Chrome by hand. During
  // that window Claude's perception tools MUST be suspended so the tool can't
  // capture the keystrokes/values indirectly — a screenshot of a "show
  // password" toggle, a snapshot/find/read of the field, a one-time code on
  // screen. The relay itself already retains nothing (live-view.ts); this is
  // the other half of the guarantee, on the perception side.
  const refuseInputMode = (): void => {
    if (liveView?.getMode() === 'input') {
      throw new Error('vue live en mode input : perception suspendue (spec §5.8)');
    }
  };

  const tools: Record<string, Tool> = {
    navigate: { shape: { url: z.string() }, run: async (a) => headerLine(await perception.navigate(a.url)) },
    state: { shape: {}, run: async () => headerLine(await perception.state()) },
    snapshot: { shape: { budget: z.number().optional() }, run: async (a) => { refuseInputMode(); const s = await perception.snapshot(a); return `${headerLine(s.state)}\n${s.text}${s.truncated ? `\n[tronqué -> ${s.path}]` : ''}`; } },
    find: { shape: { query: z.string() }, run: async (a) => { refuseInputMode(); const hits = await perception.find(a.query); return hits.map((n) => `[${n.ref}] ${n.role} "${n.name}"`).join('\n') || '(aucun)'; } },
    read: { shape: { budget: z.number().optional() }, run: async (a) => { refuseInputMode(); const r = await perception.read(a); return `${r.text}${r.truncated ? `\n[tronqué -> ${r.path}]` : ''}`; } },
    screenshot: { shape: { fullPage: z.boolean().optional() }, run: async (a) => { refuseInputMode(); return (await perception.screenshot(a)).summary; } },
    act: { shape: { ref: z.string(), verb: z.enum(['click', 'hover', 'type', 'press']), text: z.string().optional() }, run: async (a) => { await action.act(a.ref, a.verb, a.text); return headerLine(await perception.state()); } },
    fill: { shape: { fields: z.array(z.object({ ref: z.string(), value: z.string() })) }, run: async (a) => { await action.fill(a.fields); return headerLine(await perception.state()); } },
    scroll: { shape: { dir: z.enum(['up', 'down']), amount: z.number().optional() }, run: async (a) => { await action.scroll(a.dir, a.amount); return headerLine(await perception.state()); } },
    network_requests: { shape: { filter: z.string().optional() }, run: async (a) => network.requests(a.filter).map((r) => `${r.status} ${r.type} ${r.url}`).join('\n') || '(aucune)' },
    fetch_with_session: { shape: { url: z.string() }, run: async (a) => (await network.fetchWithSession(a.url)).summary },
    tabs_list: { shape: {}, run: async () => tabsLines(await tabs.list()) },
    tabs_open: { shape: { url: z.string() }, run: async (a) => `ouvert onglet ${await tabs.open(a.url)}` },
    tabs_close: { shape: { id: z.number() }, run: async (a) => { await tabs.close(a.id); return `ferme\n${tabsLines(await tabs.list())}`; } },
    tabs_select: { shape: { id: z.number() }, run: async (a) => { await tabs.select(a.id); return headerLine(await perception.state()); } },
  };

  if (liveView) {
    tools.live_start = { shape: { ttlSec: z.number().optional() }, run: async (a) => { await liveView.ensureStarted(); return liveView.url(a.ttlSec); } };
    tools.live_mode = { shape: { mode: z.enum(['read', 'input']) }, run: async (a) => { liveView.setMode(a.mode); return `mode: ${a.mode}`; } };
    tools.live_stop = { shape: {}, run: async () => { await liveView.stop(); return 'vue live arretee'; } };
  }

  const server = new McpServer({ name: 'scry', version: '0.1.0' });
  for (const [name, t] of Object.entries(tools)) {
    server.tool(name, t.shape, async (args: any) => ({ content: [{ type: 'text', text: await t.run(args) }] }));
  }

  return Object.assign(server, {
    listToolNames: () => Object.keys(tools),
    callTool: (name: string, args: any) => {
      if (!tools[name]) throw new Error(`outil inconnu: ${name}`);
      return tools[name].run(args);
    },
  });
}

export async function main(): Promise<void> {
  const cfg = loadConfig();
  const driver = await Driver.connect(cfg.cdpUrl, { viewport: cfg.viewport, defaultTimeoutMs: cfg.defaultTimeoutMs });
  const store = new ArtifactStore(cfg.dataDir);
  const network = new Network(driver, store); network.start();
  const perception = new Perception(driver, store, cfg.readBudgetChars);
  const action = new Action(driver, (ref) => perception.resolveRefNode(ref));

  let liveView: LiveView | undefined;
  if (cfg.secret) {
    try {
      liveView = new LiveView(driver, { secret: cfg.secret, publicUrl: cfg.livePublicUrl });
      await liveView.start(cfg.liveViewPort);
    } catch (e) {
      // A bind failure (stale process, restart race on an always-on host)
      // must not take the whole MCP server down with it — degrade to a
      // working core server without the live_* tools instead. Never log
      // the secret value, only the error.
      console.error('[scry] live-view indisponible : ' + (e as Error).message);
      liveView = undefined;
    }
  } else {
    console.error('[scry] SCRY_LIVE_SECRET absent : vue live desactivee.');
  }

  const server = buildServer({ perception, action, network, liveView });

  // Exit cleanly when the client goes away. Over SSH (the primary wiring),
  // Claude Code kills the LOCAL ssh on shutdown; the remote node gets EOF on
  // stdin and NO signal, so without this the process would linger forever —
  // holding the live-view port and a CDP connection, which makes every later
  // session hit EADDRINUSE and silently lose its live_* tools (C3). Cover all
  // three: transport close, stdin EOF, and the usual termination signals.
  const transport = new StdioServerTransport();
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await liveView?.stop().catch(() => {});
    await driver.close().catch(() => {});
    process.exit(0);
  };
  transport.onclose = () => void shutdown();
  process.stdin.once('end', () => void shutdown());
  for (const s of ['SIGTERM', 'SIGHUP', 'SIGINT'] as const) process.once(s, () => void shutdown());
  await server.connect(transport);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
