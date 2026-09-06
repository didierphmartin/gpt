"""Interface for tracking LLM usage and costs."""
from abc import ABC, abstractmethod


class UsageTrackerInterface(ABC):
    """Interface for tracking LLM usage and costs."""

    @abstractmethod
    def trackRequest(self, data: dict) -> None:
        """
        Track an API request.

        Args:
            data: Request data including:
                - user_id: User making the request
                - provider: AI provider name
                - model: Model used
                - input_tokens: Number of input tokens
                - output_tokens: Number of output tokens
                - function_calls_count: Number of function calls
                - response_time_ms: Response time in milliseconds
                - status: 'success' or 'error'
                - error_message: Error message if status is 'error'
        """
        pass

    @abstractmethod
    def trackFunctionCall(
        self,
        function_name: str,
        provider: str,
        execution_time_ms: int,
        success: bool,
        user_id: str = None,
    ) -> None:
        """Track a function call."""
        pass

    @abstractmethod
    def getUserStats(self, user_id: str, period: str = 'day') -> dict:
        """Get usage statistics for a user."""
        pass

    @abstractmethod
    def getStats(self, period: str = 'day') -> dict:
        """Get overall usage statistics."""
        pass

    @abstractmethod
    def calculateCost(
        self,
        provider: str,
        model: str,
        input_tokens: int,
        output_tokens: int,
    ) -> float:
        """Calculate estimated cost for tokens."""
        pass
