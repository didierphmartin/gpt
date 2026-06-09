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

## Compiler en Python

Tout workflow peut être **compilé en application Python autonome**. Le script généré utilise LangGraph et peut tourner indépendamment de l'application web — pratique quand vous voulez livrer un workflow comme CLI ou comme script planifié.

## Types de nœuds

- **Agent** — exécute un appel LLM avec des instructions spécifiques.
- **Appel d'outil** — invoque un outil intégré ou un outil de serveur MCP.
- **Document** — joint des PDF, documents Office, etc., comme contexte.
- **Schéma** — applique un schéma JSON pour contraindre la forme de la sortie.
- **Sortie** — écrit les résultats en ligne, dans un fichier, ou les deux.
