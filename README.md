# Shared Copilot Chat

Extension VS Code qui permet à plusieurs personnes de partager **un même chat avec les modèles Copilot**, en passant par la machine de l'hôte.

- L'extension tourne **uniquement chez l'hôte**. Les invités n'ont besoin que d'un navigateur.
- Au démarrage d'une session, elle lance un petit serveur HTTP + WebSocket sur `127.0.0.1:3717`, qui sert une page de chat.
- Toutes les questions sont envoyées au modèle par l'hôte, via l'API Language Model de VS Code (`vscode.lm`). Les réponses sont diffusées en streaming à tous les participants.
- Comme l'agent Copilot, le modèle travaille dans le projet de l'hôte : il lit, cherche, pose des questions, modifie des fichiers et lance des commandes. **Il est confiné au projet**, et chaque modification ou commande est validée (par l'hôte seul dès qu'elle sort du projet).
- Les discussions apparaissent aussi dans le **panneau Chat natif** de VS Code chez l'hôte.

```
 Navigateur invité ─┐
 Navigateur invité ─┼─ tunnel (ngrok / port forwarding) ─► 127.0.0.1:3717 ─► extension ─► vscode.lm ─► Copilot
 Webview de l'hôte ─┘
```

## Prérequis

- VS Code ≥ 1.136, sous Windows, Linux ou macOS
- Extension **GitHub Copilot Chat** installée et connectée chez l'hôte
- Node.js ≥ 18 (pour compiler)

## Installation et lancement

```bash
npm install
npm run compile
```

Ouvrez ce dossier dans VS Code et appuyez sur **F5** : une fenêtre « Extension Development Host » s'ouvre avec l'extension chargée.

Pour installer l'extension de façon permanente : `npx @vscode/vsce package`, puis *Extensions : Installer depuis un VSIX…*.

## Démarrer une session

Dans la palette de commandes (`Ctrl+Maj+P`) :

| Commande | Effet |
| --- | --- |
| **Shared Copilot: Start Session** | Démarre le serveur, génère un token aléatoire, affiche l'URL locale. |
| **Shared Copilot: Copy Invite Link** | Demande l'URL publique du tunnel et copie `<url>/?token=<token>` dans le presse-papier. Aussi accessible en cliquant sur l'indicateur de la barre d'état. |
| **Shared Copilot: Open Chat** | Ouvre le chat dans une webview pour que l'hôte participe (avec le droit d'annuler). |
| **Shared Copilot: Share Selection** | Envoie la sélection (ou le fichier entier si rien n'est sélectionné) comme « contexte partagé », dans la discussion ouverte dans la webview de l'hôte (sinon, une liste permet de la choisir). Aussi dans le menu contextuel de l'éditeur. |
| **Shared Copilot: Cancel Current Response** | Annule la réponse en cours. |
| **Shared Copilot: Select Default Model** | Choisit dans une liste le modèle Copilot utilisé par défaut (enregistré dans `sharedCopilotChat.modelFamily`). |
| **Shared Copilot: Stop Session** | Déconnecte tout le monde et arrête le serveur. |

La première question déclenche en général une demande de **consentement** de VS Code (« autoriser Shared Copilot Chat à utiliser les modèles de langage ? ») : l'hôte doit l'accepter. S'il refuse, les participants voient un message d'erreur explicite dans le chat.

## L'agent : un Copilot à plusieurs, confiné au projet

Comme l'agent Copilot, le modèle explore le projet de l'hôte, pose des questions, modifie des fichiers et lance des commandes. Ses actions s'affichent en direct dans la réponse ; les actions sensibles apparaissent sous forme de **carte de validation** avec un aperçu (diff ou commande).

| Outil | Rôle | Validation |
| --- | --- | --- |
| `list_directory`, `find_files`, `read_file`, `search_text`, `get_diagnostics` | Explorer le projet | aucune |
| `ask_user` | Poser une question aux participants (avec réponses proposées) | visible par tous, **n'importe quel participant** répond (la première réponse l'emporte) |
| `edit_file`, `create_file` | Modifier ou créer un fichier du projet | auteur de la demande **ou** hôte |
| `run_command` | Commande dans le bac à sable (projet seul, sans réseau) | auteur de la demande **ou** hôte |
| `run_command` avec `outsideProject` | Commande hors bac à sable (réseau, installation…) | **hôte uniquement** |

**Qui valide quoi**

- Une action qui reste dans le projet peut être validée par la personne qui a posé la question, ou par l'hôte.
- Une action qui sort du projet (commande hors bac à sable) ne peut être validée ou refusée **que par l'hôte**.
- « Autoriser pour la session » (réservé à l'hôte) valide d'office les actions suivantes de la même catégorie (modifications de fichiers, ou commandes dans le bac à sable) ; il ne s'applique jamais aux actions hors du projet.
- L'hôte peut décider depuis la page web, depuis le panneau Chat natif ou depuis la notification VS Code (avec « Voir les modifications » pour ouvrir le diff complet). La première décision l'emporte.
- Un refus est transmis au modèle, qui doit proposer une autre approche. Arrêter la réponse refuse les actions en attente.

**Environnement fermé**

- Tous les chemins sont vérifiés une fois les liens symboliques résolus : rien en dehors des dossiers ouverts n'est lisible, listable ou modifiable (y compris via un lien vers `/etc` ou un lien cassé pointant ailleurs).
- Les fichiers sensibles du projet sont invisibles pour l'agent : `.git`, `.env*`, clés (`*.pem`, `*.key`, `id_rsa*`…), `.npmrc`, `.netrc`, `.ssh`, `.aws`. Ajoutez vos motifs avec `sharedCopilotChat.protectedFiles`.
- Les commandes s'exécutent dans un bac à sable [bubblewrap](https://github.com/containers/bubblewrap) (Linux) : seul le projet est visible et modifiable, le dossier personnel est absent, le réseau coupé, les fichiers protégés masqués. Les outils du `PATH` (ex. Node installé dans le dossier personnel) y sont visibles en lecture seule ; `sharedCopilotChat.sandboxReadOnlyPaths` en ajoute d'autres.
- Sans bac à sable disponible (macOS, Windows sans WSL, Linux sans bubblewrap), toute commande est considérée comme hors du projet : seul l'hôte peut la valider.
- Les commandes hors bac à sable s'exécutent sur la machine de l'hôte (PowerShell sous Windows, `/bin/sh` ailleurs) ; le modèle est informé du système et du shell pour en respecter la syntaxe. Arrêter une réponse arrête la commande et tous ses sous-processus.
- Au démarrage, le canal de sortie « Shared Copilot » indique le bac à sable détecté, ou ce qu'il manque pour l'activer.

### Windows et WSL

Sous Windows, l'extension s'appuie sur WSL 2 pour fonctionner comme sous Linux. Au lancement de **Start Session** :

1. Elle cherche WSL. S'il n'est pas installé, la session démarre normalement (chaque commande de l'agent devra être validée par l'hôte) et le canal de sortie « Shared Copilot » indique comment l'installer (`wsl --install`).
2. Si WSL est présent, elle propose de **rouvrir le projet dans WSL** (recommandé) ou de **rester sous Windows**.
3. Elle installe ce qui manque, en demandant votre accord à chaque fois :
   - **bubblewrap** dans la distribution (en root via `wsl -u root`, avec apt, dnf, zypper, pacman ou apk) ;
   - l'extension **WSL** de VS Code (Microsoft), si vous rouvrez dans WSL ;
   - Shared Copilot elle-même dans WSL : elle est ajoutée au réglage `remote.defaultExtensionsIfInstalledLocally`, et VS Code l'y installe à la connexion.
4. Si vous rouvrez dans WSL, la fenêtre se recharge sur le projet (`/mnt/c/…`) et **la session redémarre d'elle-même**, chat ouvert.

Dans WSL, tout se passe exactement comme sous Linux. Si vous restez sous Windows, les commandes du bac à sable passent par `wsl.exe` (projet vu sous `/mnt/c/…`, mêmes protections), et les commandes hors du projet s'exécutent avec PowerShell, validées par l'hôte seul.

- `sharedCopilotChat.wslMode` : `ask` (défaut), `reopen` (toujours rouvrir dans WSL), `windows` (toujours rester sous Windows), `off` (ne rien proposer).
- `sharedCopilotChat.wslDistro` choisit la distribution (vide : celle par défaut) ; `sharedCopilotChat.wslSandbox: false` désactive le bac à sable via WSL quand on reste sous Windows.
- WSL 1 ne permet pas bubblewrap : l'extension l'indique et donne la commande de conversion (`wsl --set-version <distribution> 2`).
- En mode développement (F5), l'extension ne peut pas suivre le projet dans WSL : ouvrez le dossier avec *WSL: Connect to WSL* puis relancez F5 depuis cette fenêtre.
- Les modules natifs compilés côté Windows (`node_modules`) peuvent ne pas fonctionner depuis WSL, et inversement : l'agent relance alors la commande hors du projet, avec votre validation.
- Sous Linux (ou dans WSL), si bubblewrap manque, l'extension propose de l'installer dans un terminal (`sudo apt-get install bubblewrap`…) ; redémarrez ensuite la session.

## Panneau Chat natif

Pendant une session, les discussions apparaissent dans la liste des sessions du panneau Chat de VS Code, sous « Shared Copilot ». L'hôte peut y ouvrir une discussion, relire son historique (questions des invités préfixées par leur pseudo, actions de l'agent) et poser des questions : le modèle choisi dans le sélecteur du chat natif est utilisé, et la réponse est diffusée à tous les participants. Une nouvelle session créée depuis le panneau crée une nouvelle discussion partagée.

Cette intégration utilise une API de VS Code encore expérimentale (`chatSessionsProvider`) :

- **Avec F5** (mode développement), elle fonctionne directement.
- **Avec l'extension installée** (VSIX), il faut lancer VS Code avec `code --enable-proposed-api local.shared-copilot-chat`, ou ajouter `"enable-proposed-api": ["local.shared-copilot-chat"]` dans `argv.json` (commande *Préférences : Configurer les arguments d'exécution*). Sinon, l'extension fonctionne normalement sans cette intégration.
- Une mise à jour de VS Code peut modifier cette API et désactiver l'intégration ; le reste de l'extension n'est pas concerné. `sharedCopilotChat.nativeChat` permet de la désactiver.
- Une discussion ouverte dans le panneau natif n'affiche pas en direct les nouveaux messages des invités : fermez-la et rouvrez-la pour la mettre à jour. Les réponses aux questions posées depuis le panneau natif s'y affichent, elles, en streaming.

## Exposer le chat aux invités

Le serveur n'écoute que sur `127.0.0.1` : il n'est pas accessible depuis le réseau tant que l'hôte n'ouvre pas lui-même un tunnel. L'extension ne gère pas le tunnel.

**Avec ngrok**

```bash
ngrok http 3717
```

Copiez l'URL `https://….ngrok-free.app` affichée par ngrok, puis lancez **Copy Invite Link** et collez-la.

> Sur le plan gratuit, ngrok affiche une page d'avertissement à la première visite ; les invités cliquent sur « Visit Site ».

**Avec le port forwarding de VS Code**

1. Panneau **Ports** (*Affichage → Ouvrir la vue… → Ports*) → **Transférer un port** → `3717`.
2. Clic droit sur le port → **Visibilité du port → Public** (sinon les invités doivent se connecter à GitHub avec un compte autorisé).
3. Copiez l'adresse transférée, puis **Copy Invite Link** et collez-la.

**Partager le lien** : envoyez le lien copié (il contient le token). Toute personne qui possède ce lien peut rejoindre le chat et poser des questions. Pour révoquer l'accès, arrêtez la session et redémarrez-en une : un nouveau token est généré.

## Côté participants

1. Ouvrir le lien, choisir un pseudo.
2. Toutes les discussions de la session s'affichent, puis les nouveaux messages en temps réel.
3. **Discussions** : la colonne de gauche liste les discussions. « + Nouvelle discussion » en ouvre une nouvelle, qui prend le titre de sa première question ; le crayon ✎ la renomme. Chaque discussion a son propre historique : le modèle ne voit que celui de la discussion où la question est posée. Un badge signale les nouveaux messages dans les autres discussions, et la liste des participants indique qui est dans quelle discussion. Seul l'hôte peut supprimer une discussion (🗑, deux clics).
4. **Modèle** : comme dans Copilot Chat, le menu sous la zone de saisie choisit le modèle pour vos questions. Ce choix est mémorisé par le navigateur ; « (par défaut) » suit le modèle par défaut choisi par l'hôte.
5. Les questions sont traitées une par une, dans l'ordre d'arrivée, toutes discussions confondues ; la page indique qui reçoit une réponse et la position de sa propre question dans la file.
6. En cas de coupure réseau, la page se reconnecte automatiquement avec le même pseudo et revient sur la même discussion.
7. **Présence en temps réel** : la liste des discussions montre les avatars des participants présents dans chacune, et « Camille écrit… » quand quelqu'un tape ; au-dessus de la zone de saisie, on voit qui est dans la discussion et qui est en train d'écrire.

## Paramètres

| Paramètre | Défaut | Description |
| --- | --- | --- |
| `sharedCopilotChat.port` | `3717` | Port local du serveur. |
| `sharedCopilotChat.modelFamily` | `""` | Famille du modèle Copilot par défaut (ex. `gpt-4o`, `claude-sonnet-4`). Vide : premier modèle Copilot disponible. Se règle aussi avec **Select Default Model**. |
| `sharedCopilotChat.agentMode` | `full` | Accès du modèle au projet : `full` (lecture, modifications et commandes validées), `readOnly`, `off`. |
| `sharedCopilotChat.protectedFiles` | `[]` | Motifs glob de fichiers supplémentaires invisibles pour l'agent. |
| `sharedCopilotChat.sandboxReadOnlyPaths` | `[]` | Dossiers supplémentaires visibles en lecture seule dans le bac à sable des commandes. |
| `sharedCopilotChat.wslMode` | `ask` | Sous Windows avec WSL : `ask`, `reopen` (rouvrir dans WSL), `windows`, `off`. |
| `sharedCopilotChat.wslSandbox` | `true` | Sous Windows, isole les commandes dans WSL avec bubblewrap si disponibles. |
| `sharedCopilotChat.wslDistro` | `""` | Distribution WSL du bac à sable (vide : distribution par défaut). |
| `sharedCopilotChat.nativeChat` | `true` | Affiche les discussions dans le panneau Chat natif (API expérimentale, voir plus haut). |
| `sharedCopilotChat.allowGuestModelChoice` | `true` | Autorise les invités à choisir un autre modèle que celui par défaut. À désactiver pour éviter que des invités consomment les requêtes premium de l'hôte. L'hôte peut toujours choisir. |
| `sharedCopilotChat.historyLength` | `20` | Nombre d'échanges précédents (question + réponse, ou contexte partagé) envoyés au modèle avec chaque question. |
| `sharedCopilotChat.hostName` | `""` | Pseudo de l'hôte dans le chat (vide : nom d'utilisateur système). |

## Limites connues

- **VS Code doit rester ouvert chez l'hôte** pendant toute la session : c'est lui qui sert la page et interroge le modèle. Fermer la fenêtre arrête la session.
- **Toutes les requêtes utilisent la licence et les quotas Copilot de l'hôte.** Chaque question d'un invité est décomptée sur son compte, et les conditions d'utilisation de Copilot s'appliquent à cet usage partagé.
- **Aucune persistance** : l'historique vit en mémoire et disparaît à l'arrêt de la session.
- Une seule question est traitée à la fois pour toute la session, même avec plusieurs discussions ; chaque participant peut avoir au plus 5 questions en attente.
- Les modèles premium choisis par les invités sont décomptés sur le quota de l'hôte (voir `allowGuestModelChoice`).
- Le token est la seule protection : quiconque obtient le lien peut poser des questions, et donc faire **lire tout le projet** par le modèle (hors fichiers protégés), et valider les modifications que l'agent propose en réponse à **ses propres** questions. N'invitez que des personnes de confiance, ou passez `agentMode` à `readOnly` ou `off`.
- Une action en attente de validation ou une question de l'agent bloque la file d'attente jusqu'à la réponse.
- Le bac à sable des commandes nécessite bubblewrap sous Linux, ou WSL 2 + bubblewrap sous Windows ; sans lui (macOS notamment), chaque commande doit être validée par l'hôte.
- Seul l'hôte peut annuler une réponse.
- Le Markdown est volontairement simple (pas de tableaux ni de coloration syntaxique).

## Développement

```
src/
  protocol.ts        Types des messages WebSocket, partagés serveur/client
  server.ts          Serveur HTTP + WebSocket, authentification par token
  chatRoom.ts        Historique, participants, file FIFO, construction du prompt
  copilotBackend.ts  Appels à vscode.lm : sélection du modèle, boucle agent (outils), erreurs, annulation
  agentTools.ts      Outils de l'agent, confinement au projet, exécution des commandes
  sandbox.ts         Bac à sable bubblewrap : Linux natif ou via WSL sous Windows
  wslSetup.ts        Windows : détection de WSL, réouverture dans WSL, installation de ce qui manque
  nativeChat.ts      Intégration au panneau Chat natif (API proposée chatSessionsProvider)
  types/             Définitions des API proposées de VS Code utilisées
  extension.ts       Commandes, webview, barre d'état
  web/               Client navigateur (TypeScript vanilla, bundlé par esbuild)
media/               index.html et style.css servis aux navigateurs
test/smoke.ts        Test de bout en bout avec un modèle simulé
test/vscode/         Test d'intégration du confinement dans un vrai VS Code
```

- `npm run watch` : recompilation continue
- `npm run check-types` : vérification TypeScript stricte (extension et client)
- `npm test` : lance le vrai serveur avec un modèle simulé et vérifie l'authentification, la diffusion identique à plusieurs clients, l'ordre FIFO, l'annulation, les discussions (historiques séparés, renommage, suppression), le choix du modèle, les actions d'outils, les règles de validation (auteur / hôte / hors projet), les questions de l'agent, la reconnexion et l'arrêt de session.
- `npm run test:vscode` : lance un VS Code isolé (profil temporaire) sur un projet piégé (`.env`, `.git`, liens vers `/etc` et hors du projet) et vérifie le confinement de l'agent et du bac à sable, en mode Linux puis en mode WSL simulé (faux `wsl.exe`). Nécessite la commande `code` et un affichage.
