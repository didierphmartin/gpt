# Vérifier la réponse

Envoyez un prompt à un fournisseur, puis faites **vérifier la réponse par un autre fournisseur**.

![Capture d'écran de Vérifier la réponse](assets/docs/images/verify.png)

## Quand l'utiliser

- Repérer les hallucinations sur des affirmations factuelles.
- Détecter les erreurs numériques dans des réponses financières ou scientifiques.
- Identifier les cadrages biaisés ou unilatéraux.

## Exemple

Envoyez une question financière à OpenAI, puis demandez à DeepSeek de vérifier l'exactitude des chiffres.

## Comment ça marche

La réponse du vérificateur s'affiche en streaming à côté de la réponse originale pour une comparaison directe. Le vérificateur reçoit le prompt original **et** la réponse à vérifier, et il est invité à signaler tout problème.
