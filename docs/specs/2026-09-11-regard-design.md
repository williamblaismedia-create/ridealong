# Regard — des yeux sur le web pour Claude

**Date :** 2026-09-11
**Statut :** design, en attente de revue
**Nom de travail :** « Regard » (provisoire, voir Questions ouvertes)

> Prose en français pour la revue ; identifiants et code en anglais.

## 1. But

Donner à Claude une **couche de perception et d'action sur un vrai navigateur**, réutilisable, permanente. Claude voit une page, la comprend, et agit dedans — dans les comptes de William, via **sa session** — sans jamais toucher à ses mots de passe. Le navigateur vit sur **w-agent**, toujours allumé ; on le pilote de n'importe où, iPhone compris ; et un **lien sécurisé** donne une vue en temps réel de ce qui se passe.

Ce n'est pas « un automate de navigateur ». C'est **les yeux et les mains de Claude**, pensés pour la façon dont un agent travaille : lire en structure plutôt qu'en pixels, garder les gros paquets hors du contexte de Claude, agir par référence plutôt qu'en devinant des coordonnées.

Premier vrai usage, qui sert de test d'acceptation : finir la copie de l'interface Timeliner (~50 écrans) sans occuper le Mac.

## 2. Non-buts (YAGNI)

Volontairement hors v1 ; on ajoutera sur du besoin réel, pas sur de l'hypothèse :

- **Multi-moteur** (Firefox, WebKit). On vise le vrai Google Chrome.
- **Multi-utilisateur / multi-tenant.** C'est l'outil de William.
- **Enregistrement / rejeu** de sessions.
- **Interface web léchée.** La vue temps réel v1 reste minimale.
- **Garde-fous d'action dans l'outil, journal d'audit, posture lecture-seule par défaut.** Retirés à la demande de William. L'outil ne police pas Claude.

Hors de portée par principe, jamais négociable :

- **Claude ne reçoit ni ne tape aucun mot de passe.** L'outil ne construit aucun canal pour lui livrer un secret. L'authentification vit sur la **session**, jamais sur le mot de passe (voir §9).

## 3. Contexte d'usage

- **Qui pilote :** Claude, depuis une session Claude Code qui atteint w-agent (terminal SSH ou session distante). William déclenche et supervise depuis son Mac ou son iPhone.
- **Où tout tourne :** w-agent (serveur Linux always-on). Le Mac et l'iPhone ne sont que des télécommandes.
- **Ce que William voit :** un lien temps réel, ouvrable sur téléphone, montrant le navigateur en direct.

## 4. Architecture — vue d'ensemble

```
  iPhone / Mac (télécommande)
        │  (SSH par clés / session distante, derrière le tunnel Cloudflare)
        ▼
  Claude Code  ──MCP──▶  Serveur Regard (Node/TS, sur w-agent)
                              │  CDP (Chrome DevTools Protocol)
                              ▼
                        Google Chrome (w-agent, always-on,
                        profil persistant = session de William,
                        headful sous Xvfb pour codecs + vue live)
                              │
        ┌─────────────────────┼───────────────────────┐
        ▼                     ▼                        ▼
   Perception            Action                   Vue live + passe-la-main
   (snapshot, find,      (par référence :         (screencast CDP → page
    lecture ciblée,       clic, saisie, form,      web sécurisée ; lecture
    delta, réseau)        upload/download)         seule OU entrée relayée)
        │
        ▼
   Magasin disque (w-agent) : gros DOM, captures, réponses réseau, artefacts.
   Claude ne reçoit qu'un CHEMIN + un résumé compact.
```

Chaque unité a un seul rôle, une interface nette, et se teste seule.

## 5. Composants

### 5.1 Hôte Chrome (`chrome-host`)
- **Rôle :** un vrai Google Chrome sur w-agent, toujours allumé, avec un **profil persistant** (les sessions de William tiennent d'un jour à l'autre). Lancé **headful sous Xvfb** (framebuffer virtuel) : nécessaire pour les codecs propriétaires (H.264/AAC → les vidéos ne sont pas noires) et pour le screencast de la vue live. Port de debug CDP ouvert **en local uniquement** (jamais exposé au réseau ; on y accède par le serveur Regard sur la même machine).
- **Interface :** un endpoint CDP local (`ws://127.0.0.1:<port>`).
- **Dépend de :** Google Chrome installé, Xvfb, un superviseur de processus (systemd user unit, comme les autres services de w-agent).

### 5.2 Cœur pilote CDP (`driver`)
- **Rôle :** ouvre et maintient la connexion CDP, gère les cibles (onglets), **se reconnecte** si Chrome redémarre, applique un **viewport fixe** et des attentes déterministes. C'est la seule unité qui parle CDP directement ; tout le reste passe par elle.
- **Interface :** primitives internes — `navigate`, `waitFor`, `snapshot`, `screenshot`, `evaluate`, `click`, `type`, `screencastStart/Stop`, `onDialog`, `tabs`.
- **Dépend de :** la bibliothèque CDP retenue (voir §14).

### 5.3 Serveur MCP (`mcp-server`)
- **Rôle :** expose à Claude un jeu d'outils propres (voir §7). Traduit chaque appel d'outil en primitives du `driver`, formate des sorties **courtes par défaut** (résumés), écrit le volumineux sur disque.
- **Interface :** protocole MCP (stdio ou socket local).
- **Dépend de :** `driver`, `perception`, `action`, `network`, `artifact-store`.

### 5.4 Perception (`perception`)
- **Rôle :** les yeux. Produit ce que Claude lit :
  - **Snapshot structuré** : arbre d'accessibilité **élagué** (rôles, noms accessibles, états — coché, désactivé, déplié), chaque élément portant une **référence stable** (`ref`) réutilisable pour agir.
  - **`find`** : « trouve l'élément qui dit/fait X » → une ou des `ref`, sans que Claude scanne tout l'arbre.
  - **Lecture ciblée et bornée** : par région ou par élément, dans un **budget de tokens** ; une grosse page n'explose jamais le contexte.
  - **Détection de changement** : le **delta** depuis le dernier regard (éléments apparus/disparus, texte changé, nouveaux appels réseau).
  - **Entête d'état** joint à chaque action : URL, titre, viewport, élément focalisé, dialogues ouverts, page prête ou non — pour que Claude ne se perde jamais.
  - **Screenshot** à la demande, plein écran ou par élément ; option d'y **superposer les `ref`** pour aligner le visuel et la structure.
- **Interface :** `snapshot(opts)`, `find(query)`, `read(scope, budget)`, `diff()`, `state()`, `screenshot(opts)`.
- **Dépend de :** `driver`.

### 5.5 Action (`action`)
- **Rôle :** les mains. Agit **par référence** (`ref`), pas par coordonnées : `click`, `type`, `select`, `scroll`, `hover`, `press`. Remplit des formulaires ; gère **downloads** (capturés sur disque) et **uploads** (fichiers de w-agent).
- **Références stables et re-mappables :** après une mise à jour du DOM, une `ref` reste valide ou est re-résolue, pour éviter de re-snapshotter à chaque clic.
- **Interface :** `act(ref, verb, payload?)`, `fill(fields)`, `download(...)`, `upload(ref, path)`.
- **Dépend de :** `driver`, `perception` (pour résoudre les `ref`).

### 5.6 Réseau (`network`)
- **Rôle :** comprendre l'app et atteindre les données derrière la session. Capture les requêtes/réponses ; permet de **lire une réponse d'API précise** que la page a faite ; **récupère une URL avec la session** de la page (cookies) ; sauvegarde les corps volumineux sur disque.
- **Interface :** `requests(filter)`, `readResponse(match)`, `fetchWithSession(url)`.
- **Dépend de :** `driver`.

### 5.7 Magasin disque (`artifact-store`)
- **Rôle :** garder le contexte de Claude propre. Tout ce qui est gros — DOM complet, captures, réponses réseau, HAR — est **écrit sur le disque de w-agent** ; l'outil ne rend à Claude qu'un **chemin + un résumé compact**. Emplacement **hors du dépôt git** (voir §12).
- **Interface :** `save(kind, bytes) -> {path, summary}`, `read(path)`.

### 5.8 Vue live + passe-la-main (`live-view`)
- **Rôle :** un seul composant, deux modes.
  - **Lecture seule** : diffuse l'écran de Chrome en direct (**screencast CDP**, image par image) vers une **page web**. William ouvre le lien, voit tout en temps réel.
  - **Passe-la-main** : relaie les entrées (souris/clavier) de William vers Chrome pour qu'il fasse **lui-même** un login. Pendant ce mode, l'outil **ne capture pas la saisie** (pas de screenshot/log du champ mot de passe).
- **Interface :** sert une page derrière le tunnel ; `startSession()` renvoie un **lien signé qui expire** ; `setMode(read|input)`.
- **Dépend de :** `driver` (screencast + injection d'entrées), l'accès distant (§5.9).

### 5.9 Accès distant (`remote-access`)
- **Rôle :** joindre Regard et la vue live **de n'importe où**, iPhone compris, de façon sûre.
  - Claude atteint w-agent par **SSH (clés)** ou une **session Claude Code distante**.
  - Le **lien de vue live** sort par le **tunnel Cloudflare existant** de w-agent, **authentifié**, avec **jeton qui expire**. Jamais public : il montre le navigateur connecté de William.
- **Dépend de :** le tunnel Cloudflare déjà en place, les clés SSH.

## 6. Flux de données — trois scénarios

1. **Lire une page.** Claude appelle `snapshot`/`read`. Le `driver` interroge Chrome par CDP ; `perception` élague et borne ; Claude reçoit un arbre compact + `ref`. Le DOM brut, si demandé, part sur disque et Claude n'a qu'un chemin.
2. **Se connecter (passe-la-main).** Claude atteint un mur de login. Il appelle `live-view.startSession()` → lien signé. William l'ouvre sur son iPhone, passe en mode entrée, **tape lui-même** son mot de passe (ou approuve une passkey sur son téléphone). L'outil ne voit rien de la saisie. William rend la main ; la session est désormais dans le profil persistant ; Claude reprend.
3. **Capturer une ressource protégée.** Claude repère un appel `/api/...` via `network.requests`, puis `network.fetchWithSession(url)` avec les cookies de la page ; le corps est écrit sur disque par `artifact-store` ; Claude reçoit chemin + résumé. (C'est exactement le besoin des vignettes Timeliner.)

## 7. Surface d'outils MCP (v1)

Noms indicatifs, signatures à figer à l'implémentation :

**Voir** — `navigate(url|back|forward)`, `snapshot({scope?, budget?})`, `find({query})`, `read({ref|region, budget})`, `diff()`, `state()`, `screenshot({ref?, full?, annotateRefs?})`
**Agir** — `act({ref, verb, text?})`, `fill({fields})`, `scroll({ref?, dir, amount?})`, `upload({ref, path})`, `download({ref?})`
**Comprendre** — `network_requests({filter?})`, `read_response({match})`, `fetch_with_session({url})`, `console({pattern?})`
**Onglets** — `tabs_list()`, `tabs_open(url)`, `tabs_close(id)`, `tabs_select(id)`
**Live** — `live_start()` → lien signé, `live_mode({read|input})`, `live_stop()`

Principe transverse : **sortie courte par défaut** (résumé + `ref`), le volumineux sur disque avec chemin retourné ; **entête d'état** joint à chaque réponse.

## 8. Robustesse et gestion d'erreurs

- **Attentes déterministes** : `waitFor` sur sélecteur visible, réseau au repos, fin de navigation — pas de `sleep` aveugle.
- **Viewport fixe** : dimensions verrouillées, pas de tremblement inter-capture (le défaut qui a coûté des heures sur Timeliner).
- **Reprise transparente** : sur erreurs CDP passagères (« renderer busy », timeout), l'outil retente avec back-off avant de rendre une erreur à Claude.
- **Dialogues natifs** (`alert`/`confirm`/`prompt`, `beforeunload`, sélecteur de fichier) : interceptés et gérés proprement pour ne pas geler la session.
- **Reconnexion** : si Chrome redémarre, le `driver` se rebranche ; le profil persistant survit.
- **Timeouts** réglables par action, avec un défaut sain.

## 9. Session et authentification

- **Modèle : session, jamais mot de passe.** William se connecte **une fois** par site dans le profil persistant. La session (cookies) tient. Claude opère sur cette session.
- **Claude ne reçoit ni ne saisit jamais un mot de passe.** Aucun canal n'est construit pour ça.
- **Login quand il le faut :** mode passe-la-main (§5.8) — William tape lui-même. Pour Google, **passkey / invite sur l'iPhone** préférée : l'authentification devient une tape sur son téléphone, aucun mot de passe tapé dans le navigateur de w-agent.
- **Gestionnaire de mots de passe (option) :** si un jour utile, le gestionnaire remplit le champ **sur approbation de William**, valeur jamais vue par Claude. Pas prioritaire — le profil persistant couvre l'essentiel.

## 10. Modèle de sécurité

- **Zéro secret dans le dépôt.** Profil, cookies, session, artefacts vivent **hors de l'arbre git**, sur w-agent, comme le `.env` Marketis. Config par variables d'environnement et flags.
- **Port CDP local seulement.** Le débogueur de Chrome n'est jamais exposé au réseau ; seul le serveur Regard, sur la même machine, s'y connecte.
- **Lien de vue live : authentifié, jeton qui expire, derrière le tunnel.** Jamais public. Un lien qui fuit = quelqu'un qui voit la session en direct.
- **Accès distant par clés**, jamais par mot de passe qui voyage.
- **Cadence anti-robot.** Rythme humain des actions pour limiter le risque de signalement des comptes (surtout Google). Rappel assumé : automatiser une Gmail connectée depuis un serveur peut déclencher les sécurités de Google ; on avance prudemment, c'est le compte de William.
- **Comportement de Claude (côté agent, pas dans l'outil) :** l'outil ne pose pas de garde-fou d'action ; mais Claude, de lui-même, demande à William avant un geste **irréversible en son nom** (envoyer, supprimer, acheter, publier). Lecture, navigation, remplissage, clics restent libres.

## 11. Isolation et testabilité

Chaque unité (`driver`, `perception`, `action`, `network`, `artifact-store`, `live-view`) a une frontière nette et se teste seule. On doit pouvoir dire de chacune : ce qu'elle fait, comment on l'utilise, de quoi elle dépend.

## 12. Prêt pour l'open source

- **Notre code seulement** : une mince couche sur CDP. On **ne redistribue pas Chromium** (on utilise le Chrome installé) → pas de gros binaire, pas d'embrouille de licence.
- **Dépendances** open-source compatibles (bibliothèque CDP, SDK MCP).
- **Séparation code / données** stricte : profil et session **hors dépôt**, `.gitignore` qui les exclut, `*.env.example` fourni.
- **Config** par variables/flags ; aucun endpoint ni jeton en dur.
- **Le mode passe-la-main devient un argument** : il montre le bon patron — l'humain gère le secret, l'agent gère le reste.
- Licence à choisir (MIT probable). Outillage de sanitization déjà disponible dans l'environnement de William.

## 13. Stratégie de test

- **Unitaire** : chaque primitive du `driver` et de `perception`/`action` contre une **page de test locale** (HTML fixe servi en local) — snapshot, find, act, diff, budget de lecture.
- **Intégration** : contre un vrai Chrome piloté par CDP — navigation, attentes, dialogues, reconnexion, screencast.
- **Fumée** : `snapshot` + `screenshot` de `example.com`, vérifie chemin + résumé.
- **Acceptation réelle** : la copie Timeliner. Un écran d'abord (login par passe-la-main, un snapshot, une capture, une ressource protégée par `fetch_with_session`), puis le lot.

## 14. Choix techniques

- **Langage :** Node.js + TypeScript.
- **Pilotage CDP :** **Playwright en `connectOverCDP`** sur le vrai Chrome (recommandé) — n'embarque pas Chromium quand on s'attache à un Chrome existant, et donne gratuitement des attentes robustes, un snapshot d'accessibilité (`page.accessibility.snapshot()`) et le screencast via session CDP. Alternative plus mince : `puppeteer-core` ou `chrome-remote-interface` (moins de code tiers, plus à écrire nous-mêmes).
- **MCP :** SDK officiel `@modelcontextprotocol/sdk` (TypeScript).
- **Vue live :** `Page.startScreencast` (CDP) → websocket → page statique minimale.
- **Supervision :** unit systemd utilisateur sur w-agent, `linger` actif (comme les services existants).

## 15. Premier jalon (v1) et acceptation

v1 = `chrome-host` + `driver` + `mcp-server` + `perception` + `action` + `network` + `artifact-store` + `live-view` (lecture seule et passe-la-main) + accès distant.
**Critère d'acceptation :** de l'iPhone, William ouvre le lien, se connecte à Timeliner par passe-la-main, et Claude capture proprement un premier écran (snapshot + capture + une vignette via `fetch_with_session`), le tout écrit sur disque de w-agent, contexte de Claude épargné. Ensuite, le lot des ~50 écrans.

## 16. Questions ouvertes

1. **Nom.** « Regard » est provisoire. Autre idée ?
2. **Emplacement du dépôt.** Créé pour l'instant en `~/Projets/regard` sur le Mac ; il devra vivre et tourner sur w-agent. On le déplace/clone où exactement là-bas ?
3. **Accès distant préféré :** SSH depuis une appli iPhone, session Claude Code distante, ou les deux ?
4. **Bibliothèque CDP :** Playwright `connectOverCDP` (recommandé) ou `puppeteer-core` minimal ?
