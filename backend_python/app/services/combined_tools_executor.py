"""Port of Services/CombinedToolsExecutor.php.

Combines regular tools with MCP tools for unified execution.
"""
from __future__ import annotations

from app.contracts.function_executor import FunctionExecutorInterface
from app.support.logger import error_log
from app.support.phpjson import dumps as json_encode


class CombinedToolsExecutor(FunctionExecutorInterface):
    """Combines regular tools with MCP tools for unified execution."""

    def __init__(self, baseExecutor: FunctionExecutorInterface, mcpLoader=None):
        self.baseExecutor = baseExecutor
        self.mcpLoader = mcpLoader

    def execute(self, functionName: str, parameters: dict, context=None) -> dict:
        """Execute a function - routes to MCP or base executor."""
        if self.mcpLoader and self.mcpLoader.isMCPTool(functionName):
            error_log(f"🔌 [MCP] Executing MCP tool: {functionName}")
            result = self.mcpLoader.executeTool(functionName, parameters)

            if result.get('error'):
                error_log(f"❌ [MCP] Tool error: {result.get('message') if result.get('message') is not None else 'Unknown error'}")
            else:
                error_log(f"✅ [MCP] Tool result: {json_encode(result)[:200]}")

            return result

        return self.baseExecutor.execute(functionName, parameters, context)

    def hasFunction(self, functionName: str) -> bool:
        """Check if a function is registered (in either executor)."""
        if self.mcpLoader and self.mcpLoader.isMCPTool(functionName):
            return True
        return self.baseExecutor.hasFunction(functionName)

    def getRegisteredFunctions(self) -> list:
        """Get all registered function names (combined from base + MCP)."""
        functions = list(self.baseExecutor.getRegisteredFunctions())

        if self.mcpLoader:
            mcpTools = self.mcpLoader.getTools()
            functions = functions + list(mcpTools.keys())

        return functions

    def getToolDefinitions(self) -> list:
        """Get combined tool definitions."""
        tools = list(self.baseExecutor.getToolDefinitions())

        if self.mcpLoader:
            mcpTools = self.mcpLoader.getToolDefinitions()
            tools = tools + list(mcpTools)

        return tools

    def registerFunction(self, name: str, handler, schema: dict) -> 'CombinedToolsExecutor':
        """Register a new function (delegates to base executor)."""
        self.baseExecutor.registerFunction(name, handler, schema)
        return self

    def getCombinedToolDefinitions(self) -> list:
        """Alias for getToolDefinitions()."""
        return self.getToolDefinitions()

    def getBaseExecutor(self) -> FunctionExecutorInterface:
        """Get base executor."""
        return self.baseExecutor

    def getMCPLoader(self):
        """Get MCP loader."""
        return self.mcpLoader

    def isMCPTool(self, functionName: str) -> bool:
        """Check if a function is an MCP tool."""
        if self.mcpLoader and self.mcpLoader.isMCPTool(functionName):
            return True
        return False
