# Workflows

Construisez des pipelines automatisés multi-étapes qui orchestrent des agents IA et des outils.

![Capture d'écran de l'éditeur de workflow](assets/docs/images/workflow.png)

## Éditeur visuel

Les workflows se construisent dans un **éditeur par glisser-déposer** (drawflow). Chaque nœud est un agent, un appel d'outil, une pièce jointe ou un formateur de sortie. Reliez les nœuds pour définir le flux.

## Exécution

Deux modes d'exécution :

- **À la demande** — cliquez sur « Exécuter » depuis l'éditeur ou la barre latérale.
- **Planifiée** — planifications cron-style (par exemple, chaque jour ouvré à 9 h).

## Sorties

Les sorties peuvent s'afficher de deux manières :

- **En ligne** dans le chat comme une réponse classique.
- **Écrites dans un dossier** sur votre ordinateur (le même dossier que vous parcourez via Stockage de fichiers).

## Sorties structurées

Chaque nœud peut être associé à un **schéma JSON** pour un décodage contraint — garantit que la sortie respecte une forme définie, utile pour le traitement en aval.

## Déclencheurs sur événement

Au lieu d'une heure, une planification peut attendre un **événement** : réglez *Répéter* sur **Sur événement (outil MCP)** et choisissez un serveur MCP et son outil déclencheur — par ex. *Outlook* → *wait_for_new*, qui répond dès qu'un nouveau courriel arrive. *Arguments de l'outil* est l'entrée JSON de l'outil, par ex. `{"args": {"folder": "Inbox"}}` pour le dossier que lit un nœud *Poll Outlook* (`{}` = Inbox).

- Le script Python compilé l'exécute : `python <fichier> --watch` attend cet outil et lance le workflow chaque fois qu'il répond *ready*, puis encore tant qu'il reste du travail.
- Dans l'application, une planification sur événement ne s'exécute pas encore d'elle-même.
- Pour Outlook, les notifications passent par Azure Event Hubs (voir le README du serveur Outlook). Sans elles, l'outil répond quand même toutes les 15 minutes.

## Compiler en Python

Tout workflow peut être **compilé en application Python autonome**. Le script généré utilise LangGraph et peut tourner indépendamment de l'application web — pratique quand vous voulez livrer un workflow comme CLI ou comme script planifié.

## Types de nœuds

- **Agent** — exécute un appel LLM avec des instructions spécifiques.
- **Appel d'outil** — invoque un outil intégré ou un outil de serveur MCP.
- **Document** — joint des PDF, documents Office, etc., comme contexte.
- **Schéma** — applique un schéma JSON pour contraindre la forme de la sortie.
- **Sortie** — écrit les résultats en ligne, dans un fichier, ou les deux.
