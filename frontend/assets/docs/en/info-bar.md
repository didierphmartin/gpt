# Info bar

The thin blue strip above the chat surface. It holds two action links plus a status counter.

## Functions available

A live count of tools the active AI provider can currently call (built-in tools + connected MCP server tools).

## View Functions

Opens a panel listing every tool the AI can call right now, with each tool's input schema. Useful for:

- Seeing what's actually available to the model.
- Debugging why a tool wasn't called (it may not be enabled for the active provider).
- Discovering MCP server tools you've connected.

## View Context

Shows exactly what's being sent to the AI on the next request:

- The system prompt (your default + any active skill).
- The conversation history (recent turns).
- Attachments queued for the next message.

Handy for debugging when the AI's answer doesn't match what you expected — the cause is almost always something in the context that surprised you.
