# Almacenamiento de archivos

Explora la **carpeta local dedicada a esta aplicación** en tu equipo — la misma carpeta donde se escriben las salidas de los workflows.

## Lo que puedes hacer

- Abrir los archivos escritos por los workflows.
- Reincorporar archivos locales a una conversación como adjuntos.
- Inspeccionar las salidas de ejecuciones pasadas sin salir de la aplicación.

## Configuración

Esto requiere que la PWA esté instalada y que se haya concedido el permiso de la carpeta:

1. Instala la aplicación como PWA (el asistente de instalación lo solicita en el primer lanzamiento).
2. Elige una carpeta raíz cuando se te indique.
3. El navegador pedirá una vez que confirmes el acceso a la carpeta — elige **«Permitir en cada visita»** para no tener que volver a autorizar en cada sesión.

El handle de la carpeta se conserva mediante IndexedDB del navegador, por lo que la aplicación lo recuerda entre lanzamientos.

## ¿Por qué una carpeta local?

Almacenar los archivos en local aporta:

- **Privacidad** — las salidas nunca salen de tu equipo a menos que las subas explícitamente.
- **Persistencia** — las salidas de workflow siguen accesibles aunque la aplicación no esté abierta.
- **Interoperabilidad** — abre los archivos en tus editores/visores habituales; Asistente IA es solo uno de los consumidores de la carpeta.
