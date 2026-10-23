# Habilidades

Una habilidad (skill) enseña al asistente una tarea que puede **realizar**: generar un documento Word, convertir un archivo, rellenar una plantilla, analizar una hoja de cálculo…

## Qué es una habilidad

Una habilidad es una **carpeta** dentro de la carpeta `skills/` de tu carpeta synergyAI local. Contiene un archivo `SKILL.md` (su nombre, una descripción de cuándo usarla e instrucciones) y normalmente scripts Python. Los scripts se ejecutan **en tu navegador** (Pyodide), sobre tu carpeta local: no se envía nada a un servidor para ejecutarlos. Lo que produce una habilidad llega a `outputs/`.

## Usar una habilidad

- **Automáticamente** — solo pídelo: «convierte este documento en una presentación». El asistente lee las descripciones de las habilidades y elige la adecuada.
- **A elección** — arrastra una habilidad sobre el campo de entrada: aparece una etiqueta y el siguiente mensaje la usa. Haz clic en la × de la etiqueta para quitarla.
- **En un workflow** — un agente puede tener una habilidad, que se ejecuta entonces como un paso después de su respuesta.

## Añadir habilidades

- **Importa** una carpeta de habilidad, un archivo `.zip` o `.skill`, o una habilidad desde GitHub.
- **Escribe una** — crea una carpeta con un `SKILL.md`; la descripción de su encabezado es lo que el asistente lee para decidir cuándo usarla.

Cuando el script de una habilidad falla, el asistente puede proponer una corrección (autorreparación), y la vista Habilidades permite revisarlas y mejorarlas con el tiempo.
