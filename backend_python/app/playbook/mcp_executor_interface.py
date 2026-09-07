"""Port of backend/src/Playbook/McpExecutorInterface.php (12 lines)."""
from __future__ import annotations

from abc import ABC, abstractmethod


class McpExecutorInterface(ABC):
    @abstractmethod
    def call(self, server: str, tool: str, args: dict) -> dict:
        """@return {ok: bool, result?: mixed, error?: str}"""
        raise NotImplementedError

    @abstractmethod
    def availableTools(self) -> dict:
        """@return {"server.tool": {description: str, input_schema: dict}}"""
        raise NotImplementedError
