# Workflows

Construye pipelines automatizados de varios pasos que orquestan agentes de IA y herramientas.

![Captura de pantalla del editor de workflows](assets/docs/images/workflow.png)

## Editor visual

Los workflows se construyen en un **editor de arrastrar y soltar** (drawflow). Cada nodo es un agente, una llamada a herramienta, un adjunto o un formateador de salida. Conecta los nodos para definir el flujo.

## Ejecución

Dos modos de ejecución:

- **Bajo demanda** — haz clic en «Ejecutar» desde el editor o la barra lateral.
- **Programado** — programación tipo cron (por ejemplo, todos los días laborables a las 9:00).

Solo se ejecutan los nodos conectados a **Start**. Un nodo sin conexiones en el lienzo se ignora: puedes dejarlo a un lado y comparar una ejecución con y sin él.

## Salidas

Las salidas se pueden mostrar de dos maneras:

- **En línea** en el chat como una respuesta normal.
- **Escritas en una carpeta** de tu equipo (la misma carpeta que exploras desde Almacenamiento de archivos).

## Salidas estructuradas

Cada nodo puede asociarse con un **esquema JSON** para decodificación restringida — garantiza que la salida cumple una forma definida, útil para procesamiento posterior.

## Disparadores por evento

En lugar de una hora, una programación puede esperar un **evento**: pon *Repetir* en **Por evento (herramienta MCP)** y elige un servidor MCP y su herramienta disparadora — p. ej. *Outlook* → *wait_for_new*, que responde en cuanto llega un correo nuevo. *Argumentos de la herramienta* es la entrada JSON de la herramienta, p. ej. `{"args": {"folder": "Inbox"}}` para la carpeta que lee un nodo *Poll Outlook* (`{}` = Inbox).

- El script Python compilado lo ejecuta: `python <archivo> --watch` espera esa herramienta y ejecuta el workflow cada vez que responde *ready*, y de nuevo mientras quede trabajo.
- En la aplicación, una programación por evento aún no se ejecuta por sí sola.
- Para Outlook, las notificaciones llegan por Azure Event Hubs (ver el README del servidor Outlook). Sin ellas, la herramienta igual responde cada 15 minutos.

### Opciones de inicio

Un flujo comienza con su **Instrucción**, con un **Retraso** (una programación) o con una **opción de evento**.

- **Añadir una opción:** arrastre un componente de la Biblioteca de componentes de código sobre cualquier nodo Inicio. Elija la herramienta de espera (para Outlook, `wait_for_new`), sus argumentos y la salida que lleva el trabajo. El Inicio de cada flujo la mostrará.
- **Usarla:** abra Inicio y marque la opción. Aparece un nodo enlazado al componente después de Inicio, y el flujo espera el evento en lugar de una programación. Una opción de evento a la vez; activarla desactiva el Retraso.
- **Quitarla:** ⋮ → Quitar opción. Una advertencia enumera primero los flujos que la usan. Sus nodos se quedan donde están; dejan de comenzar con el evento.

## Compilar a Python

Cualquier workflow puede **compilarse en una aplicación Python independiente**. El script generado usa LangGraph y puede ejecutarse independientemente de la aplicación web — útil cuando quieres distribuir un workflow como CLI o como script programado.

## Tipos de nodo

- **Agente** — ejecuta una llamada LLM con instrucciones específicas.
- **Dispatcher** — un agente de tipo *Dispatcher*: envía cada solicitud a exactamente una de las ramas conectadas después de él (ver más abajo).
- **Llamada a herramienta** — invoca una herramienta integrada o de servidor MCP.
- **Documento** — adjunta PDFs, documentos Office, etc., como contexto.
- **Esquema** — aplica un esquema JSON para restringir la forma de la salida.
- **Salida** — escribe los resultados en línea, en un archivo o en ambos.

## Nodo dispatcher

Un dispatcher lee la solicitud y la envía a **uno** de los nodos conectados después de él — sus *ramas*. Las demás ramas no se ejecutan. Uso típico: un clasificador de correos con ramas como *claims*, *information* y *Miscellaneous*.

### Qué configurar en el formulario del dispatcher

Abre el dispatcher con su lápiz ✏️:

- **Tipo** — *Dispatcher*.
- **Enrutamiento** — quién elige la rama:
  - un **modelo de decisión** (p. ej. *Jev*): muy rápido y económico, y solo puede responder con una de tus ramas. Si no está seguro, lo dice en lugar de adivinar.
  - **LLM**: el propio modelo del dispatcher elige y puede añadir notas para la rama elegida.
  - **Por defecto**: el primer modelo de decisión que permite tu plan; si no, el LLM.
- **Rama por defecto** (solo modelo de decisión) — la rama que recibe todo mensaje que no encaja en ninguna categoría: el modelo no está seguro o su confianza es inferior al mínimo. Elige cualquier rama conectada, sea cual sea su nombre (*Miscellaneous*, *Otros*, *A revisar*…). Con **Ninguna**, esos mensajes detienen la ejecución como *Sin clasificar*.
- **Confianza mínima** (solo modelo de decisión, 0.6 por defecto) — por debajo, la respuesta no se considera fiable y el mensaje va a la rama por defecto. Bájala si solicitudes claras no llegan a su rama.
- **Descripción** — indica al modelo de decisión qué gestiona cada rama, p. ej. *"claims: reclamaciones y daños; information: preguntas sobre nuestros servicios; Miscellaneous: todo lo demás"*. Es lo que más mejora la precisión.

### Ramas

- Cada rama es un nodo conectado **después** del dispatcher, elegido por su **nombre**: usa nombres que digan lo que gestiona.
- Mantén **una sola** rama por defecto: dos ramas que significan "todo lo demás" se reparten los restos.
- No llames a una rama *unclear*: esa palabra está reservada a la respuesta "no lo sé" del modelo de decisión.
- Conecta cada rama a **Output**; si no, su respuesta nunca llega a la conversación.
- Una rama puede ser un agente o un nodo **Code**. Un agente recibe la solicitud con las notas del dispatcher; un nodo Code recibe exactamente lo que recibió el dispatcher (por ejemplo el correo de un sondeo), para que su código pueda usar los campos del correo como `id`.

### En el lienzo

- **1 de N** en el dispatcher — solo se ejecuta una rama.
- La insignia del dispatcher indica quién enruta (p. ej. **Jev**, o el proveedor LLM).
- **por defecto** marca la rama por defecto; **⚠ sin rama por defecto** avisa de que los mensajes sin clasificar se detienen en este dispatcher.
- Tras una ejecución, la rama elegida muestra su salida y sus registros; las demás aparecen en gris como **omitidas**.

### Resultados

- **Enrutado** — se ejecuta una rama.
- **Sin clasificar** — ninguna rama encaja y no hay rama por defecto: la ejecución termina ahí, con normalidad (no es un error).
- **Error** — no se pudo contactar con el modelo de decisión (sin clave, red). La ejecución se detiene e indica el motivo.

Recompila un workflow compilado (Python) tras cambiar estos ajustes.

## Biblioteca de componentes de código

Guarda un nodo de código en la **Biblioteca de código** (botón *Guardar en la biblioteca* del nodo, o *Nuevo componente de código* en la barra lateral) para reutilizarlo en cualquier flujo: arrástralo desde la biblioteca a un lienzo. Un componente colocado es un vínculo: su código, salidas, servidores MCP y tiempo límite pertenecen al componente, y editarlo (desde cualquier flujo o desde la biblioteca) cambia todos los flujos que lo usan. Para una variante, por ejemplo otra carpeta de correo, guárdala con un nombre nuevo. Un componente no se puede eliminar mientras un flujo lo use; *Usado por* en su menú los enumera.
