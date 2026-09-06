"""Interface for executing LLM function calls."""
from abc import ABC, abstractmethod


class FunctionExecutorInterface(ABC):
    """Interface for executing LLM function calls."""

    @abstractmethod
    def execute(self, function_name: str, parameters: dict, context=None) -> dict:
        """
        Execute a function by name with given parameters.

        Args:
            function_name: Name of the function to execute
            parameters: Function parameters
            context: Additional context (e.g., user ID, JWT token)

        Returns:
            Function result
        """
        pass

    @abstractmethod
    def hasFunction(self, function_name: str) -> bool:
        """Check if a function is registered."""
        pass

    @abstractmethod
    def getRegisteredFunctions(self) -> list:
        """Get all registered function names."""
        pass

    @abstractmethod
    def getToolDefinitions(self) -> list:
        """Get the tool definition for Claude API."""
        pass

    @abstractmethod
    def registerFunction(self, name: str, handler, schema: dict):
        """
        Register a new function.

        Args:
            name: Function name
            handler: Function handler
            schema: Tool schema for the LLM
        """
        pass

    @abstractmethod
    def isMCPTool(self, function_name: str) -> bool:
        """
        Check if a function is an MCP tool.

        Args:
            function_name: Function name to check

        Returns:
            True if this is an MCP tool, false for regular tools
        """
        pass
