"""Port of backend/src/AgentTeam/Services/AgentToolsExecutor.php (205 lines).

Combines built-in tools, MCP tools, and delegation tools into a single
executor. Used when running agents to provide unified tool execution.

`private` PHP methods/props -> `_name`. Implements the same shape as
`FunctionExecutorInterface` (app.contracts.function_executor).
"""
from __future__ import annotations

from app.contracts.function_executor import FunctionExecutorInterface

# PHP: self::DELEGATION_TOOLS (AgentToolsExecutor.php 30-34).
DELEGATION_TOOLS = (
    'delegate_to_agent',
    'list_available_agents',
    'run_agents_parallel',
)


class AgentToolsExecutor(FunctionExecutorInterface):
    def __init__(self, baseExecutor, delegationFunctions=None):
        self.baseExecutor = baseExecutor
        self.delegationFunctions = delegationFunctions
        self.executionContext: dict = {}

    def setExecutionContext(self, context: dict) -> 'AgentToolsExecutor':
        self.executionContext = context
        return self

    def getExecutionContext(self) -> dict:
        return self.executionContext

    def execute(self, functionName: str, parameters: dict, context=None) -> dict:
        """PHP 64-78."""
        if self.isDelegationTool(functionName):
            if not self.delegationFunctions:
                return {'error': 'Delegation functions not configured'}
            return self._executeDelegationTool(functionName, parameters)

        return self.baseExecutor.execute(functionName, parameters, context)

    def _executeDelegationTool(self, toolName: str, parameters: dict) -> dict:
        """PHP 84-100 (`executeDelegationTool`)."""
        functions = self.delegationFunctions.getAllFunctions()

        if toolName not in functions:
            return {'error': f'Unknown delegation tool: {toolName}'}

        handler = functions[toolName]['handler']

        try:
            return handler(parameters, self.executionContext)
        except Exception as e:  # noqa: BLE001 -- mirrors PHP `catch (\Throwable $e)`
            return {'error': f'Delegation tool error: {e}'}

    def isDelegationTool(self, functionName: str) -> bool:
        return functionName in DELEGATION_TOOLS

    def hasFunction(self, functionName: str) -> bool:
        if self.isDelegationTool(functionName) and self.delegationFunctions:
            return True
        return self.baseExecutor.hasFunction(functionName)

    def getRegisteredFunctions(self) -> list:
        functions = self.baseExecutor.getRegisteredFunctions()

        if self.delegationFunctions:
            functions = list(functions) + list(DELEGATION_TOOLS)

        return functions

    def getToolDefinitions(self) -> list:
        """PHP 139-155."""
        tools = list(self.baseExecutor.getToolDefinitions())

        if self.delegationFunctions:
            for name, func in self.delegationFunctions.getAllFunctions().items():
                tools.append({
                    'name': name,
                    'description': func['schema']['description'],
                    'input_schema': func['schema']['input_schema'],
                })

        return tools

    def getDelegationToolDefinitions(self) -> list:
        """PHP 160-176."""
        if not self.delegationFunctions:
            return []

        tools = []
        for name, func in self.delegationFunctions.getAllFunctions().items():
            tools.append({
                'name': name,
                'description': func['schema']['description'],
                'input_schema': func['schema']['input_schema'],
            })

        return tools

    def registerFunction(self, name: str, handler, schema: dict) -> 'AgentToolsExecutor':
        self.baseExecutor.registerFunction(name, handler, schema)
        return self

    def isMCPTool(self, functionName: str) -> bool:
        if hasattr(self.baseExecutor, 'isMCPTool'):
            return self.baseExecutor.isMCPTool(functionName)
        return False

    def getBaseExecutor(self):
        return self.baseExecutor
