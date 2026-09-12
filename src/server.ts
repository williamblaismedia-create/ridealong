import { pathToFileURL } from 'node:url';
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

interface Tool { desc: string; shape: Record<string, z.ZodTypeAny>; run: (args: any) => Promise<string> }

// Repeated in the tabs_*/live_* descriptions: v1 binds perception, action and
// the live-view screencast to the PRIMARY tab only. tabs_select/tabs_open just
// change which tab Chrome shows; they do NOT move where Scry looks or acts
// (rebinding via Driver.setPage() is a deferred follow-up). Say so in the
// tool text so the model doesn't assume a switch that never happens.
const PRIMARY_TAB_NOTE =
  'Perception, action et la vue live ciblent TOUJOURS l\'onglet principal ; tabs_select/tabs_open ne font que changer l\'onglet affiche par Chrome, sans deplacer ou Scry regarde/agit.';

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
  // Pause (viewer's pause button): every tool that CHANGES the page waits
  // here until William resumes. Perception is not gated — looking is fine.
  const gate = async (): Promise<void> => { await liveView?.waitWhilePaused(); };
  const tell = (kind: string, label: string): void => { liveView?.announce({ kind, label }); };

  const tools: Record<string, Tool> = {
    navigate: { desc: 'Naviguer l\'onglet principal vers une URL absolue et attendre le chargement du DOM. Renvoie l\'entete [state] (url, titre, pret).', shape: { url: z.string() }, run: async (a) => { await gate(); tell('navigate', `navigate ${a.url}`); return headerLine(await perception.navigate(a.url)); } },
    state: { desc: 'Renvoyer l\'entete [state] courant de l\'onglet principal : url, titre, pret, et si un dialogue natif est ouvert.', shape: {}, run: async () => headerLine(await perception.state()) },
    snapshot: { desc: 'Arbre d\'accessibilite elague de l\'onglet principal, chaque element portant une [ref] stable pour agir par reference. Les grands arbres sont ecrits sur disque (un chemin est renvoye). Suspendu tant que la vue live est en mode input.', shape: { budget: z.number().optional() }, run: async (a) => { refuseInputMode(); const s = await perception.snapshot(a); return `${headerLine(s.state)}\n${s.text}${s.truncated ? `\n[tronqué -> ${s.path}]` : ''}`; } },
    find: { desc: 'Trouver les elements de l\'onglet principal dont le role/nom correspond a une requete ; renvoie leurs [ref]. Suspendu tant que la vue live est en mode input.', shape: { query: z.string() }, run: async (a) => { refuseInputMode(); const hits = await perception.find(a.query); return hits.map((n) => `[${n.ref}] ${n.role} "${n.name}"`).join('\n') || '(aucun)'; } },
    read: { desc: 'Lire le texte visible (innerText) de l\'onglet principal, tronque a un budget de tokens (texte complet ecrit sur disque). Suspendu tant que la vue live est en mode input.', shape: { budget: z.number().optional() }, run: async (a) => { refuseInputMode(); const r = await perception.read(a); return `${r.text}${r.truncated ? `\n[tronqué -> ${r.path}]` : ''}`; } },
    screenshot: { desc: 'Capture JPEG de l\'onglet principal (pleine page en option), ecrite sur disque ; renvoie un chemin + resume. Suspendu tant que la vue live est en mode input.', shape: { fullPage: z.boolean().optional() }, run: async (a) => { refuseInputMode(); return (await perception.screenshot(a)).summary; } },
    act: { desc: 'Agir sur un element de l\'onglet principal par [ref] : click, hover, type (remplir), ou press (touche). Renvoie l\'entete [state] resultant.', shape: { ref: z.string(), verb: z.enum(['click', 'hover', 'type', 'press']), text: z.string().optional() }, run: async (a) => { await gate(); await action.act(a.ref, a.verb, a.text); return headerLine(await perception.state()); } },
    fill: { desc: 'Remplir plusieurs champs de l\'onglet principal par [ref] en un appel. Renvoie l\'entete [state] resultant.', shape: { fields: z.array(z.object({ ref: z.string(), value: z.string() })) }, run: async (a) => { await gate(); await action.fill(a.fields); return headerLine(await perception.state()); } },
    scroll: { desc: 'Faire defiler l\'onglet principal vers le haut ou le bas, d\'un nombre de pixels optionnel.', shape: { dir: z.enum(['up', 'down']), amount: z.number().optional() }, run: async (a) => { await gate(); await action.scroll(a.dir, a.amount); return headerLine(await perception.state()); } },
    network_requests: { desc: 'Lister les requetes reseau capturees de l\'onglet principal (url, statut, type), filtre par sous-chaine optionnel. Sans les corps.', shape: { filter: z.string().optional() }, run: async (a) => network.requests(a.filter).map((r) => `${r.status} ${r.type} ${r.url}`).join('\n') || '(aucune)' },
    fetch_with_session: { desc: 'Recuperer une URL avec les cookies de la session du navigateur (contexte de l\'onglet principal) ; le corps est ecrit sur disque, un chemin + resume est renvoye.', shape: { url: z.string() }, run: async (a) => (await network.fetchWithSession(a.url)).summary },
    tabs_list: { desc: `Lister les onglets ouverts (id, url, titre, lequel est actif). ${PRIMARY_TAB_NOTE}`, shape: {}, run: async () => tabsLines(await tabs.list()) },
    tabs_open: { desc: `Ouvrir un nouvel onglet a une URL et le mettre au premier plan ; renvoie son id. ${PRIMARY_TAB_NOTE}`, shape: { url: z.string() }, run: async (a) => { await gate(); tell('tab', `ouvre un onglet ${a.url}`); return `ouvert onglet ${await tabs.open(a.url)}`; } },
    tabs_close: { desc: 'Fermer un onglet par id (l\'onglet principal ne peut pas etre ferme). Si l\'onglet actif est ferme, le focus revient a l\'onglet principal.', shape: { id: z.number() }, run: async (a) => { await gate(); tell('tab', `ferme l'onglet ${a.id}`); await tabs.close(a.id); return `ferme\n${tabsLines(await tabs.list())}`; } },
    tabs_select: { desc: `Mettre un onglet au premier plan par id. NE FAIT QUE cela : ${PRIMARY_TAB_NOTE}`, shape: { id: z.number() }, run: async (a) => { await gate(); tell('tab', `affiche l'onglet ${a.id}`); await tabs.select(a.id); return headerLine(await perception.state()); } },
  };

  if (liveView) {
    tools.live_start = { desc: `Demarrer (ou reutiliser) la vue live et renvoyer un lien signe et expirant que William ouvre pour regarder l\'onglet principal en direct. ttlSec est borne a [30,3600], defaut 900. ${PRIMARY_TAB_NOTE}`, shape: { ttlSec: z.number().int().min(30).max(3600).optional() }, run: async (a) => { await liveView.ensureStarted(); return liveView.url(a.ttlSec); } };
    tools.live_mode = { desc: 'Basculer la vue live entre "read" (regarder seulement) et "input" (passe-la-main : la souris/le clavier de William sont relayes vers l\'onglet principal). La perception est suspendue en mode input.', shape: { mode: z.enum(['read', 'input']) }, run: async (a) => { liveView.setMode(a.mode); return `mode: ${a.mode}`; } };
    tools.live_stop = { desc: 'Arreter la vue live et invalider son lien. Re-appelable : un live_start ulterieur sert un nouveau lien.', shape: {}, run: async () => { await liveView.stop(); return 'vue live arretee'; } };
  }

  const server = new McpServer({ name: 'scry', version: '0.1.0' });
  for (const [name, t] of Object.entries(tools)) {
    server.registerTool(name, { description: t.desc, inputSchema: t.shape }, async (args: any) => ({ content: [{ type: 'text', text: await t.run(args) }] }));
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
  let liveView: LiveView | undefined;
  // Late-bound: liveView is created just below; the observer reads it at call time.
  const action = new Action(driver, (ref) => perception.resolveRefNode(ref), (ev) => liveView?.announce({ kind: ev.verb, label: ev.label, x: ev.x, y: ev.y }));

  if (cfg.secret) {
    try {
      liveView = new LiveView(driver, { secret: cfg.secret, publicUrl: cfg.livePublicUrl, quality: cfg.liveQuality });
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

// n1: pathToFileURL handles symlinks/relative argv[1] and OS path encoding,
// unlike a hand-built `file://${process.argv[1]}` string.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
