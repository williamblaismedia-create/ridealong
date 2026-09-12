import { pathToFileURL } from 'node:url';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
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
import { type LiveViewLike } from './live-view.js';
import { LiveViewSlot } from './live-view-slot.js';
import { PageLog } from './console.js';

function headerLine(s: StateHeader): string {
  return `[state] url=${s.url} title=${JSON.stringify(s.title)} ready=${s.ready} dialog=${s.dialogOpen}`;
}

function tabsLines(list: TabInfo[]): string {
  return list.map((t) => `[${t.id}]${t.active ? ' *' : ''} ${t.url} — ${t.title}`).join('\n') || '(aucun)';
}

interface Tool { desc: string; shape: Record<string, z.ZodTypeAny>; run: (args: any) => Promise<string> }

// Repeated in the tabs_*/live_* descriptions: perception, action and the
// live view all follow ONE target tab. tabs_select / tabs_open MOVE that
// target (Driver.setPage), so after a switch the model must snapshot again —
// refs from the previous tab no longer apply.
const PRIMARY_TAB_NOTE =
  'Perception, action et la vue live suivent l\'onglet CIBLE ; tabs_select/tabs_open deplacent cette cible (refaire un snapshot apres un changement, les [ref] de l\'autre onglet ne valent plus). William peut aussi changer d\'onglet depuis la vue live.';

export function buildServer(deps: { perception: Perception; action: Action; network: Network; liveView?: LiveViewLike; pageLog?: PageLog }) {
  const { perception, action, network, liveView, pageLog } = deps;
  const tabs = new Tabs(perception.driver);
  liveView?.setTabSelector?.((id) => tabs.select(id)); // a chip tap on the viewer moves the target

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
    navigate: { desc: 'Naviguer l\'onglet cible vers une URL absolue et attendre le chargement du DOM, sans cache HTTP ni service worker (contenu toujours a jour). Renvoie l\'entete [state] (url, titre, pret).', shape: { url: z.string() }, run: async (a) => { await gate(); tell('navigate', `navigate ${a.url}`); return headerLine(await perception.navigate(a.url)); } },
    reload: { desc: 'Recharger l\'onglet cible (rechargement complet : le cache HTTP et les service workers sont contournes sur tous les onglets, donc un site que tu viens de deployer s\'affiche a jour). Renvoie l\'entete [state].', shape: {}, run: async () => { await gate(); tell('navigate', 'reload'); await perception.driver.reload(); return headerLine(await perception.state()); } },
    state: { desc: 'Renvoyer l\'entete [state] courant de l\'onglet cible : url, titre, pret, et si un dialogue natif est ouvert.', shape: {}, run: async () => headerLine(await perception.state()) },
    snapshot: { desc: 'Arbre d\'accessibilite elague de l\'onglet cible, chaque element portant une [ref] stable pour agir par reference. Les grands arbres sont ecrits sur disque (un chemin est renvoye). Suspendu tant que la vue live est en mode input.', shape: { budget: z.number().optional() }, run: async (a) => { refuseInputMode(); const s = await perception.snapshot(a); return `${headerLine(s.state)}\n${s.text}${s.truncated ? `\n[tronqué -> ${s.path}]` : ''}`; } },
    find: { desc: 'Trouver les elements de l\'onglet cible dont le role/nom correspond a une requete ; renvoie leurs [ref]. Suspendu tant que la vue live est en mode input.', shape: { query: z.string() }, run: async (a) => { refuseInputMode(); const hits = await perception.find(a.query); return hits.map((n) => `[${n.ref}] ${n.role} "${n.name}"`).join('\n') || '(aucun)'; } },
    read: { desc: 'Lire le texte visible (innerText) de l\'onglet cible, tronque a un budget de tokens (texte complet ecrit sur disque). Suspendu tant que la vue live est en mode input.', shape: { budget: z.number().optional() }, run: async (a) => { refuseInputMode(); const r = await perception.read(a); return `${r.text}${r.truncated ? `\n[tronqué -> ${r.path}]` : ''}`; } },
    screenshot: { desc: 'Capture JPEG de l\'onglet cible (pleine page en option), ecrite sur disque ; renvoie un chemin + resume. Suspendu tant que la vue live est en mode input.', shape: { fullPage: z.boolean().optional() }, run: async (a) => { refuseInputMode(); return (await perception.screenshot(a)).summary; } },
    act: { desc: 'Agir sur un element de l\'onglet cible par [ref] : click, hover, type (remplir), ou press (touche). Renvoie l\'entete [state] resultant.', shape: { ref: z.string(), verb: z.enum(['click', 'hover', 'type', 'press']), text: z.string().optional() }, run: async (a) => { await gate(); await action.act(a.ref, a.verb, a.text); return headerLine(await perception.state()); } },
    fill: { desc: 'Remplir plusieurs champs de l\'onglet cible par [ref] en un appel. Renvoie l\'entete [state] resultant.', shape: { fields: z.array(z.object({ ref: z.string(), value: z.string() })) }, run: async (a) => { await gate(); await action.fill(a.fields); return headerLine(await perception.state()); } },
    scroll: { desc: 'Faire defiler l\'onglet cible vers le haut ou le bas, d\'un nombre de pixels optionnel.', shape: { dir: z.enum(['up', 'down']), amount: z.number().optional() }, run: async (a) => { await gate(); await action.scroll(a.dir, a.amount); return headerLine(await perception.state()); } },
    diff: { desc: 'Ce qui a change sur l\'onglet cible depuis le dernier snapshot/find/diff : elements apparus et disparus (role + nom), avec leurs [ref] a jour. Bien moins long qu\'un snapshot complet apres une action. Suspendu tant que la vue live est en mode input.', shape: {}, run: async () => { refuseInputMode(); const d = await perception.diff(); const fmt = (n: { ref: string; role: string; name: string }) => `[${n.ref}] ${n.role} "${n.name}"`; return `${headerLine(await perception.state())}\n+ apparus (${d.added.length}):\n${d.added.map(fmt).join('\n') || '  (aucun)'}\n- disparus (${d.removed.length}):\n${d.removed.map(fmt).join('\n') || '  (aucun)'}`; } },
    console_errors: { desc: 'Erreurs de l\'onglet cible depuis le debut (ou le dernier clear) : console.error/warn, exceptions non attrapees, requetes echouees, reponses HTTP 4xx/5xx. clear=true vide la liste apres lecture. Indispensable pour tester une app que tu viens de deployer.', shape: { clear: z.boolean().optional() }, run: async (a) => { if (!pageLog) return '(journal de console non disponible)'; const out = pageLog.format(); if (a.clear) pageLog.clear(); return out; } },
    network_requests: { desc: 'Lister les requetes reseau capturees de l\'onglet cible (url, statut, type), filtre par sous-chaine optionnel. Sans les corps.', shape: { filter: z.string().optional() }, run: async (a) => network.requests(a.filter).map((r) => `${r.status} ${r.type} ${r.url}`).join('\n') || '(aucune)' },
    fetch_with_session: { desc: 'Recuperer une URL avec les cookies de la session du navigateur (contexte de l\'onglet cible) ; le corps est ecrit sur disque, un chemin + resume est renvoye.', shape: { url: z.string() }, run: async (a) => (await network.fetchWithSession(a.url)).summary },
    tabs_list: { desc: `Lister les onglets ouverts (id, url, titre, lequel est actif). ${PRIMARY_TAB_NOTE}`, shape: {}, run: async () => tabsLines(await tabs.list()) },
    tabs_open: { desc: `Ouvrir un nouvel onglet a une URL et le mettre au premier plan ; renvoie son id. ${PRIMARY_TAB_NOTE}`, shape: { url: z.string() }, run: async (a) => { await gate(); tell('tab', `ouvre un onglet ${a.url}`); return `ouvert onglet ${await tabs.open(a.url)}`; } },
    tabs_close: { desc: 'Fermer un onglet par id (le dernier onglet ne peut pas etre ferme). Si c\'est l\'onglet cible, la cible passe a son voisin.', shape: { id: z.number() }, run: async (a) => { await gate(); tell('tab', `ferme l'onglet ${a.id}`); await tabs.close(a.id); return `ferme\n${tabsLines(await tabs.list())}`; } },
    tabs_select: { desc: `Mettre un onglet au premier plan par id. NE FAIT QUE cela : ${PRIMARY_TAB_NOTE}`, shape: { id: z.number() }, run: async (a) => { await gate(); tell('tab', `affiche l'onglet ${a.id}`); await tabs.select(a.id); return headerLine(await perception.state()); } },
  };

  if (liveView) {
    tools.live_start = { desc: `Demarrer (ou reutiliser) la vue live et renvoyer un lien signe et expirant que William ouvre pour regarder l\'onglet cible en direct. ttlSec est borne a [30,3600], defaut 900. ${PRIMARY_TAB_NOTE}`, shape: { ttlSec: z.number().int().min(30).max(3600).optional() }, run: async (a) => { await liveView.ensureStarted(); return `${liveView.url(a.ttlSec)}\n(Sur un appareil qui a deja ouvert un lien Scry, l\'adresse nue sans #token suffit pendant 30 jours : a mettre en favori.)`; } };
    tools.live_mode = { desc: 'Basculer la vue live entre "read" (regarder seulement) et "input" (passe-la-main : la souris/le clavier de William sont relayes vers l\'onglet cible). La perception est suspendue en mode input.', shape: { mode: z.enum(['read', 'input']) }, run: async (a) => { liveView.setMode(a.mode); return `mode: ${a.mode}`; } };
    tools.ask_approval = { desc: 'Demander l\'accord de William AVANT une action sensible (paiement, envoi, suppression, publication, connexion a un compte). La question s\'affiche sur la vue live avec Approuver / Refuser ; l\'outil attend la reponse (timeoutSec, defaut 300). N\'agis que sur APPROUVE. Sans spectateur connecte, la reponse le dit et donne le lien a transmettre.', shape: { question: z.string().min(1).max(300), timeoutSec: z.number().int().min(5).max(1800).optional() }, run: async (a) => {
      const v = await liveView.ask(a.question, { timeoutMs: (a.timeoutSec ?? 300) * 1000 });
      if (v === 'approved') return `APPROUVE par William : « ${a.question} »`;
      if (v === 'denied') return `REFUSE par William : « ${a.question} » — ne fais pas cette action.`;
      if (v === 'timeout') return `SANS REPONSE apres ${a.timeoutSec ?? 300} s : « ${a.question} » — ne fais pas cette action, redemande plus tard.`;
      await liveView.ensureStarted();
      return `AUCUN SPECTATEUR connecte : William n\'a pas la vue live ouverte. Donne-lui ce lien puis redemande : ${liveView.url(3600)}`;
    } };
    tools.live_stop = { desc: 'Arreter la vue live et invalider son lien. Re-appelable : un live_start ulterieur sert un nouveau lien.', shape: {}, run: async () => { await liveView.stop(); return 'vue live arretee'; } };
  }

  if (liveView) {
    tools.inbox = { desc: 'Ce que William a dit ou pointe depuis la vue live (« William dit : … », « William pointe : bouton « Login » »). Ces lignes arrivent aussi d\'elles-memes au bas de chaque resultat d\'outil ; appelle inbox avec waitSec pour ATTENDRE une consigne de William (max 600 s).', shape: { waitSec: z.number().int().min(0).max(600).optional() }, run: async (a) => { const items = await liveView.waitInbox((a.waitSec ?? 0) * 1000); return items.length ? items.map((l) => `[william] ${l}`).join('\n') : '(rien de William pour le moment)'; } };
  }

  // Every result carries what William said/pointed meanwhile, so Claude sees
  // it without polling. `inbox` itself drains explicitly (no double print).
  const run = async (name: string, args: any): Promise<string> => {
    const out = await tools[name].run(args);
    if (!liveView || name === 'inbox') return out;
    const items = liveView.drainInbox();
    return items.length ? `${out}\n${items.map((l) => `[william] ${l}`).join('\n')}` : out;
  };

  // Claude Code "channels": with `claude --dangerously-load-development-channels
  // server:ridealong`, notifications/claude/channel land in the conversation
  // at once, even while Claude is idle. Without the flag they are ignored and
  // the same lines still arrive at the foot of the next tool result.
  const server = new McpServer({ name: 'ridealong', version: '0.1.0' }, {
    capabilities: { experimental: { 'claude/channel': {} } },
    instructions: 'Ridealong pilote un vrai Chrome que William regarde en direct. Ses messages, pointages, prises de controle et pauses arrivent soit comme <channel source="ridealong"> (immediat), soit en lignes [william] au bas des resultats d\'outils. Lis-les et agis en consequence ; en Manuel, attends qu\'il rende la main.',
  });
  liveView?.setEventListener?.((ev) => {
    void (server.server as any).notification({ method: 'notifications/claude/channel', params: { content: ev.text, meta: { kind: ev.kind } } }).catch(() => { /* client without channels */ });
  });
  for (const [name, t] of Object.entries(tools)) {
    server.registerTool(name, { description: t.desc, inputSchema: t.shape }, async (args: any) => ({ content: [{ type: 'text', text: await run(name, args) }] }));
  }

  return Object.assign(server, {
    listToolNames: () => Object.keys(tools),
    callTool: (name: string, args: any) => {
      if (!tools[name]) throw new Error(`outil inconnu: ${name}`);
      return run(name, args);
    },
  });
}

export async function main(): Promise<void> {
  const cfg = loadConfig();
  // A resolution picked from the viewer outlives the session: viewport.json
  // in the data dir overrides SCRY_VIEWPORT_* until changed again.
  const viewportFile = join(cfg.dataDir, 'viewport.json');
  let viewport = cfg.viewport;
  try {
    const v = JSON.parse(readFileSync(viewportFile, 'utf8'));
    if (Number.isInteger(v.width) && Number.isInteger(v.height) && v.width >= 640 && v.height >= 400) viewport = { width: v.width, height: v.height };
  } catch { /* none saved */ }
  const driver = await Driver.connect(cfg.cdpUrl, { viewport, defaultTimeoutMs: cfg.defaultTimeoutMs, browserCache: cfg.browserCache });
  const store = new ArtifactStore(cfg.dataDir);
  const network = new Network(driver, store); network.start();
  const pageLog = new PageLog(driver); pageLog.start();
  const perception = new Perception(driver, store, cfg.readBudgetChars);
  let liveView: LiveViewLike | undefined;
  // Late-bound: liveView is created just below; the observer reads it at call time.
  const action = new Action(driver, (ref) => perception.resolveRefNode(ref), (ev) => liveView?.announce({ kind: ev.verb, label: ev.label, x: ev.x, y: ev.y }));

  if (cfg.secret) {
    try {
      // Owner of the live-view port, or follower of the session that owns it —
      // and promoted to owner if that session goes away (see LiveViewSlot).
      liveView = await LiveViewSlot.create(driver, { secret: cfg.secret, port: cfg.liveViewPort, publicUrl: cfg.livePublicUrl, quality: cfg.liveQuality, video: cfg.video, bind: cfg.liveBind }, (m) => console.error('[ridealong] ' + m));
    } catch (e) {
      // Any other failure degrades to a core server without live_* tools.
      // Never log the secret value, only the error.
      console.error('[ridealong] live-view indisponible : ' + (e as Error).message);
      liveView = undefined;
    }
  } else {
    console.error('[ridealong] SCRY_LIVE_SECRET absent : vue live desactivee.');
  }

  liveView?.setViewportSink?.(async (v) => { mkdirSync(cfg.dataDir, { recursive: true }); writeFileSync(viewportFile, JSON.stringify(v)); });

  const server = buildServer({ perception, action, network, liveView, pageLog });

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
