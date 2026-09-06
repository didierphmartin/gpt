"""Port of Services/ToolsManager.php.

Manages and executes LLM tool functions.
"""
from __future__ import annotations

import json
from pathlib import Path

from app.contracts.function_executor import FunctionExecutorInterface
from app.exceptions import FunctionExecutionException


class ToolsManager(FunctionExecutorInterface):
    """Manages and executes LLM tool functions."""

    def __init__(self, toolsJsonPath: str | None = None):
        self.functions: dict = {}
        self.schemas: dict = {}
        self.toolsJsonPath: str | None = None
        self.cachedToolDefinitions: list = []

        if toolsJsonPath:
            self.toolsJsonPath = toolsJsonPath
            self._loadToolsFromJson()

    def registerFunction(self, name: str, handler, schema: dict) -> 'ToolsManager':
        """Register a new function."""
        self.functions[name] = handler
        self.schemas[name] = schema
        self.cachedToolDefinitions = []  # Clear cache
        return self

    def registerFunctions(self, functions: dict) -> 'ToolsManager':
        """Register multiple functions at once."""
        for name, config in functions.items():
            self.registerFunction(name, config['handler'], config['schema'])
        return self

    def execute(self, functionName: str, parameters: dict, context=None) -> dict:
        """Execute a function by name."""
        if not self.hasFunction(functionName):
            raise FunctionExecutionException.notFound(functionName)

        try:
            handler = self.functions[functionName]
            result = handler(parameters, context)

            if not isinstance(result, (dict, list)):
                result = {'result': result}

            return result
        except Exception as e:
            raise FunctionExecutionException.executionFailed(functionName, str(e))

    def hasFunction(self, functionName: str) -> bool:
        """Check if a function is registered."""
        return functionName in self.functions

    def getRegisteredFunctions(self) -> list:
        """Get all registered function names."""
        return list(self.functions.keys())

    def getToolDefinitions(self) -> list:
        """Get tool definitions for the LLM API."""
        if self.cachedToolDefinitions:
            return self.cachedToolDefinitions

        definitions = []
        for name, schema in self.schemas.items():
            definitions.append({
                'name': name,
                'description': schema.get('description') if schema.get('description') is not None else f"Execute {name}",
                'input_schema': schema.get('input_schema') if schema.get('input_schema') is not None else {
                    'type': 'object',
                    'properties': {},
                    'required': [],
                },
            })

        self.cachedToolDefinitions = definitions
        return definitions

    def _loadToolsFromJson(self) -> None:
        """Load tool definitions from JSON file."""
        if not self.toolsJsonPath or not Path(self.toolsJsonPath).exists():
            return

        content = Path(self.toolsJsonPath).read_text()
        try:
            tools = json.loads(content)
        except ValueError:
            return

        if not isinstance(tools, (dict, list)):
            return

        for tool in tools:
            name = tool.get('name')
            if not name:
                continue

            self.schemas[name] = {
                'description': tool.get('description') if tool.get('description') is not None else '',
                'input_schema': tool.get('input_schema') if tool.get('input_schema') is not None else {
                    'type': 'object',
                    'properties': {},
                    'required': [],
                },
            }

    def loadFromJson(self, path: str) -> 'ToolsManager':
        """Set tool definitions from JSON path."""
        self.toolsJsonPath = path
        self._loadToolsFromJson()
        self.cachedToolDefinitions = []
        return self

    def getSchema(self, functionName: str) -> dict | None:
        """Get schema for a specific function."""
        return self.schemas.get(functionName)

    def removeFunction(self, functionName: str) -> 'ToolsManager':
        """Remove a function."""
        self.functions.pop(functionName, None)
        self.schemas.pop(functionName, None)
        self.cachedToolDefinitions = []
        return self

    def clear(self) -> 'ToolsManager':
        """Clear all registered functions."""
        self.functions = {}
        self.schemas = {}
        self.cachedToolDefinitions = []
        return self

    def isMCPTool(self, functionName: str) -> bool:
        """ToolsManager only handles regular tools, so always returns False."""
        return False
