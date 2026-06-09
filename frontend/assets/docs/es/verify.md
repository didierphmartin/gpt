# Verificar respuesta

Envía un prompt a un proveedor y haz que **otro proveedor verifique la respuesta**.

![Captura de pantalla de Verificar respuesta](assets/docs/images/verify.png)

## Cuándo usarlo

- Detectar alucinaciones en afirmaciones factuales.
- Identificar errores numéricos en respuestas financieras o científicas.
- Detectar enfoques sesgados o unilaterales.

## Ejemplo

Envía una pregunta financiera a OpenAI y haz que DeepSeek verifique si las cifras son correctas.

## Cómo funciona

La respuesta del verificador se transmite en streaming junto a la respuesta original para una comparación directa. El verificador recibe el prompt original **y** la respuesta a verificar, y se le pide que señale cualquier problema.
