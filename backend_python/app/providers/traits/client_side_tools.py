"""Port of Providers/Traits/ClientSideToolsTrait.php.

Shared client-side tool dispatch helpers for B3, as a mixin class.

"Client-side tools" are LLM-callable tools whose execution lives in the
browser, not on the server. Two sources:
  1. STATIC: getClientSideToolNames() — names hard-coded here
     (run_skill_script, discover_skill, Task, route_to). Each one is
     tightly coupled to a specific frontend dispatcher.
  2. PER-REQUEST: setPerRequestClientSideToolNames() — names supplied by
     the frontend at request time (e.g. webmcp_get_machine_specs from the
     active tab). The provider doesn't know what they do; it just
     short-circuits when the LLM picks one and emits the client_tool_call
     SSE event for the frontend to dispatch.

Instances using this mixin must expose `sseClient` and call
`_init_client_side_tools()` from their constructor (this initializes the
per-request tool name list).
"""
from __future__ import annotations


class ClientSideToolsMixin:
    """Shared client-side tool dispatch helpers."""

    @staticmethod
    def getClientSideToolNames() -> list:
        """Names of statically-known client-side tools.

        route_to: dispatcher agents' branch choice — resolved by the
        workflow runner (DispatchRouting), never executed server-side.
        """
        return ['run_skill_script', 'discover_skill', 'Task', 'route_to']

    def _init_client_side_tools(self) -> None:
        """Initialize per-request additional client-side tool names.

        Set by ChatController before tool dispatch. Lives on the provider
        instance for the duration of one request.
        """
        self.perRequestClientSideToolNames: list = []

    def setPerRequestClientSideToolNames(self, names) -> None:
        """Defensive: only accept non-empty strings."""
        self.perRequestClientSideToolNames = [n for n in names if isinstance(n, str) and n != '']

    def isClientSideTool(self, toolName: str) -> bool:
        """True iff the given tool name is delegated to the browser —
        either because it's in the static list OR because the current
        request registered it as a per-request client-side tool.
        """
        if toolName in self.getClientSideToolNames():
            return True
        if toolName in getattr(self, 'perRequestClientSideToolNames', []):
            return True
        return False

    def emitClientToolCallEvent(self, toolCalls: list, assistantText: str = '', extra: dict | None = None) -> dict:
        """Emit the standard `client_tool_call` SSE event the frontend
        listens for.

        `extra`: provider-specific fields the frontend must replay on the
        next turn, e.g. DeepSeek's reasoning_content ("The
        reasoning_content in the thinking mode must be passed back to the
        API", HTTP 400).
        """
        extra = extra or {}
        payload = {
            **extra,
            'assistant_text': assistantText,
            'tool_calls': toolCalls,
        }
        if self.sseClient:
            self.sseClient.sendCustomEvent('client_tool_call', payload)
        return {
            '_pending_client_tool_call': True,
            '_pending_tool_calls': toolCalls,
            '_pending_assistant_text': assistantText,
            '_pending_assistant_reasoning': str(extra.get('assistant_reasoning') if extra.get('assistant_reasoning') is not None else ''),
        }
