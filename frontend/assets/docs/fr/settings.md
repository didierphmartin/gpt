# Paramètres

Le panneau de paramètres permet d'adapter l'application à vos comptes et préférences.

## Clés API

Apportez vos propres clés par fournisseur. L'application utilise des clés partagées par défaut quand aucune n'est fournie — mais une clé personnalisée vous offre :

- **Limites de débit plus élevées** (votre compte, pas un pool partagé).
- **Visibilité directe de la facturation** dans le tableau de bord du fournisseur.
- **Confidentialité** — vos prompts passent par votre compte.

Les clés sont stockées chiffrées côté serveur. Des valeurs masquées vous sont retournées ; vous ne revoyez jamais la clé complète après l'avoir sauvegardée.

## Modèle par défaut par fournisseur

Choisissez le modèle spécifique que chaque fournisseur doit utiliser par défaut (par exemple `claude-sonnet-4-5` plutôt que `claude-opus-4-7`).

## Serveurs MCP

Connectez des serveurs d'outils externes via le **Model Context Protocol**. Une fois connecté, chaque outil exposé par le serveur est appelable par l'IA exactement comme un outil intégré. Cas d'usage courants :

- Intégrations sur mesure (API internes, CRM, ticketing).
- Outils spécialisés (génération d'images, requêtes BDD, conversion de formats).
- Pont vers d'autres écosystèmes.

## Fournisseurs de stockage

Liez Google Drive (ou d'autres fournisseurs supportés) pour sauvegarder les sorties à l'extérieur — pratique si vous voulez automatiquement avoir les résultats de workflow dans votre Drive.

## Téléphone & WebAuthn

- Liez un numéro de téléphone pour la récupération de compte.
- Enregistrez une passkey (WebAuthn) pour la connexion biométrique sur les appareils compatibles.
