# Tester sous Windows

Ce qui n'a pas pu être vérifié sous Linux : le vrai `wsl.exe`, la réouverture du projet dans WSL, l'installation de bubblewrap en root, l'installation automatique de l'extension dans WSL et l'arrêt des commandes lancées via `wsl.exe`.

Pour chaque étape, noter le résultat et copier le canal de sortie **Prompt Share** (Affichage → Sortie) en cas d'écart.

## 0. Préparation

- Windows 10/11 avec WSL 2 et une distribution (Ubuntu par défaut). Pour tester le parcours complet, **désinstaller bubblewrap** de la distribution (`wsl -u root apt-get remove -y bubblewrap`) et **désinstaller l'extension WSL** de VS Code.
- `git pull`, puis `npm ci` dans le dépôt (sous Windows, pas dans WSL).
- Construire le VSIX : `npm run package:marketplace`.

> La réouverture dans WSL ne fonctionne pas en mode développement (F5) : l'extension ne peut pas suivre la fenêtre. Il faut **installer le VSIX** : `code --install-extension prompt-share-0.1.0.vsix`.

## 1. Tests automatiques

1. `npm test` : 21 vérifications attendues.
2. `node esbuild.js && node esbuild.js --test && node test/vscode/run.js` : confinement puis chat natif, dans un VS Code isolé, avec le **vrai** `wsl.exe`.
   - Attendu : `RESULT: PASS` deux fois. La ligne `· bac à sable : …` doit mentionner WSL.
   - Si bubblewrap n'est pas installé dans WSL, le test « bac à sable » échoue : c'est normal. Relancer après l'étape 3.
3. `npm run test:view` : deux VS Code (hôte et invité) avec le VSIX Marketplace.

(`npm run test:vscode` fonctionne aussi : le mode « WSL simulé » y est ignoré sous Windows.)

## 2. Réouverture dans WSL (parcours complet)

Ouvrir un projet sous `C:\…` (pas `\\wsl.localhost\…`), puis cliquer sur **Héberger** dans la vue Prompt Share.

| # | Action | Attendu |
|---|--------|---------|
| 2.0 | Héberger (première fois) | Fenêtre modale « avant d’héberger une session » (compte GitHub, quota, protections actives). « Conditions de GitHub » ouvre la page puis revient ; « J’ai compris, héberger » continue ; fermer annule sans erreur |
| 2.1 | — | Notification « Recherche de WSL… », puis fenêtre modale « WSL est installé (Ubuntu). Rouvrir le projet dans WSL ? », mentionnant que bubblewrap n'est pas installé |
| 2.2 | Rouvrir dans WSL | Fenêtre « Installer bubblewrap dans Ubuntu ? » |
| 2.3 | Installer | Progression, puis « bubblewrap installé ». **Aucun mot de passe demandé** (`wsl -u root`) |
| 2.4 | — | Fenêtre « L'extension WSL de VS Code est nécessaire » → Installer l'extension WSL |
| 2.5 | — | La fenêtre se recharge sur `/mnt/c/…` (barre d'état en bas à gauche : « WSL: Ubuntu ») |
| 2.6 | — | **Point à surveiller** : Prompt Share doit s'installer seul dans WSL (réglage `remote.defaultExtensionsIfInstalledLocally`). Avec un VSIX local absent du Marketplace, VS Code peut ne pas y parvenir. Sinon : vue Extensions → Prompt Share → « Install in WSL: Ubuntu », puis recharger |
| 2.7 | — | La session **redémarre d'elle-même** (moins de 10 min après 2.2) et le chat s'ouvre |

À vérifier ensuite :
- `wsl -e which bwrap` renvoie `/usr/bin/bwrap`.
- Dans les réglages utilisateur, `remote.defaultExtensionsIfInstalledLocally` contient `neo-schobert.prompt-share`.
- Le canal de sortie contient « Réouverture du projet dans WSL : vscode-remote://wsl+Ubuntu/mnt/c/… ».

Variantes :
- **Rester sous Windows** : la session démarre sous Windows et les commandes isolées passent par `wsl.exe`. Le canal de sortie doit indiquer un bac à sable « WSL ».
- **Fermer la fenêtre modale sans répondre** : la session ne démarre pas, sans erreur.
- `promptShare.wslMode` réglé sur `reopen`, `windows` ou `off` : plus de question.
- Projet ouvert depuis `\\wsl.localhost\Ubuntu\home\…` : le chemin doit être converti en `/home/…`.

## 3. Bac à sable via wsl.exe (en restant sous Windows)

Avec une session hébergée sous Windows (sans réouverture), demander à l'agent de lancer des commandes (bouton « Autoriser » à chaque fois) :

| Commande demandée | Attendu |
|---|---|
| `ls ~ ; echo $HOME` | Dossier personnel vide, `HOME=/tmp/home` |
| `curl -sS https://example.com` ou `getent hosts example.com` | Échec : pas de réseau |
| `cat .env` (s'il existe dans le projet) | Fichier vide ou absent |
| `echo test > essai.txt` | Fichier créé dans le projet, visible sous Windows |
| `echo test > /mnt/c/Users/<vous>/hors.txt` | Échec : hors du projet |

## 4. Arrêt des commandes via wsl.exe

C'est le point le plus incertain : `taskkill /T` arrête `wsl.exe`, mais il faut vérifier que les processus Linux meurent aussi.

1. Demander à l'agent de lancer dans le bac à sable : `sleep 30 && echo tard > tard.txt`.
2. L'autoriser, puis cliquer sur **Arrêter** (annuler la réponse) au bout de quelques secondes.
3. Attendre 40 secondes. Attendu : **pas de `tard.txt`** dans le projet, et `wsl -e ps aux | findstr sleep` ne montre rien.
4. Recommencer avec une commande **hors du projet** (PowerShell) : `Start-Sleep 30; Set-Content tard2.txt tard`. Attendu : pas de `tard2.txt`.
5. Recommencer le point 1 en **arrêtant la session** au lieu d'annuler la réponse.

## 5. À me renvoyer

- Le tableau des étapes (✓ ou ✗).
- Le canal de sortie **Prompt Share** pour chaque ✗.
- La version de Windows (`winver`), de WSL (`wsl --version`) et de VS Code.
