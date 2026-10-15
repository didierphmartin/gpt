# Workflows

Construisez des pipelines automatisés multi-étapes qui orchestrent des agents IA et des outils.

![Capture d'écran de l'éditeur de workflow](assets/docs/images/workflow.png)

## Éditeur visuel

Les workflows se construisent dans un **éditeur par glisser-déposer** (drawflow). Chaque nœud est un agent, un appel d'outil, une pièce jointe ou un formateur de sortie. Reliez les nœuds pour définir le flux.

## Exécution

Deux modes d'exécution :

- **À la demande** — cliquez sur « Exécuter » depuis l'éditeur ou la barre latérale.
- **Planifiée** — planifications cron-style (par exemple, chaque jour ouvré à 9 h).

Seuls les nœuds connectés à **Start** s'exécutent. Un nœud laissé sans connexion sur le canevas est ignoré : vous pouvez le garder de côté et comparer une exécution avec et sans lui.

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

### Options de démarrage

Le nœud Démarrer liste comment le workflow démarre : **Saisir le prompt**, **Planifier**, et chaque **option d'événement** que vous avez ajoutée. Une seule est cochée à la fois ; en cocher une autre bascule dessus.

- **Saisir le prompt / Planifier :** cliquez sur le texte pour basculer dessus et ouvrir la zone du prompt ou les champs de planification (exécuter à, répéter, cron). Planifier reste cochée une fois la planification enregistrée. La décocher revient à Saisir le prompt et supprime la planification.
- **Ajouter une option :** faites glisser un composant de la Bibliothèque de composants de code sur n'importe quel nœud Démarrer. Choisissez l'outil d'attente (pour Outlook, `wait_for_new`), ses arguments et la sortie qui transporte le travail. Le nœud Démarrer de chaque workflow la proposera ensuite.
- **L'utiliser :** cochez l'option sur Démarrer. Démarrer devient le composant : il affiche un connecteur par sortie (pour Outlook, `new_mail`, `no_mail`, `error`), et vous reliez chacun à ce qui doit suivre. Le workflow s'exécute à l'arrivée de l'événement ; ce qui sort d'un connecteur (le courriel sur `new_mail`) est l'entrée du nœud suivant. Les liens existants de Démarrer passent sur la sortie qui transporte le travail.
- **Revenir en arrière :** cochez Saisir le prompt ou Planifier. Démarrer revient à un seul connecteur : les liens de la sortie qui transporte le travail restent, les autres sont supprimés. Un avertissement les liste d'abord ; Annuler ne change rien.
- **La modifier ou la retirer :** le composant se modifie uniquement dans la Bibliothèque de composants de code, et chaque Démarrer qui l'utilise suit. Si un enregistrement retire des sorties reliées dans des workflows, un avertissement liste d'abord ces workflows et liens. ⋮ sur le composant → Modifier l'option de démarrage ou Retirer l'option de démarrage ; la retirer rend à ces Démarrer leur forme ordinaire.

#### Activer un workflow

Cocher un mode d'entrée ne fait que le sélectionner. Pour qu'un workflow s'exécute seul, cliquez sur ▶ sur Start :

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

Tout workflow peut être **compilé en application Python autonome**. Le script généré utilise LangGraph et peut tourner indépendamment de l'application web — pratique quand vous voulez livrer un workflow comme CLI ou comme script planifié.

## Types de nœuds

- **Agent** — exécute un appel LLM avec des instructions spécifiques.
- **Dispatcher** — un agent de type *Dispatcher* : envoie chaque demande à exactement une des branches connectées après lui (voir plus bas).
- **Appel d'outil** — invoque un outil intégré ou un outil de serveur MCP.
- **Document** — joint des PDF, documents Office, etc., comme contexte.
- **Schéma** — applique un schéma JSON pour contraindre la forme de la sortie.
- **Sortie** — écrit les résultats en ligne, dans un fichier, ou les deux.

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
