# Settings

The settings panel lets you tailor the application to your accounts and preferences.

## API keys

Bring your own keys per provider. The application uses default shared keys if you haven't set one — but a custom key gives you:

- **Higher rate limits** (your account, not a shared pool).
- **Direct billing visibility** in the provider's dashboard.
- **Privacy** — your prompts route through your account.

Keys are stored encrypted server-side. Masked values are shown back; you never re-see the full key after saving.

## Default model per provider

Pick which specific model each provider should use by default (e.g., `claude-sonnet-4-5` vs `claude-opus-4-7`).

## MCP servers

Connect external tool servers using the **Model Context Protocol**. Once connected, every tool exposed by the server is callable by the AI exactly like a built-in tool. Common uses:

- Custom integrations (internal APIs, CRM, ticketing).
- Specialized tools (image generation, DB queries, file format converters).
- Bridge to other ecosystems.

## Storage providers

Link Google Drive (or other supported providers) to save outputs externally — useful if you want workflow results in your Drive automatically.

## Phone & WebAuthn

- Link a phone number for account recovery.
- Register a passkey (WebAuthn) for biometric login on supported devices.
