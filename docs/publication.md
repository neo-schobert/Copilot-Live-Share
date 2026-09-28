# Publication sur le Visual Studio Marketplace

État au 29/09/2026. Les sources sont indiquées pour chaque point ; ce qui n'a pas pu être confirmé est signalé.

## Décisions prises (29/09/2026)

- **Nom** : **Prompt Share**, identifiant `neo-schobert.prompt-share`, réglages et commandes `promptShare.*`. « Copilot » n'apparaît plus que de façon descriptive (« avec les modèles GitHub Copilot de l'hôte »), avec la mention « non affilié à GitHub ni à Microsoft ». L'assistant s'affiche sous le nom « Assistant », avec une icône neutre. « Sharemind » a été écarté : c'est une marque déposée de Cybernetica AS, dans le logiciel.
- **Conditions de GitHub** : l'hôte doit accepter un avertissement avant sa première session. Il valide chaque question d'invité (par défaut). Les invités sont limités à 60 questions par heure et utilisent le modèle imposé par l'hôte (par défaut). Chacun voit sous la saisie quel compte répond.
- **Publication** : par téléversement manuel du VSIX (pas de jeton).

Le dépôt GitHub a été renommé de `Copilot-Live-Share` (deux marques) en `Prompt-Share` ; `package.json` pointe dessus.

Reste à faire, hors du code :
- éventuellement, demander une autorisation écrite à GitHub pour lever le doute restant.

L'identifiant d'une extension (`publisher.name`) **ne peut plus changer** après publication, et un nom supprimé reste réservé à vie ([doc de publication](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)). Les analyses qui ont conduit à ces décisions :

### 1. Le mot « Copilot » dans le nom

- Microsoft interdit d'utiliser ses marques **dans le nom** d'un produit (exemple interdit : « Contoso OneDrive software »). Il autorise les formules descriptives : « works with », « for use with », « compatible with » ([marques Microsoft](https://www.microsoft.com/en-us/legal/intellectualproperty/trademarks)).
- GitHub interdit de suggérer que le projet vient de GitHub ou qu'il est approuvé par GitHub, et d'utiliser ses logos comme icône ([marque GitHub](https://brand.github.com/foundations/logo)).
- Aucun filtre automatique connu ne bloque « copilot » à la publication. Le risque est un signalement puis un retrait. *Non confirmé.*

L'ancien nom, « Shared Copilot Chat », correspondait au schéma interdit. Recommandation, appliquée :
- un nom propre distinctif, et « Copilot » seulement dans la description, par exemple « … — chat IA partagé pour VS Code (fonctionne avec GitHub Copilot) » ;
- un `name` technique neutre ;
- la mention « Non affilié à GitHub ni à Microsoft » dans le README.

Le mot-clé `live share` peut aussi laisser croire à un lien avec Microsoft Live Share.

### 2. Les conditions de GitHub Copilot (risque principal)

- Conditions d'utilisation de GitHub, B.3 : « Your login may only be used by one person — i.e., a single login may not be shared by multiple people. » B.4 : le titulaire est responsable de toute activité sur son compte ([ToS](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service)).
- Politique d'usage acceptable : « You will not reproduce, duplicate, copy, sell, resell or exploit any portion of the Service, use of the Service, or access to the Service without our express written permission » ([AUP](https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies)).
- Un abonnement individuel couvre un seul compte ; plusieurs utilisateurs nécessitent des sièges d'organisation ([licences Copilot](https://docs.github.com/en/billing/concepts/product-billing/github-copilot-licenses)).
- La doc de l'API Language Model de VS Code indique qu'en publiant sur le Marketplace, l'extension adhère à la politique d'usage de l'extensibilité Copilot. Le lien vers cette politique renvoie aujourd'hui une 404 ([API LM](https://code.visualstudio.com/api/extension-guides/ai/language-model)).

**Évaluation : risque élevé** si le produit se présente comme « le Copilot de l'hôte pour des invités sans abonnement ». Le risque concret porte d'abord sur l'**hôte** : avertissement, puis suspension de Copilot. Viennent ensuite un signalement et un retrait de l'extension. Aucune clause ne vise nommément le relais via `vscode.lm` : c'est une interprétation des clauses générales.

Pistes pour réduire ce risque (les quatre premières sont en place) :
- présenter le produit comme de la **collaboration** (pair programming, l'hôte reste dans la boucle), jamais comme un moyen de se passer d'un abonnement ;
- ajouter une option « l'hôte valide chaque question des invités » et une limite de débit ;
- prévenir l'hôte avant sa première session, et les invités dans le chat ;
- ajouter au README un avertissement sur les conditions de GitHub ;
- en cas de doute, demander une autorisation écrite à GitHub.

### 3. Le mode d'authentification

Le **1er décembre 2026**, les PAT Azure DevOps globaux sont retirés ; or le PAT « All accessible organizations » exigé par `vsce` en est un ([doc de publication](https://code.visualstudio.com/api/working-with-extensions/publishing-extension), [annonce Azure DevOps](https://devblogs.microsoft.com/devops/retirement-of-global-personal-access-tokens-in-azure-devops/)). Un PAT créé maintenant ne servira donc que deux mois.

Les voies durables :
- **Téléversement manuel du VSIX** sur la page de gestion de l'éditeur : connexion avec le compte Microsoft, sans jeton. C'est le plus simple pour un développeur seul.
- `vsce publish --oidc` depuis GitHub Actions, ou `--azure-credential` avec Microsoft Entra ID. Ces deux modes sont pensés pour la CI, et leurs prérequis exacts pour un éditeur individuel ne sont pas documentés clairement ([vsce](https://github.com/microsoft/vscode-vsce)).

## Étapes

1. **Compte** : se connecter sur https://marketplace.visualstudio.com/manage avec un compte Microsoft.
2. **Éditeur** : « Create publisher », avec pour ID `neo-schobert` (il doit être identique au `publisher` de `package.json`) et un nom affiché au choix.
3. **Manifeste** : mettre `version` et `CHANGELOG.md` à jour, et les liens du dépôt s'il est renommé. Déjà en place : icône PNG 128 px, `LICENSE`, `repository`, `bugs`, `homepage`, `galleryBanner`.
4. **Paquet** : `npm run package:marketplace`. Le script retire `enabledApiProposals`, que le Marketplace refuse ([API proposées](https://code.visualstudio.com/api/advanced-topics/using-proposed-api)) ; c'est vérifié dans le VSIX actuel. Le VSIX ne contient ni binaire ni jeton : le Marketplace bloque les paquets qui contiennent des secrets.
5. **Vérifier** : `npm run test:view` (VSIX installé dans deux VS Code, hôte et invité).
6. **Publier** : « New extension » → « Visual Studio Code » sur la page de l'éditeur, puis téléverser le `.vsix`. Le scan antimalware prend en général quelques minutes ([sécurité du Marketplace](https://code.visualstudio.com/docs/configure/extensions/extension-runtime-security)).
7. **Versions suivantes** : augmenter `version`, reconstruire, puis téléverser via « Update » sur la page de l'extension.

## Revue du Marketplace

- Il n'existe **pas de revue manuelle** documentée, mais un scan antimalware, une analyse dynamique dans un bac à sable et une détection de secrets (bloquante).
- Aucune règle n'interdit un serveur WebSocket local, un tunnel ou l'exécution de commandes. Le README décrit déjà l'exposition réseau et les validations.
- Un faux positif reste possible. Le recours se fait sur https://github.com/microsoft/vsmarketplace.
- Le badge « éditeur vérifié » exige 6 mois de présence sur le Marketplace et un domaine enregistré depuis 6 mois : il n'est pas disponible au lancement.
