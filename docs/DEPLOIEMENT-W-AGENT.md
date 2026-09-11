# Déploiement de Scry sur w-agent

Carnet de déploiement, concis et numéroté. Suit les conventions déjà en
place sur w-agent : unités systemd **`--user`**, tunnel Cloudflare
**partagé** (on ajoute une route, on ne le recrée jamais), données hors
du dossier synchronisé `~/projets`.

Référence : `docs/specs/2026-09-11-scry-design.md` §5.1/§5.8/§5.9/§10 ;
`docs/superpowers/plans/2026-09-11-scry-hebergement.md` tâches 5-7.

## 1. Prérequis (sur w-agent)

- **`google-chrome` installé** (PAS chromium — codecs H.264/AAC
  propriétaires, sinon la vidéo Timeliner reste noire).
- **`Xvfb` installé** (framebuffer virtuel — Chrome tourne headful
  dessous, pour ces mêmes codecs et pour le screencast de la vue live).
- **`node >= 20`**.
- **`cloudflared`** déjà en place et déjà lancé — c'est le tunnel
  partagé existant, on y ajoute une route (étape 5), on ne le recrée pas.
- **Une fois, seulement** : activer le linger pour que les services
  `--user` de William survivent à la déconnexion et au reboot (même
  principe que les autres services de w-agent) :
  ```
  loginctl enable-linger will
  ```

## 2. Récupérer le code

Le code vit dans `~/scry` sur w-agent — **hors de `~/projets`**, qui est
synchronisé par Syncthing et ne doit pas héberger ce dépôt.

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

Créer `~/scry-donnees/scry.env` (ce fichier n'est **jamais** commité —
il vit hors git et hors `~/projets`, tout comme le profil Chrome) :

```
SCRY_CDP_URL=http://127.0.0.1:9222
SCRY_DATA_DIR=~/scry-donnees
SCRY_LIVE_PORT=9400
SCRY_LIVE_SECRET=<coller ici le secret généré ci-dessous>
```

Générer ce secret une seule fois, et le coller dans `SCRY_LIVE_SECRET`
ci-dessus :

```
openssl rand -hex 32
```

## 4. Installer les unités systemd

Copier les deux unités fournies dans `scripts/` vers le dossier des
unités utilisateur, puis activer :

```
mkdir -p ~/.config/systemd/user
cp ~/scry/scripts/scry-chrome.service ~/scry/scripts/scry-server.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now scry-chrome scry-server
```

Vérifier que tout tourne :

```
systemctl --user status scry-chrome scry-server
journalctl --user -u scry-server -f
```

## 5. Exposer la vue live

Coller la règle d'ingress de `scripts/cloudflared-scry.yml` dans
`~/.cloudflared/config.yml`, dans la liste `ingress:`, **avant** la
règle catch-all 404 finale (même principe que la règle marketis déjà en
place — la première règle qui correspond gagne).

Puis recharger **sans** couper les autres tunnels :

```
systemctl --user reload cloudflared
```

(ou, si `reload` n'est pas disponible : `kill -HUP <pid de cloudflared>`.)

**Ne jamais faire** `systemctl restart cloudflared` — ça coupe tous les
tunnels actifs sur w-agent, marketis inclus.

## 6. Acceptation (fait par William, connexion comprise)

Depuis une session Claude qui atteint w-agent (SSH ou session Claude
Code distante) :

1. Appeler l'outil `live_start` → il renvoie un lien signé qui expire.
   (Ce lien pointe sur `127.0.0.1:<port>` en local : ouvrir plutôt
   l'URL du tunnel — le hostname choisi à l'étape 5 — en gardant le
   même chemin et le même `?token=...`.)
2. Ouvrir ce lien sur l'iPhone → il montre, en direct, Chrome tournant
   sur w-agent.
3. Naviguer vers Timeliner. Quand le mur de connexion apparaît :
   - appeler `live_mode({mode: 'input'})` ;
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
  ne sort que derrière le tunnel Cloudflare — jamais public.
- Le secret (`scry.env`, donc `SCRY_LIVE_SECRET`) reste hors git et hors
  `~/projets`, en permanence.
- En mode passe-la-main (`input`), le relais d'entrée **ne capture ni
  n'enregistre jamais la saisie** — pas de log, pas de capture d'écran
  du champ mot de passe (spec §5.8).
