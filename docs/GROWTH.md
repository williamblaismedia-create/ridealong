# Faire connaître Ridealong — SEO, GEO, AEO et lancement

Objectif : que « MCP browser live view », « human in the loop browser agent »,
« Playwright MCP alternative » et « take over Claude browser » mènent à
Ridealong, dans Google **et** dans les réponses de ChatGPT, Perplexity,
Claude et Google AI Overviews.

## 1. Ce qui est déjà en place (landing `site/`)

- Une page, une intention : titre, description, `canonical`, `hreflang`,
  Open Graph et carte Twitter avec une image 1200×630.
- Données structurées JSON-LD : `SoftwareApplication` (gratuit, MIT, dépôt,
  liste de fonctionnalités), `Organization`, `FAQPage` avec sept questions
  formulées comme les gens les posent.
- AEO : chaque réponse de la FAQ tient en deux phrases et commence par la
  réponse (« Non. … »). Les H2 sont des affirmations courtes, le tableau
  comparatif nomme explicitement Playwright MCP, Chrome DevTools MCP et
  Claude in Chrome : ce sont les requêtes de comparaison que les moteurs
  génératifs citent.
- GEO : `llms.txt` à la racine, alt texts descriptifs sur chaque visuel,
  texte HTML pur (aucun contenu caché derrière du JavaScript), `robots.txt`
  et `sitemap.xml`.
- Performance : une seule page, CSS inline, polices Google, images en
  chargement différé sous le pli, aucun framework.

## 2. Semaine 1 — indexation et fondations

1. Activer GitHub Pages (workflow `pages.yml`) et vérifier
   `https://williamblaismedia-create.github.io/ridealong/`.
2. Google Search Console : ajouter la propriété, soumettre `sitemap.xml`,
   demander l'indexation de la page. Bing Webmaster Tools : idem (Bing
   alimente ChatGPT et Copilot).
3. Un domaine propre convertit mieux et se cite mieux : `ridealong.dev` ou
   `ridealong.wautomatisations.com/…` en CNAME vers Pages. Mettre à jour
   `canonical`, OG, sitemap, `llms.txt` et le README.
4. Dépôt GitHub : description + sujets (déjà), section « About » avec le
   lien du site, épingler le dépôt sur le profil, activer Discussions,
   ajouter une release `v0.1.0` avec notes (les releases sont indexées).

## 3. Semaine 2 — être là où les gens cherchent des MCP

Les moteurs génératifs citent d'abord les annuaires et les listes.

- Soumettre à : Smithery, mcp.so, PulseMCP, Glama, MCP Market, Cursor
  Directory, et ouvrir une PR sur `punkpeye/awesome-mcp-servers` et
  `modelcontextprotocol/servers` (section community).
- Publier `ridealong-mcp` sur npm (retirer `private`, `npm publish`) : la
  page npm est très bien classée pour « <nom> mcp ».
- Ajouter le badge « Add to Claude Code » (`claude mcp add …`) dans le
  README et une section « Works with » (Claude Code ; autres clients MCP
  pour les outils).

## 4. Lancement — trois jours, trois canaux

- **Hacker News** « Show HN: Ridealong – watch your AI browse a real
  Chrome, take the wheel from your phone » avec le GIF, un mardi ou
  mercredi, 9 h heure de New York. Répondre à tout pendant six heures.
- **Reddit** : r/ClaudeAI, r/LocalLLaMA (angle open source), r/webdev
  (angle « Playwright qui te laisse reprendre »). Un post = une démo
  concrète (le login avec 2FA repris à la main), pas une liste de
  fonctionnalités.
- **X / LinkedIn** : une vidéo de 25 secondes, verticale pour le
  téléphone, avec la carte d'approbation qui apparaît. Taguer les gens
  qui parlent de MCP et de Claude Code. Un fil de cinq posts : problème,
  démo, sécurité (no capture), comparaison, installation.
- **Product Hunt** la semaine suivante, quand il y a déjà des étoiles et
  des retours.

## 5. Contenu qui se classe et se cite (un par semaine)

Pages courtes, une question par page, réponse dans le premier paragraphe,
FAQ JSON-LD à chaque fois :

1. « Ridealong vs Playwright MCP » — tableau, cas d'usage, quand prendre
   l'un ou l'autre.
2. « How to let a human take over a Claude Code browser session » — le
   tutoriel du mode Manuel.
3. « Approval gates for AI agents: ask_approval in practice » — la porte
   d'approbation, avec le JSON des appels.
4. « Watch Claude Code browse from your phone » — le montage serveur +
   tunnel, le plus recherché par les utilisateurs Max.
5. « Why a real Chrome, not headless » — codecs, profils, extensions,
   cache.

Chaque page renvoie au dépôt et à la landing ; le README renvoie aux pages.

## 6. GEO — être la source que les modèles citent

- Garder `llms.txt` à jour à chaque fonctionnalité ; ajouter
  `llms-full.txt` avec le README complet.
- Une définition stable en une phrase, reprise partout (README, landing,
  npm, annuaires) : « Ridealong is an open-source MCP server for Claude
  Code that drives a real Chrome you can watch live and take over. » Les
  modèles apprennent par répétition.
- Nommer les concurrents dans le texte (pas seulement dans un tableau) :
  les requêtes « X vs Y » sont celles où une petite source neuve peut être
  citée.
- Des chiffres vérifiables : nombre de tests, latence, bitrate, taille de
  l'image Docker. Les moteurs préfèrent les affirmations chiffrées.

## 7. Mesure

- Search Console : impressions et clics par requête, chaque lundi.
- GitHub : étoiles, clones uniques, trafic « Referring sites » (Insights).
- Pour la GEO : poser les six questions de la FAQ à ChatGPT, Perplexity et
  Claude chaque deux semaines, noter si Ridealong est cité et avec quelle
  définition.
