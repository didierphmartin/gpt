# Workflows

Construye pipelines automatizados de varios pasos que orquestan agentes de IA y herramientas.

![Captura de pantalla del editor de workflows](assets/docs/images/workflow.png)

## Editor visual

Los workflows se construyen en un **editor de arrastrar y soltar** (drawflow). Cada nodo es un agente, una llamada a herramienta, un adjunto o un formateador de salida. Conecta los nodos para definir el flujo.

## Ejecución

Dos modos de ejecución:

- **Bajo demanda** — haz clic en «Ejecutar» desde el editor o la barra lateral.
- **Programado** — programación tipo cron (por ejemplo, todos los días laborables a las 9:00).

## Salidas

Las salidas se pueden mostrar de dos maneras:

- **En línea** en el chat como una respuesta normal.
- **Escritas en una carpeta** de tu equipo (la misma carpeta que exploras desde Almacenamiento de archivos).

## Salidas estructuradas

Cada nodo puede asociarse con un **esquema JSON** para decodificación restringida — garantiza que la salida cumple una forma definida, útil para procesamiento posterior.

## Compilar a Python

Cualquier workflow puede **compilarse en una aplicación Python independiente**. El script generado usa LangGraph y puede ejecutarse independientemente de la aplicación web — útil cuando quieres distribuir un workflow como CLI o como script programado.

## Tipos de nodo

- **Agente** — ejecuta una llamada LLM con instrucciones específicas.
- **Llamada a herramienta** — invoca una herramienta integrada o de servidor MCP.
- **Documento** — adjunta PDFs, documentos Office, etc., como contexto.
- **Esquema** — aplica un esquema JSON para restringir la forma de la salida.
- **Salida** — escribe los resultados en línea, en un archivo o en ambos.
