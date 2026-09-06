"""Port of Services/FilteredToolsExecutor.php.

Filters tool definitions to only include allowed tools. Wraps another
FunctionExecutorInterface and filters getToolDefinitions() to only return
tools that are in the allowed list.

Usage:
    filtered = FilteredToolsExecutor(baseExecutor)
    filtered.setAllowedTools(['tool_a', 'mcp_tool_b'])
    provider.setFunctionExecutor(filtered)
"""
from __future__ import annotations

from app.contracts.function_executor import FunctionExecutorInterface
from app.support.logger import error_log


class FilteredToolsExecutor(FunctionExecutorInterface):
    """Filters tool definitions to only include allowed tools."""

    def __init__(self, baseExecutor: FunctionExecutorInterface):
        self.baseExecutor = baseExecutor
        # List of allowed tool names. None means "all allowed".
        self.allowedTools: list | None = None

    def setAllowedTools(self, tools: list | None) -> 'FilteredToolsExecutor':
        """Set the list of allowed tool names."""
        self.allowedTools = tools
        return self

    def getAllowedTools(self) -> list | None:
        """Get the list of allowed tools."""
        return self.allowedTools

    def isFiltering(self) -> bool:
        """Check if filtering is active.

        An EMPTY allow-list is still a filter (= no tools); only None means "all".
        """
        return self.allowedTools is not None

    def execute(self, functionName: str, parameters: dict, context=None) -> dict:
        """Execution is NOT filtered - all registered tools can be executed.

        Only tool definitions returned to LLM are filtered.
        """
        return self.baseExecutor.execute(functionName, parameters, context)

    def hasFunction(self, functionName: str) -> bool:
        """Check if a function is registered."""
        return self.baseExecutor.hasFunction(functionName)

    def getRegisteredFunctions(self) -> list:
        """Get all registered function names (unfiltered)."""
        return self.baseExecutor.getRegisteredFunctions()

    def getToolDefinitions(self) -> list:
        """Get filtered tool definitions for LLM API.

        If allowedTools is set, only returns tools whose names are in the
        list — an empty list returns NO tools (a workflow node that selected
        nothing). Only None returns all tools (conversation mode).
        """
        allTools = self.baseExecutor.getToolDefinitions()

        if self.allowedTools is None:
            return allTools

        filtered = [t for t in allTools if t.get('name', '') in self.allowedTools]

        originalCount = len(allTools)
        filteredCount = len(filtered)
        if filteredCount < originalCount:
            error_log(f"[FilteredToolsExecutor] Filtered tools: {filteredCount}/{originalCount} allowed")

        return filtered

    def registerFunction(self, name: str, handler, schema: dict) -> 'FilteredToolsExecutor':
        """Register a new function (delegates to base executor)."""
        self.baseExecutor.registerFunction(name, handler, schema)
        return self

    def isMCPTool(self, functionName: str) -> bool:
        """Check if a function is an MCP tool."""
        return self.baseExecutor.isMCPTool(functionName)

    def getBaseExecutor(self) -> FunctionExecutorInterface:
        """Get the base executor."""
        return self.baseExecutor
