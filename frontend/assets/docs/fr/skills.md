# Compétences

Une compétence (skill) apprend à l'assistant une tâche qu'il peut **réaliser** : produire un document Word, convertir un fichier, remplir un modèle, analyser un tableur…

## Ce qu'est une compétence

Une compétence est un **dossier** dans le dossier `skills/` de votre dossier synergyAI local. Il contient un fichier `SKILL.md` (son nom, une description de quand l'utiliser, et des instructions) et généralement des scripts Python. Les scripts s'exécutent **dans votre navigateur** (Pyodide), sur votre dossier local : rien n'est envoyé à un serveur pour les exécuter. Ce qu'une compétence produit arrive dans `outputs/`.

## Utiliser une compétence

- **Automatiquement** — demandez simplement : « transforme ce document en présentation ». L'assistant lit les descriptions des compétences et choisit la bonne.
- **Au choix** — glissez une compétence sur la zone de saisie : une puce l'affiche, et le message suivant l'utilise. Cliquez sur le × de la puce pour la retirer.
- **Dans un workflow** — un agent peut avoir une compétence, qui s'exécute alors comme une étape après la réponse de l'agent.

## Ajouter des compétences

- **Importer** un dossier de compétence, un fichier `.zip` ou `.skill`, ou une compétence depuis GitHub.
- **En écrire une** — créez un dossier avec un `SKILL.md` ; la description dans son en-tête est ce que l'assistant lit pour décider quand l'utiliser.

Quand le script d'une compétence échoue, l'assistant peut proposer une correction (auto-réparation), et la vue Compétences permet de les revoir et de les améliorer au fil du temps.
