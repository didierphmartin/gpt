"""Exception for AI provider errors."""
from .ai_assistant_exception import AIAssistantException


class ProviderException(AIAssistantException):
    """Exception for AI provider errors (API failures, rate limits, etc.)"""

    def __init__(
        self,
        message: str = "",
        code: int = 0,
        previous: BaseException | None = None,
        context: dict | None = None,
    ):
        super().__init__(message, code, previous, context)
        self._provider = None
        self._http_status_code = None

    def setProvider(self, provider: str):
        """Set the provider name."""
        self._provider = provider
        return self

    def getProvider(self) -> str | None:
        """Get the provider name."""
        return self._provider

    def setHttpStatusCode(self, code: int):
        """Set the HTTP status code."""
        self._http_status_code = code
        return self

    def getHttpStatusCode(self) -> int | None:
        """Get the HTTP status code."""
        return self._http_status_code

    @staticmethod
    def rateLimited(provider: str, retry_after: int = 0):
        """Create exception for rate limit errors."""
        message = f"Rate limited by {provider}. "
        if retry_after > 0:
            message += f"Retry after {retry_after} seconds."
        exception = ProviderException(message, 429)
        exception.setProvider(provider)
        exception.setHttpStatusCode(429)
        return exception

    @staticmethod
    def authenticationFailed(provider: str):
        """Create exception for authentication errors."""
        exception = ProviderException(
            f"Authentication failed for {provider}. Please check your API key.", 401
        )
        exception.setProvider(provider)
        exception.setHttpStatusCode(401)
        return exception

    @staticmethod
    def apiError(provider: str, message: str, status_code: int = 500):
        """Create exception for API errors."""
        exception = ProviderException(f"{provider} API error: {message}", status_code)
        exception.setProvider(provider)
        exception.setHttpStatusCode(status_code)
        return exception
