# Déploiement de Scry sur w-agent

Carnet de déploiement, concis et numéroté. Suit les conventions déjà en
place sur w-agent : unité systemd **`--user`** pour Chrome, tunnel
Cloudflare **partagé** (on ajoute une route, on ne le recrée jamais),
données hors du dossier synchronisé `~/projets`.

**Ce qui est always-on, c'est Chrome — pas le serveur MCP.** Le serveur
MCP de Scry parle en **stdio** (spec §5.2) à **un** client : une session
Claude Code. Il est donc **lancé par la session** via `scripts/scry-mcp.sh`,
pas tenu en démon (un serveur stdio sans client sur son entrée standard
tournerait à vide ou boucherait en boucle de crash). Une seule unité
systemd, donc : `scry-chrome`.

Référence : `docs/specs/2026-09-11-scry-design.md` §5.1/§5.2/§5.8/§5.9/§10 ;
`docs/superpowers/plans/2026-09-11-scry-hebergement.md` tâches 5-7.

## 1. Prérequis (sur w-agent — déjà vérifiés le 2026-09-11)

- **`google-chrome` installé** (`/usr/bin/google-chrome` — PAS chromium,
  codecs H.264/AAC propriétaires, sinon la vidéo Timeliner reste noire). ✓
- **`Xvfb` installé** (`/usr/bin/Xvfb` — framebuffer virtuel ; Chrome
  tourne headful dessous, pour ces codecs et le screencast de la vue live). ✓
- **`node >= 20`** : sur w-agent, `node` est `~/.local/node/bin/node`
  (v22), **pas** `/usr/bin/node`. `scry-mcp.sh` le résout tout seul ;
  au besoin, forcer avec `SCRY_NODE=/chemin/vers/node`. ✓
- **`cloudflared`** déjà en place : c'est un service **système**
  (`/etc/systemd/system/cloudflared.service`, `User=will`), tunnel
  `w-tradingbot`, qui porte déjà crm/booking/reels/bridge/tableau/marketis.
  Binaire : `/home/will/.local/bin/cloudflared` (pas dans le PATH). ✓
- **Accès SSH par clés** à w-agent depuis le Mac (et l'appli SSH iPhone
  si voulu) — c'est ce qui lance le serveur (étape 5).
- **Linger déjà activé** (`Linger=yes`) pour que le service `--user`
  Chrome survive à la déconnexion et au reboot. Rien à faire ; pour
  mémoire : `loginctl enable-linger will`.

## 2. Récupérer le code

Le code vit dans `~/scry` sur w-agent — **hors de `~/projets`**, qui est
synchronisé par Syncthing. ⚠️ `~/projets/scry` **existe aussi** (via
Syncthing) : ne **jamais** builder ni lancer depuis là — toujours `~/scry`.

```
cd ~
git clone <url du dépôt scry> ~/scry     # la première fois seulement
cd ~/scry
git pull --quiet                          # les fois suivantes
npm ci
npm run build                             # émet dist/src/server.js
```

## 3. Données et secret

Le profil Chrome, la session et les artefacts vivent dans
`~/scry-donnees/` — **hors du dépôt git ET hors de `~/projets`**. Rien
de ce dossier n'est, ni ne sera jamais, commité.

```
mkdir -p ~/scry-donnees
```

Créer `~/scry-donnees/scry.env` (jamais commité — hors git et hors
`~/projets`). `scry-mcp.sh` le source **sur w-agent**, donc rien ne
touche le Mac. **Mettre une vraie valeur dans `SCRY_LIVE_SECRET`** (pas
de chevrons `<...>` : sourcé par bash, `<` casserait le lancement — le
launcher refuse d'ailleurs de démarrer si le secret est vide) :

```
SCRY_CDP_URL=http://127.0.0.1:9222
SCRY_DATA_DIR=$HOME/scry-donnees
SCRY_LIVE_PORT=9400
SCRY_LIVE_SECRET=CHANGE_ME
SCRY_LIVE_PUBLIC_URL=https://scry.wautomatisations.com
```

Générer le secret une seule fois et remplacer `CHANGE_ME` :

```
openssl rand -hex 32
```

`SCRY_LIVE_PUBLIC_URL` fait que `live_start` renvoie directement un lien
sur le tunnel (ouvrable tel quel sur l'iPhone) ; sans lui, le lien
pointe sur `127.0.0.1:9400` et il faut réécrire l'hôte à la main.

## 4. Installer l'unité systemd (Chrome — le seul démon)

```
mkdir -p ~/.config/systemd/user
cp ~/scry/scripts/scry-chrome.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now scry-chrome
```

Vérifier que Chrome tourne et écoute le CDP en local :

```
systemctl --user status scry-chrome
curl -s http://127.0.0.1:9222/json/version | head -c 200; echo
```

## 5. Brancher Claude sur Scry (client MCP, lancé par la session)

Le serveur MCP n'est **pas** un service : la session Claude Code le
lance en stdio via `scripts/scry-mcp.sh` (qui résout `node`, source
`scry.env` sur w-agent, puis `exec node dist/src/server.js`). Deux
câblages, dans le fichier de config MCP de Claude Code — modèle complet
dans `scripts/scry-mcp-client.example.json` :

- **Depuis le Mac ou l'iPhone (SSH)** — le cas « de n'importe où ». Le
  `-o BatchMode=yes` évite qu'une clé manquante bloque le client MCP sur
  une invite silencieuse :
  ```json
  "scry": {
    "command": "ssh",
    "args": ["-o", "BatchMode=yes", "will@w-agent", "~/scry/scripts/scry-mcp.sh"]
  }
  ```
- **Depuis une session Claude Code qui tourne déjà sur w-agent :**
  ```json
  "scry": { "command": "/home/will/scry/scripts/scry-mcp.sh" }
  ```

Aucun secret dans cette config : il reste dans `scry.env` sur w-agent.
Le serveur — et la vue live qu'il ouvre à la demande (`live_start`) — ne
vivent que le temps de la session, et s'arrêtent quand la session se
termine (fermeture de stdin).

## 6. Exposer la vue live sur le tunnel — ⚠️ touche TOUT le public

Cette étape modifie le tunnel `w-tradingbot`, qui porte **tous** les
services publics de w-agent (crm, booking, reels, bridge, tableau,
marketis). À faire posément. Trois temps : la route DNS (une fois), la
règle d'ingress, puis un rechargement **sans coupure**.

**6.1 — Route DNS (une seule fois).** Sans ça, `scry.wautomatisations.com`
ne résout pas (pas de wildcard) :

```
/home/will/.local/bin/cloudflared tunnel route dns w-tradingbot scry.wautomatisations.com
```

**6.2 — Règle d'ingress.** Éditer `~/.cloudflared/config.yml` et coller
la règle de `scripts/cloudflared-scry.yml` **avant** la règle catch-all
finale `- service: http_status:404` (cloudflared prend la première qui
correspond) :

```yaml
  - hostname: scry.wautomatisations.com
    service: http://127.0.0.1:9400
```

(Aparté, pré-existant, sans rapport avec Scry : le fichier a deux règles
`crm.wautomatisations.com` — la seconde est morte, première-qui-gagne.
Ne rien y toucher ici.)

**6.3 — Recharger SANS coupure (relais).** `cloudflared` est un service
**système** sans `ExecReload` : ni `systemctl --user reload`, ni
`kill -HUP` ne rechargent l'ingress. Le patron zéro-coupure (celui déjà
utilisé sur w-agent) est un **relais** — un second connecteur du **même**
tunnel prend le relais pendant que l'unité redémarre avec le nouveau
fichier :

```
# 1. démarrer un réplica temporaire avec le nouveau config
/home/will/.local/bin/cloudflared --config ~/.cloudflared/config.yml tunnel run w-tradingbot &
REPLICA=$!
sleep 6                       # laisser le réplica enregistrer ses connexions
# 2. redémarrer l'unité (elle relit le config, incluant la règle scry)
sudo systemctl restart cloudflared
sleep 4
# 3. retirer le réplica une fois l'unité revenue
kill "$REPLICA"
```

Comme les deux processus servent le même tunnel, Cloudflare route par le
réplica pendant le redémarrage : aucun trou public.

**Repli** si le relais n'est pas possible : `sudo systemctl restart
cloudflared` seul — `Restart=always` le relève en quelques secondes,
mais coupe **brièvement** tous les services le temps de la reconnexion.
**Ne jamais** couper `cloudflared` sans relais ni sans accepter ce blip.

**6.4 — Vérifier :**

```
curl -sI https://scry.wautomatisations.com/ | head -1
```

`426 Upgrade Required` (une session live est ouverte, le chemin atteint
bien le serveur ws) ou `502` (aucune session live) = **OK**. `530`/`404`
= la route DNS ou l'ingress n'est pas prise.

## 7. Acceptation (fait par William, connexion comprise)

Depuis une session Claude branchée sur Scry (étape 5) :

1. Appeler l'outil `live_start` → il renvoie un lien signé qui expire
   (directement sur `https://scry.wautomatisations.com/...` grâce à
   `SCRY_LIVE_PUBLIC_URL`). La vue live démarre à ce moment-là.
2. Ouvrir ce lien sur l'iPhone → une page qui montre, en direct, Chrome
   tournant sur w-agent.
3. Naviguer vers Timeliner. Quand le mur de connexion apparaît :
   - appeler `live_mode({mode: 'input'})` — pendant ce mode, Claude a la
     **perception suspendue** (pas de snapshot/capture) ;
   - **William se connecte lui-même** dans la vue live (ou approuve une
     passkey Google directement sur le téléphone) ;
   - appeler `live_mode({mode: 'read'})` pour revenir en lecture seule.
4. Faire ensuite piloter Scry pour capturer proprement le premier écran
   Timeliner : `snapshot` + `screenshot` + une vignette via
   `fetch_with_session`.

Toute la boucle se fait Mac non touché, et le mot de passe ne passe
jamais par Claude.

## Sécurité

- Le port de debug CDP de Chrome (9222) n'est **jamais** exposé au
  réseau — seul le serveur Scry, sur la même machine (127.0.0.1), s'y
  connecte.
- Le lien de vue live est protégé par un **jeton signé qui expire**, et
  ne sort que derrière le tunnel Cloudflare — jamais public sans jeton.
- Le secret (`scry.env`, donc `SCRY_LIVE_SECRET`) reste hors git et hors
  `~/projets`, en permanence ; il est chargé sur w-agent par
  `scry-mcp.sh`, jamais transmis au Mac. Seul le **jeton** (jamais le
  secret) revient à Claude.
- En mode passe-la-main (`input`), le relais d'entrée **ne capture ni
  n'enregistre jamais la saisie**, et la perception de Claude est
  suspendue (pas de screenshot/snapshot du champ mot de passe) (spec §5.8).
- ⚠️ **Ne jamais** lancer le serveur avec `DEBUG=pw:*` / `DEBUG=pw:protocol`
  sur w-agent : Playwright journaliserait chaque message CDP,
  `Input.dispatchKeyEvent` compris — la seule façon, par l'environnement,
  de défaire le no-capture.
