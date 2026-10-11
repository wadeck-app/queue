# Lessons learned — queue

### Valider avec les vrais binaires installés, pas le bundle local

**Problem:** Tester avec `node dist-bundle/queue.cjs` ne valide pas le vrai comportement : le Go launcher, le chemin de résolution des fichiers déployés, et le contenu du package npm publié peuvent tous diverger.
**Fix:** Le workflow correct est commit → push → CI passe → `npm install -g @wadeck-app/queue-cli` → tester avec `queue <cmd>` directement.
**Context:** Ne jamais toucher `node_modules` manuellement pour simuler un déploiement. Le fichier `generate-platform-packages.sh` contrôle le champ `files` du package npm — un fichier manquant là ne sera pas distribué même s'il est dans `dist-bundle/` et copié par `copy-binaries.sh`.
