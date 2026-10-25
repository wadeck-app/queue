# Lessons learned — queue

### A repo-built bundle must never run the real `cli update` / updater (incident 2026-10-24/25)

**Problem:** Tests spawned a repo-built `queue.cjs` with the real config dir and the real global npm; the background updater ran `npm install -g`, was killed mid-install, and the global CLI vanished.
**Fix:** Spawned CLIs in tests use `createIsolatedCliEnv()` (`src/testing/isolatedCliEnv.ts`: temp config/home/npm prefix+cache, unreachable registry, `UPDATER_*`/`LAUNCHER_*`/`NPM_CONFIG_*` stripped). A non-CalVer bundle refuses to update (`devBuildGuard.ts`): `cli update` exits 1 with a message, the updater entry logs and exits (1 if `UPDATER_FORCE=1`, else 0), the scheduler never spawns it.
**Context:** `UpdateManager` ignores `QUEUE_CONFIG_DIR` unless given the dir (now passed) and lives in `node_modules`, so `vi.mock('node:child_process')` does not reach its `spawn`: mock `UpdateManager` itself.

### Valider avec les vrais binaires installés, pas le bundle local

**Problem:** Tester avec `node dist-bundle/queue.cjs` ne valide pas le vrai comportement : le Go launcher, le chemin de résolution des fichiers déployés, et le contenu du package npm publié peuvent tous diverger.
**Fix:** Le workflow correct est commit → push → CI passe → `npm install -g @wadeck-app/queue-cli` → tester avec `queue <cmd>` directement.
**Context:** Ne jamais toucher `node_modules` manuellement pour simuler un déploiement. Le fichier `generate-platform-packages.sh` contrôle le champ `files` du package npm — un fichier manquant là ne sera pas distribué même s'il est dans `dist-bundle/` et copié par `copy-binaries.sh`.

---

### Infomaniak Node.js hosting : HOST=127.0.0.1 casse l'accès public silencieusement

**Problem:** Une config PM2 avec `HOST: '127.0.0.1'` rend l'app inaccessible depuis l'URL publique (page de maintenance générique d'Infomaniak) alors que l'app elle-même reste saine et que PM2 la montre "online".
**Fix:** Bind sur `0.0.0.0`, jamais `127.0.0.1`, sur l'hébergement Node.js Infomaniak (probablement vrai pour tout hébergement Node managé en conteneurs/pods) — l'edge/proxy joint l'app via une interface différente de loopback.
**Context:** Ce réglage peut rester dormant longtemps si le script `start` contourne le fichier ecosystem (ex: `pm2 start server.js` au lieu de `pm2 start ecosystem.config.cjs`) — le défaut du code de l'app gagne silencieusement à la place. Corriger un problème sans rapport en changeant quel fichier de config est chargé peut activer un mauvais réglage resté dormant. Auditer tous les réglages d'un fichier de config nouvellement activé, pas seulement celui qu'on voulait changer. Découvert sur `poc-node-infomaniak` (assistant.wadeck.ch).

---

### PM2 `pm2 start` vs `pm2-runtime` sur une plateforme qui supervise la commande de démarrage

**Problem:** Sur un hébergement managé où la plateforme elle-même supervise `npm start` comme process de premier plan (ex: "Commande d'exécution: npm start" chez Infomaniak), utiliser `pm2 start ecosystem.config.cjs` cause une boucle de redémarrage infinie : `pm2 start` se démonise et quitte avec le code 0 presque immédiatement, donc la plateforme voit le process de premier plan mourir et le relance, en boucle — même si le démon PM2 en arrière-plan gardait la vraie app vivante tout ce temps.
**Fix:** Utiliser `pm2-runtime start ecosystem.config.cjs` à la place — il reste en premier plan, ce qui correspond à ce que la supervision de la plateforme attend.
**Context:** `pm2-runtime` est un binaire séparé livré dans le même package npm `pm2`, conçu exactement pour ce scénario (Docker/plateforme qui supervise).

---

### `pm2-runtime` en "no daemon mode" est invisible depuis une autre session SSH

**Problem:** `pm2 list` / `pm2 jlist` lancé depuis une session SSH fraîche ou différente affiche un tableau vide ou crée un nouveau démon PM2 vide, même si l'app lancée via `pm2-runtime` est saine et sert du vrai trafic.
**Fix:** Ne pas utiliser `pm2 list`/`pm2 jlist` depuis la CI ou une session SSH quelconque comme health check pour une app gérée par `pm2-runtime`. Vérifier via le contenu réel de la réponse HTTP à la place.
**Context:** Le mode "no daemon" de `pm2-runtime` ne s'enregistre pas auprès du démon partagé `~/.pm2` auquel une session SSH séparée se connecte. Autre piège : une page de fallback/maintenance peut aussi renvoyer un HTTP 200 comme la vraie app — vérifier le contenu du corps de la réponse, pas juste le code de statut, pour valider un déploiement.

---

### Hébergement Node en conteneurs/pods : une session SSH peut atterrir sur une instance différente de celle qui sert l'app

**Problem:** `curl 127.0.0.1:PORT` réussit dans une session SSH et échoue (connexion refusée) dans une autre, sans aucun changement de code ou de process entre les deux.
**Fix:** Ne pas faire confiance à un `curl 127.0.0.1` local depuis une session SSH quelconque comme preuve de santé de l'app — vérifier via l'URL publique, le seul point de vue garanti de toucher l'instance réellement servante.
**Context:** Sur l'hébergement Node.js d'Infomaniak (probablement vrai pour d'autres hébergements Node managés en conteneurs/pods), chaque connexion SSH ou redémarrage d'app peut atterrir sur un conteneur/pod sous-jacent différent — observable via un suffixe de hostname qui change dans les logs de l'app (ex: `...-8f7f55dcc-25png` vs `...-xd4z7`).

---

### Isoler un bug quand deux superviseurs indépendants gèrent le même process

**Problem:** Quand à la fois le superviseur de plateforme (ex: Infomaniak qui lance `npm start`) et un pipeline CI (SSH + commandes `pm2`) peuvent redémarrer/gérer la même app, les échecs sont difficiles à attribuer — changer l'un ou l'autre produit des symptômes incohérents et déroutants.
**Fix:** Déployer un serveur HTTP minimal, sans dépendance, sans config, via une CI séparée, à côté de l'app principale (pas en remplacement), pour retirer complètement un acteur (ex: PM2) de l'équation. Puis faire varier une seule variable à la fois (ex: adresse de bind) avec ce serveur minimal pour obtenir un résultat non ambigu et reproductible avant de toucher à l'app principale.
**Context:** C'est ce qui a permis de trouver la cause racine `HOST=127.0.0.1` après avoir écarté séparément les fausses pistes liées au nommage des process PM2.

---

### An isolated app-core test instance still writes the shared module registry

**Problem:** Registering the queue module on a test app-core (port 4871) overwrote `~/.config/app-core/modules/queue.json`, so the real :4850 served my local bundle instead of the installed package.
**Fix:** Start the test instance with its own `APP_CORE_CONFIG_DIR` (temp dir) before any `POST /api/modules/register`, and check `~/.config/app-core/modules/<id>.json` afterwards. If polluted, re-register the installed manifest on :4850.
**Context:** Found while validating payload rows (2026-10-14); `GET /api/modules` on :4850 showed version `0.0.0-payload-ux2`.
