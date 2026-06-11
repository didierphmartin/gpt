# Configuración

El panel de configuración te permite adaptar la aplicación a tus cuentas y preferencias.

## Claves API

Trae tus propias claves por proveedor. La aplicación usa claves compartidas por defecto cuando no hay ninguna establecida — pero una clave personalizada te ofrece:

- **Mayores límites de tasa** (tu cuenta, no un pool compartido).
- **Visibilidad directa de la facturación** en el panel del proveedor.
- **Privacidad** — tus prompts pasan por tu cuenta.

Las claves se almacenan cifradas en el servidor. Solo se devuelven valores enmascarados; nunca vuelves a ver la clave completa después de guardarla.

## Modelo por defecto por proveedor

Elige qué modelo específico debe usar cada proveedor por defecto (por ejemplo, `claude-sonnet-4-5` en lugar de `claude-opus-4-7`).

## Servidores MCP

Conecta servidores de herramientas externos mediante el **Model Context Protocol**. Una vez conectado, cada herramienta expuesta por el servidor es invocable por la IA exactamente como una herramienta integrada. Casos de uso habituales:

- Integraciones a medida (APIs internas, CRM, ticketing).
- Herramientas especializadas (generación de imágenes, consultas a BD, conversión de formatos).
- Puente con otros ecosistemas.

## Proveedores de almacenamiento

Vincula Google Drive (u otros proveedores compatibles) para guardar las salidas externamente — útil si quieres tener automáticamente los resultados de los workflows en tu Drive.

## Teléfono y WebAuthn

- Vincula un número de teléfono para la recuperación de cuenta.
- Registra una passkey (WebAuthn) para inicio de sesión biométrico en dispositivos compatibles.
