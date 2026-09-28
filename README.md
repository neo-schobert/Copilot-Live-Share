# Shared Copilot Chat

Extension VS Code qui permet à plusieurs personnes de partager **un même chat avec les modèles Copilot**, en passant par la machine de l'hôte.

- L'extension tourne **uniquement chez l'hôte**. Les invités n'ont besoin que d'un navigateur.
- Au démarrage d'une session, elle lance un petit serveur HTTP + WebSocket sur `127.0.0.1:3717`, qui sert une page de chat.
- Toutes les questions sont envoyées au modèle par l'hôte, via l'API Language Model de VS Code (`vscode.lm`). Les réponses sont diffusées en streaming à tous les participants.

```
 Navigateur invité ─┐
 Navigateur invité ─┼─ tunnel (ngrok / port forwarding) ─► 127.0.0.1:3717 ─► extension ─► vscode.lm ─► Copilot
 Webview de l'hôte ─┘
```

## Prérequis

- VS Code ≥ 1.90
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
| **Shared Copilot: Share Selection** | Envoie la sélection (ou le fichier entier si rien n'est sélectionné) dans le chat, comme « contexte partagé ». Aussi dans le menu contextuel de l'éditeur. |
| **Shared Copilot: Cancel Current Response** | Annule la réponse en cours. |
| **Shared Copilot: Stop Session** | Déconnecte tout le monde et arrête le serveur. |

La première question déclenche en général une demande de **consentement** de VS Code (« autoriser Shared Copilot Chat à utiliser les modèles de langage ? ») : l'hôte doit l'accepter. S'il refuse, les participants voient un message d'erreur explicite dans le chat.

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

## Côté invités

1. Ouvrir le lien, choisir un pseudo.
2. L'historique complet de la session s'affiche, puis les nouveaux messages en temps réel.
3. Les questions sont traitées une par une, dans l'ordre d'arrivée ; la page indique qui reçoit une réponse et la position de sa propre question dans la file.
4. En cas de coupure réseau, la page se reconnecte automatiquement avec le même pseudo.

## Paramètres

| Paramètre | Défaut | Description |
| --- | --- | --- |
| `sharedCopilotChat.port` | `3717` | Port local du serveur. |
| `sharedCopilotChat.modelFamily` | `""` | Famille de modèle Copilot (ex. `gpt-4o`, `claude-sonnet-4`). Vide : premier modèle Copilot disponible. Si la famille est introuvable, l'erreur affichée liste les familles disponibles. |
| `sharedCopilotChat.historyLength` | `20` | Nombre d'échanges précédents (question + réponse, ou contexte partagé) envoyés au modèle avec chaque question. |
| `sharedCopilotChat.hostName` | `""` | Pseudo de l'hôte dans le chat (vide : nom d'utilisateur système). |

## Limites connues

- **VS Code doit rester ouvert chez l'hôte** pendant toute la session : c'est lui qui sert la page et interroge le modèle. Fermer la fenêtre arrête la session.
- **Toutes les requêtes utilisent la licence et les quotas Copilot de l'hôte.** Chaque question d'un invité est décomptée sur son compte, et les conditions d'utilisation de Copilot s'appliquent à cet usage partagé.
- **Aucune persistance** : l'historique vit en mémoire et disparaît à l'arrêt de la session.
- Une seule question est traitée à la fois ; chaque participant peut avoir au plus 5 questions en attente.
- Le token est la seule protection : quiconque obtient le lien a accès au chat (et à tout contexte partagé par l'hôte). Ne partagez pas de code sensible avec des personnes non fiables.
- Seul l'hôte peut annuler une réponse.
- Le Markdown est volontairement simple (pas de tableaux ni de coloration syntaxique).

## Développement

```
src/
  protocol.ts        Types des messages WebSocket, partagés serveur/client
  server.ts          Serveur HTTP + WebSocket, authentification par token
  chatRoom.ts        Historique, participants, file FIFO, construction du prompt
  copilotBackend.ts  Appels à vscode.lm (sélection du modèle, erreurs, annulation)
  extension.ts       Commandes, webview, barre d'état
  web/               Client navigateur (TypeScript vanilla, bundlé par esbuild)
media/               index.html et style.css servis aux navigateurs
test/smoke.ts        Test de bout en bout avec un modèle simulé
```

- `npm run watch` : recompilation continue
- `npm run check-types` : vérification TypeScript stricte (extension et client)
- `npm test` : lance le vrai serveur avec un modèle simulé et vérifie l'authentification, la diffusion identique à plusieurs clients, l'ordre FIFO, l'annulation, la reconnexion et l'arrêt de session.
