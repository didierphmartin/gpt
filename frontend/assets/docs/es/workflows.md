# Workflows

Construye pipelines de varios pasos con agentes de IA, enrutamiento, procedimientos y código; pruébalos paso a paso en el editor; luego ejecútalos aquí o compílalos a Python autónomo para el framework de agentes que elijas.

![Captura de pantalla del editor de workflows](assets/docs/images/workflow.png)

## Editor visual

Los workflows se construyen en un **editor de arrastrar y soltar**. Arrastra nodos desde la paleta — Start, Agente, Playbook, Código, Salida, nodos de ingesta y de audio en tiempo real — y conéctalos para definir el flujo. Consulta *Tipos de nodo* más abajo.

## Ejecución

Tres formas de iniciar un workflow:

- **Bajo demanda** — escribe un prompt y ejecútalo desde el editor o la barra lateral.
- **Programado** — programación tipo cron (por ejemplo, todos los días laborables a las 9:00).
- **Por evento** — un correo nuevo, un nuevo job de ServiceNow, un archivo dejado en una carpeta… (consulta *Opciones de inicio* más abajo).

El mismo lienzo puede ejecutarse en tres lugares:

- **En el editor** — el navegador ejecuta el workflow nodo por nodo. Aquí es donde lo diseñas y depuras.
- **En el servidor** — las ejecuciones programadas, por evento y las de un workflow activado.
- **Compilado** — el Python generado se ejecuta en tu ordenador a través del runner local (consulta *Compilar a Python*).

Solo se ejecutan los nodos conectados a **Start**. Un nodo sin conexiones en el lienzo se ignora: puedes dejarlo a un lado y comparar una ejecución con y sin él.

## Depurar una ejecución

- Haz clic en un nodo tras una ejecución para ver sus pestañas **Input**, **Output** y **Logs**.
- La rama elegida por un dispatcher muestra su salida; las demás aparecen en gris como **omitidas**.
- Las ejecuciones en el servidor, programadas y compiladas se siguen **en directo**: los eventos aparecen a medida que ocurren y quedan después en el registro de ejecución.
- Ejecuta primero el workflow en el editor y luego compilado: ambos informan de los mismos eventos, así compruebas que el código compilado hace lo que diseñaste.

## Salidas

Las salidas se pueden mostrar de dos maneras:

- **En línea** en el chat como una respuesta normal.
- **Escritas en una carpeta** de tu equipo (la misma carpeta que exploras desde Almacenamiento de archivos).

## Salidas estructuradas

Cada nodo puede asociarse con un **esquema JSON** para decodificación restringida — garantiza que la salida cumple una forma definida, útil para procesamiento posterior.

## Disparadores por evento

En lugar de una hora, una programación puede esperar un **evento**: pon *Repetir* en **Por evento (herramienta MCP)** y elige un servidor MCP y su herramienta disparadora — p. ej. *Outlook* → *wait_for_new*, que responde en cuanto llega un correo nuevo. *Argumentos de la herramienta* es la entrada JSON de la herramienta, p. ej. `{"args": {"folder": "Inbox"}}` para la carpeta que lee un nodo *Poll Outlook* (`{}` = Inbox).

- El script Python compilado lo ejecuta: `python <archivo> --watch` espera esa herramienta y ejecuta el workflow cada vez que responde *ready*, y de nuevo mientras quede trabajo.
- Una vez activado un workflow con ▶ en Start, se ejecuta por sí solo (véase *Activar un workflow* más abajo).
- Para Outlook, las notificaciones llegan por Azure Event Hubs (ver el README del servidor Outlook). Sin ellas, la herramienta igual responde cada 15 minutos.

### Opciones de inicio

El nodo Inicio enumera cómo comienza el flujo: **Escribir el prompt**, **Programar** y cada **opción de evento** que hayas añadido. Son botones de opción: solo una está elegida a la vez; elegir otra cambia a ella.

- **Escribir el prompt / Programar:** haz clic en el texto para cambiar a esa opción y abrir el cuadro del prompt o los campos de programación (ejecutar a, repetir, cron). Programar queda elegida cuando guardas la programación. Elegir en su lugar Escribir el prompt (o una opción de evento) elimina la programación.
- **Añadir una opción:** arrastra un componente de la Biblioteca de componentes de código sobre cualquier nodo Inicio. Elige la herramienta de espera (para Outlook, `wait_for_new`), sus argumentos y la salida que lleva el trabajo. El Inicio de cada flujo la mostrará.
- **Usarla:** elige la opción en Inicio. Inicio se convierte en el componente: muestra un conector por salida (para Outlook, `new_mail`, `no_mail`, `error`) y enlazas cada uno con lo que debe ocurrir después. El flujo se ejecuta cuando llega el evento; lo que sale por un conector (el correo en `new_mail`) es la entrada del nodo siguiente. Los enlaces que ya tenía Inicio pasan a la salida que lleva el trabajo.
- **Volver atrás:** elige Escribir el prompt o Programar. Inicio vuelve a tener un solo conector: los enlaces de la salida que lleva el trabajo se quedan, los demás se eliminan. Una advertencia los enumera antes; Cancelar no cambia nada.
- **Editarla o quitarla:** el componente solo se edita en la Biblioteca de componentes de código, y cada Inicio que lo usa se actualiza. Si al guardar se quitan salidas que tienen enlaces en algún flujo, una advertencia enumera esos flujos y enlaces antes. ⋮ en el componente → Editar la opción de inicio o Quitar la opción de inicio; al quitarla, esos Inicio vuelven a ser un Inicio normal.

#### Activar un workflow

Elegir un modo de entrada solo lo selecciona. Para que un workflow se ejecute solo, haz clic en ▶ en Start:

- **Enter Prompt:** ▶ abre la conversación, como antes.
- **Set Schedule** o una **opción de código** (por ejemplo «Outlook: Get New Email»): ▶ activa el workflow. El
  servicio de eventos lo ejecuta a las horas programadas, o espera el evento y lo ejecuta en cada uno. ■ lo desactiva.

Solo hay un workflow activo a la vez: activar otro desactiva el primero (se te pregunta antes). Cambiar el modo de
entrada del workflow activo lo desactiva. Un Start sin enlaces no se puede activar. Start muestra el estado:
*Escuchando eventos*, *Ejecutando…*, *Activo — próxima ejecución …*, *Sin escuchar:* y el motivo, o *El servicio de
eventos no está funcionando* cuando el servicio en segundo plano está detenido.

Cualquier servidor MCP puede ser una fuente de eventos para una opción de código si ofrece una herramienta de espera
que responde `{"status": "ready"}` o `{"status": "timeout"}`, como `wait_for_new` de Outlook.

## Compilar a Python

Cualquier workflow puede **compilarse a Python autónomo** para uno de cuatro frameworks de agentes. Usa **Compilar workflow** en la barra de herramientas y elige un destino:

- **LangGraph**
- **ADK** (Google Agent Development Kit)
- **MAF** (Microsoft Agent Framework)
- **NOOA** (NVIDIA OO Agents)

El menú de cada destino ofrece **Setup** (los pasos, una sola vez, para añadir ese framework a tu runner local), **Generate**, **Info**, **Run**, **Stop**, **Display Code**, **Export** (un zip) y **Architecture** (una descripción del código generado).

Elige una estructura en las opciones de generación:

- **Archivo único** — todo el workflow en un único archivo `.py`.
- **Agentes en archivos separados** — un paquete Python con un módulo por agente.
- **A2A** — un servidor Agent-to-Agent por nodo, más un orquestador.

El código generado no necesita esta aplicación para ejecutarse: lleva su propio cliente MCP, el arnés de los nodos de código, el intérprete de playbooks y el enrutamiento. Las direcciones de los servidores y las cabeceras de conexión van en su archivo `.env`. El editor lo escribe en `python/scripts/` de tu carpeta local, y el runner local lo ejecuta en tu ordenador: así un workflow puede leer tus archivos y hacerte preguntas mientras se ejecuta.

Si un destino no admite algo que usa el workflow (un swarm fuera de LangGraph, por ejemplo), la compilación indica qué nodo y por qué, en lugar de producir código que funciona a medias. **Vuelve a compilar después de cambiar el workflow.**

## Tipos de nodo

- **Start** — cómo empieza el workflow: un prompt, un horario o un evento (consulta *Opciones de inicio*).
- **Agente** — una llamada a un LLM con sus propias instrucciones, proveedor, herramientas, servidores MCP y habilidades.
- **Dispatcher** — un agente de tipo *Dispatcher*: envía cada solicitud exactamente a una de las ramas conectadas tras él (ver más abajo).
- **Playbook** — un agente de tipo *Playbook*: sigue un procedimiento escrito paso a paso, con **puertas** que piden a una persona rellenar un formulario, aprobar o tomar el relevo. Las preguntas aparecen en la conversación; una ejecución desatendida termina limpiamente en una puerta.
- **Código** — Python `run(input, call_tool)` que llama directamente a herramientas MCP, con **salidas** con nombre: solo se ejecutan después los nodos de la salida tomada (consulta *Nodo de código*).
- **Salida** — devuelve la respuesta, en línea, en un archivo o ambos. Cada nodo puede tener además un **JSON Schema** para una salida estructurada.
- **Ingesta** — Cargador → Divisor → Base vectorial, para indexar documentos.
- **Tiempo real** — nodos de voz para conversaciones de audio en tiempo real.

## Nodo de código

Abre un nodo de código con su lápiz ✏️:

- **Code** — escribe `def run(input, call_tool)`. `call_tool("<servidor>", "<herramienta>", {...})` llama a una herramienta de un servidor MCP marcado. El **Asistente** bajo el código puede escribirlo por ti a partir de la documentación de las herramientas; revisa la comparación y luego **Aceptar** o **Descartar**.
- **MCP Servers** — marca los servidores a los que puede llamar el código.
- **Tools** — qué reciben y devuelven las herramientas de cada servidor marcado. No se llama a nada.
- **Settings** — el nombre, las **salidas** (separadas por comas, un conector cada una; vacío = la salida va al nodo siguiente) y el tiempo límite. El código puede leer `NODE_NAME`.
- **Input / Output / Logs** — la última ejecución de este nodo.

El código se ejecuta en tu navegador cuando ejecutas el workflow en el editor, y en el programa compilado en los demás casos, con las mismas reglas: se rechazan los módulos que acceden directamente a la red o al sistema, y las herramientas pasan por `call_tool`.

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
- El código de un nodo Code puede leer `NODE_NAME`, su nombre en el lienzo. Un solo componente de la Code Library puede servir a todas las ramas: por ejemplo archiva el correo en `"Inbox/" + NODE_NAME`, así la rama *claims* lo archiva en Inbox/Claims (los nombres de carpeta no distinguen mayúsculas).

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
