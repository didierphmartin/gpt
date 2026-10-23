# Workflows

Construisez des pipelines multi-étapes d'agents IA, de routage, de procédures et de code ; testez-les pas à pas dans l'éditeur ; puis exécutez-les ici ou compilez-les en Python autonome pour le framework d'agents de votre choix.

![Capture d'écran de l'éditeur de workflow](assets/docs/images/workflow.png)

## Éditeur visuel

Les workflows se construisent dans un **éditeur par glisser-déposer**. Glissez des nœuds depuis la palette — Start, Agent, Playbook, Code, Sortie, nœuds d'ingestion et audio temps réel — et reliez-les pour définir le flux. Voir *Types de nœuds* plus bas.

## Exécution

Trois façons de démarrer un workflow :

- **À la demande** — saisissez une question et lancez-le depuis l'éditeur ou la barre latérale.
- **Planifiée** — planifications cron-style (par exemple, chaque jour ouvré à 9 h).
- **Sur événement** — nouveau courriel, nouveau job ServiceNow, fichier déposé dans un dossier… (voir *Options de démarrage* plus bas).

Le même canevas peut s'exécuter à trois endroits :

- **Dans l'éditeur** — le navigateur exécute le workflow nœud par nœud. C'est là que vous le concevez et le déboguez.
- **Sur le serveur** — les exécutions planifiées, sur événement, et celles d'un workflow activé.
- **Compilé** — le Python généré s'exécute sur votre ordinateur via le runner local (voir *Compiler en Python*).

Seuls les nœuds connectés à **Start** s'exécutent. Un nœud laissé sans connexion sur le canevas est ignoré : vous pouvez le garder de côté et comparer une exécution avec et sans lui.

## Débogage d'une exécution

- Cliquez sur un nœud après une exécution pour voir ses onglets **Input**, **Output** et **Logs**.
- La branche choisie par un dispatcher affiche sa sortie ; les autres sont grisées comme **ignorées**.
- Les exécutions serveur, planifiées et compilées se suivent **en direct** : les événements apparaissent au fur et à mesure et restent ensuite dans le journal d'exécution.
- Exécutez d'abord le workflow dans l'éditeur, puis compilé : les deux rapportent les mêmes événements, ce qui permet de vérifier que le code compilé fait ce que vous avez conçu.

## Sorties

Les sorties peuvent s'afficher de deux manières :

- **En ligne** dans le chat comme une réponse classique.
- **Écrites dans un dossier** sur votre ordinateur (le même dossier que vous parcourez via Stockage de fichiers).

## Sorties structurées

Chaque nœud peut être associé à un **schéma JSON** pour un décodage contraint — garantit que la sortie respecte une forme définie, utile pour le traitement en aval.

## Déclencheurs sur événement

Au lieu d'une heure, une planification peut attendre un **événement** : réglez *Répéter* sur **Sur événement (outil MCP)** et choisissez un serveur MCP et son outil déclencheur — par ex. *Outlook* → *wait_for_new*, qui répond dès qu'un nouveau courriel arrive. *Arguments de l'outil* est l'entrée JSON de l'outil, par ex. `{"args": {"folder": "Inbox"}}` pour le dossier que lit un nœud *Poll Outlook* (`{}` = Inbox).

- Le script Python compilé l'exécute : `python <fichier> --watch` attend cet outil et lance le workflow chaque fois qu'il répond *ready*, puis encore tant qu'il reste du travail.
- Une fois un workflow activé avec ▶ sur Start, il s'exécute de lui-même (voir *Activer un workflow* plus bas).
- Pour Outlook, les notifications passent par Azure Event Hubs (voir le README du serveur Outlook). Sans elles, l'outil répond quand même toutes les 15 minutes.

### Options de démarrage

Le nœud Démarrer liste comment le workflow démarre : **Saisir le prompt**, **Planifier**, et chaque **option d'événement** que vous avez ajoutée. Ce sont des boutons radio : une seule est choisie à la fois ; en choisir une autre bascule dessus.

- **Saisir le prompt / Planifier :** cliquez sur le texte pour basculer dessus et ouvrir la zone du prompt ou les champs de planification (exécuter à, répéter, cron). Planifier reste choisie une fois la planification enregistrée. Choisir à la place Saisir le prompt (ou une option d'événement) supprime la planification.
- **Ajouter une option :** faites glisser un composant de la Bibliothèque de composants de code sur n'importe quel nœud Démarrer. Choisissez l'outil d'attente (pour Outlook, `wait_for_new`), ses arguments et la sortie qui transporte le travail. Le nœud Démarrer de chaque workflow la proposera ensuite.
- **L'utiliser :** choisissez l'option sur Démarrer. Démarrer devient le composant : il affiche un connecteur par sortie (pour Outlook, `new_mail`, `no_mail`, `error`), et vous reliez chacun à ce qui doit suivre. Le workflow s'exécute à l'arrivée de l'événement ; ce qui sort d'un connecteur (le courriel sur `new_mail`) est l'entrée du nœud suivant. Les liens existants de Démarrer passent sur la sortie qui transporte le travail.
- **Revenir en arrière :** choisissez Saisir le prompt ou Planifier. Démarrer revient à un seul connecteur : les liens de la sortie qui transporte le travail restent, les autres sont supprimés. Un avertissement les liste d'abord ; Annuler ne change rien.
- **La modifier ou la retirer :** le composant se modifie uniquement dans la Bibliothèque de composants de code, et chaque Démarrer qui l'utilise suit. Si un enregistrement retire des sorties reliées dans des workflows, un avertissement liste d'abord ces workflows et liens. ⋮ sur le composant → Modifier l'option de démarrage ou Retirer l'option de démarrage ; la retirer rend à ces Démarrer leur forme ordinaire.

#### Activer un workflow

Choisir un mode d'entrée ne fait que le sélectionner. Pour qu'un workflow s'exécute seul, cliquez sur ▶ sur Start :

- **Enter Prompt :** ▶ ouvre la conversation, comme avant.
- **Set Schedule** ou une **option de code** (par exemple « Outlook : Get New Email ») : ▶ active le workflow. Le
  service d'événements l'exécute aux heures prévues, ou attend l'événement et l'exécute à chaque fois. ■ le désactive.

Un seul workflow est actif à la fois : en activer un autre désactive le premier (une confirmation est demandée).
Changer le mode d'entrée du workflow actif le désactive. Un Start sans lien ne peut pas être activé. Start affiche
l'état : *À l'écoute des événements*, *En cours…*, *Actif — prochaine exécution …*, *Pas à l'écoute :* et la raison,
ou *Le service d'événements ne fonctionne pas* lorsque le service d'arrière-plan est arrêté.

Tout serveur MCP peut être une source d'événements pour une option de code s'il offre un outil d'attente qui répond
`{"status": "ready"}` ou `{"status": "timeout"}`, comme `wait_for_new` d'Outlook.

## Compiler en Python

Tout workflow peut être **compilé en Python autonome** pour l'un de quatre frameworks d'agents. Utilisez **Compiler le workflow** dans la barre d'outils et choisissez une cible :

- **LangGraph**
- **ADK** (Google Agent Development Kit)
- **MAF** (Microsoft Agent Framework)
- **NOOA** (NVIDIA OO Agents)

Le menu de chaque cible propose **Setup** (les étapes, à faire une fois, pour ajouter ce framework à votre runner local), **Generate**, **Info**, **Run**, **Stop**, **Display Code**, **Export** (un zip) et **Architecture** (une description du code généré).

Choisissez une disposition dans les options de génération :

- **Fichier unique** — tout le workflow dans un seul fichier `.py`.
- **Agents dans des fichiers séparés** — un paquet Python avec un module par agent.
- **A2A** — un serveur Agent-to-Agent par nœud, plus un orchestrateur.

Le code généré n'a pas besoin de cette application pour tourner : il contient son propre client MCP, le harnais des nœuds de code, l'interpréteur de playbooks et le routage. Les adresses des serveurs et les en-têtes de connexion vont dans son fichier `.env`. L'éditeur l'écrit dans `python/scripts/` de votre dossier local, et le runner local l'exécute sur votre ordinateur : un workflow peut ainsi lire vos fichiers et vous poser des questions en cours d'exécution.

Si une cible ne sait pas faire quelque chose qu'utilise le workflow (un swarm hors LangGraph, par exemple), la compilation indique quel nœud et pourquoi, plutôt que de produire du code qui ne marche qu'à moitié. **Recompilez après avoir modifié le workflow.**

## Types de nœuds

- **Start** — comment le workflow démarre : une question, un horaire ou un événement (voir *Options de démarrage*).
- **Agent** — un appel LLM avec ses propres instructions, fournisseur, outils, serveurs MCP et compétences.
- **Dispatcher** — un agent de type *Dispatcher* : envoie chaque demande à exactement une des branches connectées après lui (voir plus bas).
- **Playbook** — un agent de type *Playbook* : suit une procédure écrite pas à pas, avec des **portes** qui demandent à une personne de remplir un formulaire, d'approuver ou de prendre la main. Les questions apparaissent dans la conversation ; une exécution sans surveillance s'arrête proprement à une porte.
- **Code** — du Python `run(input, call_tool)` qui appelle directement des outils MCP, avec des **sorties** nommées : seuls les nœuds de la sortie prise s'exécutent ensuite (voir *Nœud de code*).
- **Sortie** — renvoie la réponse, en ligne, dans un fichier, ou les deux. Chaque nœud peut aussi avoir un **schéma JSON** pour une sortie structurée.
- **Ingestion** — Chargeur → Découpeur → Base vectorielle, pour indexer des documents.
- **Temps réel** — nœuds vocaux pour les conversations audio en temps réel.

## Nœud de code

Ouvrez un nœud de code avec son crayon ✏️ :

- **Code** — écrivez `def run(input, call_tool)`. `call_tool("<serveur>", "<outil>", {...})` appelle un outil d'un serveur MCP coché. L'**Assistant** sous le code peut l'écrire pour vous à partir de la documentation des outils des serveurs ; relisez la comparaison, puis **Accepter** ou **Ignorer**.
- **MCP Servers** — cochez les serveurs que le code peut appeler.
- **Tools** — ce que prennent et renvoient les outils de chaque serveur coché. Rien n'est appelé.
- **Settings** — le nom, les **sorties** (séparées par des virgules, un connecteur chacune ; vide = la sortie va au nœud suivant) et le délai. Le code peut lire `NODE_NAME`.
- **Input / Output / Logs** — la dernière exécution de ce nœud.

Le code s'exécute dans votre navigateur quand vous lancez le workflow dans l'éditeur, et dans le programme compilé sinon, avec les mêmes règles : les modules qui accèdent directement au réseau ou au système sont refusés, les outils passent par `call_tool`.

## Nœud dispatcher

Un dispatcher lit la demande et l'envoie à **une seule** des branches connectées après lui. Les autres branches ne s'exécutent pas. Usage typique : un classificateur de courriels avec des branches comme *claims*, *information* et *Miscellaneous*.

### Ce qu'il faut régler dans le formulaire du dispatcher

Ouvrez le dispatcher avec son crayon ✏️ :

- **Type** — *Dispatcher*.
- **Routage** — qui choisit la branche :
  - un **modèle de décision** (p. ex. *Jev*) : très rapide et peu coûteux, il ne peut répondre qu'avec l'une de vos branches. S'il n'est pas sûr, il le dit au lieu de deviner.
  - **LLM** : le modèle du dispatcher choisit et peut ajouter des notes pour la branche choisie.
  - **Par défaut** : le premier modèle de décision autorisé par votre forfait, sinon le LLM.
- **Branche fourre-tout** (modèle de décision seulement) — la branche qui reçoit tout message ne correspondant à aucune catégorie : le modèle n'est pas sûr, ou sa confiance est sous le minimum. Choisissez n'importe quelle branche connectée, quel que soit son nom (*Miscellaneous*, *Autres*, *À revoir*…). Avec **Aucune**, ces messages arrêtent l'exécution comme *Non classé*.
- **Confiance minimale** (modèle de décision seulement, 0,6 par défaut) — en dessous, la réponse n'est pas jugée fiable et le message va à la branche fourre-tout. Baissez-la si des demandes claires manquent leur branche.
- **Description** — indiquez au modèle de décision ce que traite chaque branche, p. ex. *« claims : sinistres et dommages ; information : questions sur nos services ; Miscellaneous : tout le reste »*. C'est ce qui améliore le plus la précision.

### Branches

- Chaque branche est un nœud connecté **après** le dispatcher, choisi par son **nom** : donnez des noms qui disent ce qu'elle traite.
- Gardez **une seule** branche fourre-tout : deux branches signifiant « tout le reste » se partagent les restes.
- N'appelez pas une branche *unclear* : ce mot est réservé à la réponse « je ne sais pas » du modèle de décision.
- Connectez chaque branche à **Output**, sinon sa réponse n'atteint jamais la conversation.
- Une branche peut être un agent ou un nœud **Code**. Un agent reçoit la demande avec les notes du dispatcher ; un nœud Code reçoit exactement ce que le dispatcher a reçu (par exemple l'e-mail d'un sondage), pour que son code puisse utiliser les champs de l'e-mail comme `id`.
- Le code d'un nœud Code peut lire `NODE_NAME`, son nom sur le canevas. Un seul composant de la Code Library peut alors servir toutes les branches : par exemple il range l'e-mail dans `"Inbox/" + NODE_NAME`, et la branche *claims* le range dans Inbox/Claims (les noms de dossier ignorent la casse).

### Sur le canevas

- **1 sur N** sur le dispatcher — une seule branche s'exécutera.
- Le badge du dispatcher indique qui route (p. ex. **Jev**, ou le fournisseur LLM).
- **fourre-tout** marque la branche fourre-tout ; **⚠ pas de fourre-tout** signale que les messages non classés s'arrêtent à ce dispatcher.
- Après une exécution, la branche choisie affiche sa sortie et ses journaux ; les autres sont grisées comme **ignorées**.

### Résultats

- **Routé** — une branche s'exécute.
- **Non classé** — aucune branche ne convient et il n'y a pas de fourre-tout : l'exécution s'arrête là, normalement (ce n'est pas une erreur).
- **Erreur** — le modèle de décision est injoignable (pas de clé, réseau). L'exécution s'arrête et indique pourquoi.

Recompilez un workflow compilé (Python) après avoir modifié ces réglages.

## Bibliothèque de composants de code

Enregistrez un nœud de code dans la **Bibliothèque de code** (bouton *Enregistrer dans la bibliothèque* du nœud, ou *Nouveau composant de code* dans la barre latérale) pour le réutiliser dans n'importe quel flux : faites-le glisser depuis la bibliothèque vers un canevas. Un composant placé est un lien : son code, ses sorties, ses serveurs MCP et son délai appartiennent au composant, et le modifier (depuis n'importe quel flux ou depuis la bibliothèque) change tous les flux qui l'utilisent. Pour une variante, par exemple un autre dossier de courrier, enregistrez-la sous un nouveau nom. Un composant ne peut pas être supprimé tant qu'un flux l'utilise ; *Utilisé par* dans son menu les énumère.
