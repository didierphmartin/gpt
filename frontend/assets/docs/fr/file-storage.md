# Stockage de fichiers

Parcourez le **dossier local dédié à cette application** sur votre ordinateur — le même dossier où sont écrites les sorties de workflow.

## Ce que vous pouvez faire

- Ouvrir les fichiers écrits par les workflows.
- Réinjecter des fichiers locaux dans une conversation comme pièces jointes.
- Inspecter les sorties d'exécutions passées sans quitter l'application.

## Mise en place

Cela nécessite que la PWA soit installée et que la permission du dossier soit accordée :

1. Installez l'application en tant que PWA (l'assistant d'installation vous y invite au premier lancement).
2. Choisissez un dossier racine quand on vous le demande.
3. Le navigateur vous demandera une fois de confirmer l'accès au dossier — choisissez **« Autoriser à chaque visite »** pour ne pas avoir à autoriser à chaque session.

Le handle du dossier est conservé via IndexedDB du navigateur, l'application le mémorise donc entre les lancements.

## Pourquoi un dossier local ?

Stocker les fichiers en local apporte :

- **Confidentialité** — les sorties ne quittent jamais votre machine sauf si vous les téléversez explicitement.
- **Persistance** — les sorties de workflow restent accessibles même quand l'application n'est pas ouverte.
- **Interopérabilité** — ouvrez les fichiers dans vos éditeurs/visionneuses habituels ; Assistant IA n'est qu'un consommateur du dossier parmi d'autres.
