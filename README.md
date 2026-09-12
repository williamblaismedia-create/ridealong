# Scry

*English: [README.en.md](README.en.md)*

![démo](docs/demo.gif)

Un navigateur piloté par Claude, que vous pouvez **regarder en direct** et
**reprendre en main** à tout moment. Scry est un serveur MCP (stdio) qui
conduit un vrai Google Chrome par CDP, et une **vue live** : page web avec
flux vidéo H.264 (ou images JPEG), curseur de Claude, journal des actions,
pause, mode Manuel (vos clics, clavier et défilement vont dans Chrome),
onglets, choix de résolution.

## Deux façons de l'utiliser

**Sur la machine que Claude pilote** (le plus simple, aucune infrastructure) :

```
git clone <ce dépôt> && cd scry && npm ci && npm run build
claude mcp add scry -- "$PWD/scripts/scry-local.sh"
```

Le lanceur démarre Chrome avec son port de debug, génère un secret dans
`~/scry-donnees/scry.env` la première fois, puis lance le serveur. Dans
Claude : « ouvre timeliner.io et donne-moi la vue live » → un lien
`http://127.0.0.1:9400/#token=…` à ouvrir dans un navigateur. `ffmpeg` sur
la machine active la vidéo (NVENC, VideoToolbox sur Mac, sinon logiciel) ;
sans ffmpeg, la vue live fonctionne en images JPEG.

**Sur un serveur toujours allumé** (Chrome sous Xvfb, tunnel Cloudflare,
relais SSH depuis le Mac) : voir `docs/DEPLOIEMENT-W-AGENT.md`.

## Outils MCP

`navigate`, `state`, `snapshot`, `find`, `read`, `screenshot`, `act`, `fill`,
`scroll`, `network_requests`, `fetch_with_session`, `tabs_list`, `tabs_open`,
`tabs_close`, `tabs_select`, `reload`, `diff`, `console_errors`, `live_start`,
`live_mode`, `live_stop`, `ask_approval`, `inbox`.

Perception, action et vue live suivent un **onglet cible** que
`tabs_select`/`tabs_open` déplacent, ou qu'un tap sur un onglet de la vue
live déplace aussi.

## Barre d'état Claude Code

Avec le relais local, `scripts/scry-statusline.sh` affiche le lien de la vue
live dans la barre d'état pendant qu'une session Scry tourne (`statusLine`
dans `~/.claude/settings.json`).

## Garanties

- **Sans capture** : en mode Manuel, rien de ce que vous tapez n'est stocké,
  journalisé ni visible par Claude (sa perception est suspendue). Les champs
  mot de passe ne remontent jamais leur valeur dans les snapshots.
- **Lien signé et expirant** pour la vue live (HMAC, 30 s à 1 h), jamais
  dans l'historique du navigateur ni dans un journal serveur.

## Variables

Voir `src/config.ts` : `SCRY_CDP_URL`, `SCRY_DATA_DIR`, `SCRY_VIEWPORT_*`,
`SCRY_LIVE_PORT`, `SCRY_LIVE_SECRET`, `SCRY_LIVE_PUBLIC_URL`,
`SCRY_LIVE_QUALITY`, `SCRY_VIDEO`, `SCRY_VIDEO_ENCODER`, `SCRY_VIDEO_KBPS`,
`SCRY_VIDEO_FPS`, `SCRY_FFMPEG`.

## Développement

`npm test` (Vitest, lance un Chromium de test), `npm run build`.
