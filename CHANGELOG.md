# Changelog

## 0.1.3

- Tunnel : choix de Cloudflare ou ngrok à l'ouverture (le dernier est présélectionné), état affiché dans « Inviter » (service, adresse, heure) avec « Copier le lien » et « Arrêter », globe dans la barre d'état, commande « Close Public Tunnel ».
- Si le service choisi échoue, l'extension propose l'autre, dans les deux sens.

## 0.1.2

- Bouton « Ouvrir un tunnel » : tunnel Cloudflare (sans compte) ou ngrok, outil téléchargé depuis sa source officielle avec accord, jeton ngrok demandé une fois, lien d'invitation copié. Repli proposé vers ngrok si Cloudflare est bloqué par le réseau.
- Partage d'applications locales de l'hôte (serveur de dev, API…) : les invités dans VS Code les ouvrent sur leur localhost, via un relais protégé par le jeton de la session.

## 0.1.1

- Discussions dans des onglets d'éditeur : à glisser, diviser ou détacher, comme le Chat de VS Code. Vue et onglets comptent pour un seul participant.
- Notifications quand une décision vous attend (question d'invité à accepter, action à valider, question de l'agent), avec boutons ; pastille sur la vue et compteur dans la barre d'état. Réglage `promptShare.notifications`.
- Invités dans VS Code : notifications pour les actions à valider et les questions de l'agent.
- Limite par défaut portée à 60 questions d'invités par heure.

## 0.1.0

- Vue « Prompt Share » dans la barre d'activité : héberger une session ou en rejoindre une depuis VS Code, sans navigateur.
- Chat IA partagé avec les modèles GitHub Copilot de l'hôte : discussions multiples, présence en temps réel.
- L'hôte garde la main : avertissement avant la première session, validation des questions des invités, limite horaire, modèle imposé aux invités par défaut.
- Agent confiné au projet de l'hôte : lecture et recherche, modifications et commandes validées, bac à sable bubblewrap (Linux, WSL).
- Windows : détection de WSL, réouverture du projet dans WSL et installation de ce qui manque.
- Invités sans VS Code : page web servie par l'hôte, via un tunnel.
