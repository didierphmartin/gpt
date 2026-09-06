"""Exception for function execution errors."""
from .ai_assistant_exception import AIAssistantException


class FunctionExecutionException(AIAssistantException):
    """Exception for function execution errors."""

    def __init__(self, message: str = "", code: int = 0, previous: BaseException | None = None, context: dict | None = None):
        super().__init__(message, code, previous, context)
        self._function_name = None

    def setFunctionName(self, name: str):
        """Set the function name."""
        self._function_name = name
        return self

    def getFunctionName(self) -> str | None:
        """Get the function name."""
        return self._function_name

    @staticmethod
    def notFound(function_name: str):
        """Create exception for function not found."""
        exception = FunctionExecutionException(
            f"Function '{function_name}' is not registered.", 404
        )
        exception.setFunctionName(function_name)
        return exception

    @staticmethod
    def executionFailed(function_name: str, reason: str):
        """Create exception for execution failure."""
        exception = FunctionExecutionException(
            f"Function '{function_name}' execution failed: {reason}", 500
        )
        exception.setFunctionName(function_name)
        return exception

    @staticmethod
    def invalidParameters(function_name: str, details: str):
        """Create exception for invalid parameters."""
        exception = FunctionExecutionException(
            f"Invalid parameters for function '{function_name}': {details}", 400
        )
        exception.setFunctionName(function_name)
        return exception
