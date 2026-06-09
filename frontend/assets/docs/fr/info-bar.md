# Barre d'information

Le fin bandeau bleu au-dessus du chat. Il regroupe deux liens d'action et un compteur d'état.

## Fonctions disponibles

Compte en direct du nombre d'outils que le fournisseur d'IA actif peut actuellement appeler (outils intégrés + outils des serveurs MCP connectés).

## Voir les fonctions

Ouvre un panneau listant chaque outil que l'IA peut appeler en ce moment, avec le schéma d'entrée de chacun. Utile pour :

- Voir ce qui est réellement disponible pour le modèle.
- Déboguer un appel d'outil qui n'a pas eu lieu (l'outil n'est peut-être pas activé pour le fournisseur actif).
- Découvrir les outils des serveurs MCP que vous avez connectés.

## Voir le contexte

Affiche exactement ce qui est envoyé à l'IA dans la prochaine requête :

- Le prompt système (votre prompt par défaut + toute compétence active).
- L'historique de la conversation (tours récents).
- Les pièces jointes en attente pour le prochain message.

Pratique pour déboguer quand la réponse de l'IA ne correspond pas à ce que vous attendiez — la cause se trouve presque toujours dans le contexte.
