# Barra de información

La fina franja azul sobre el chat. Contiene dos enlaces de acción y un contador de estado.

## Funciones disponibles

Recuento en vivo de cuántas herramientas puede invocar actualmente el proveedor de IA activo (herramientas integradas + herramientas de los servidores MCP conectados).

## Ver funciones

Abre un panel con todas las herramientas que la IA puede invocar en este momento, con el esquema de entrada de cada una. Útil para:

- Ver qué está realmente disponible para el modelo.
- Depurar por qué no se invocó una herramienta (puede que no esté habilitada para el proveedor activo).
- Descubrir las herramientas de los servidores MCP que has conectado.

## Ver contexto

Muestra exactamente lo que se envía a la IA en la siguiente solicitud:

- El prompt del sistema (tu prompt por defecto + cualquier habilidad activa).
- El historial de conversación (turnos recientes).
- Adjuntos en cola para el siguiente mensaje.

Útil para depurar cuando la respuesta de la IA no coincide con lo que esperabas — la causa casi siempre está en algo del contexto que te sorprendió.
