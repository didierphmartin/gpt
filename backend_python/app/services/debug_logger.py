"""Debug logger for AI Portfolio Assistant."""
import json
from pathlib import Path
from app.support.logger import error_log
from app.support.phpcompat import php_date


class DebugLogger:
    """Debug logger for AI Portfolio Assistant."""

    # PSR-3 Log levels
    LEVEL_EMERGENCY = 'emergency'
    LEVEL_ALERT = 'alert'
    LEVEL_CRITICAL = 'critical'
    LEVEL_ERROR = 'error'
    LEVEL_WARNING = 'warning'
    LEVEL_NOTICE = 'notice'
    LEVEL_INFO = 'info'
    LEVEL_DEBUG = 'debug'

    def __init__(self, enabled: bool = False, log_file: str = None, include_timestamp: bool = True):
        """Initialize the debug logger."""
        self.enabled = enabled
        self.log_file = log_file
        self.include_timestamp = include_timestamp

    def emergency(self, message: str, context: dict = None) -> None:
        """Log an emergency message."""
        self.log(self.LEVEL_EMERGENCY, message, context)

    def alert(self, message: str, context: dict = None) -> None:
        """Log an alert message."""
        self.log(self.LEVEL_ALERT, message, context)

    def critical(self, message: str, context: dict = None) -> None:
        """Log a critical message."""
        self.log(self.LEVEL_CRITICAL, message, context)

    def error(self, message: str, context: dict = None) -> None:
        """Log an error message."""
        self.log(self.LEVEL_ERROR, message, context)

    def warning(self, message: str, context: dict = None) -> None:
        """Log a warning message."""
        self.log(self.LEVEL_WARNING, message, context)

    def notice(self, message: str, context: dict = None) -> None:
        """Log a notice message."""
        self.log(self.LEVEL_NOTICE, message, context)

    def info(self, message: str, context: dict = None) -> None:
        """Log an info message."""
        self.log(self.LEVEL_INFO, message, context)

    def debug(self, message: str, context: dict = None) -> None:
        """Log a debug message."""
        self.log(self.LEVEL_DEBUG, message, context)

    def log(self, level: str, message: str, context: dict = None) -> None:
        """
        Log a message at the specified level.

        Args:
            level: PSR-3 log level
            message: The log message
            context: Additional context data
        """
        if not self.enabled:
            return

        if context is None:
            context = {}

        formatted_message = self._formatMessage(level, message, context)

        if self.log_file:
            # Append to file
            try:
                with open(self.log_file, 'a', encoding='utf-8') as f:
                    f.write(formatted_message + '\n')
            except Exception as e:
                error_log(f"Failed to write to log file {self.log_file}: {str(e)}")
        else:
            # Use error_log
            error_log(formatted_message)

    def logApiRequest(self, provider: str, endpoint: str, payload: dict) -> None:
        """
        Log an API request.

        Args:
            provider: The API provider name
            endpoint: The API endpoint
            payload: The request payload
        """
        self.debug(f"API Request to {provider}", {
            'endpoint': endpoint,
            'payload_size': len(json.dumps(payload)),
        })

    def logApiResponse(self, provider: str, status_code: int, response_time_ms: int) -> None:
        """
        Log an API response.

        Args:
            provider: The API provider name
            status_code: The HTTP status code
            response_time_ms: The response time in milliseconds
        """
        level = self.LEVEL_ERROR if status_code >= 400 else self.LEVEL_DEBUG
        self.log(level, f"API Response from {provider}", {
            'status_code': status_code,
            'response_time_ms': response_time_ms,
        })

    def logFunctionCall(self, function_name: str, parameters: dict, execution_time_ms: int, success: bool) -> None:
        """
        Log a function call.

        Args:
            function_name: Name of the function
            parameters: Function parameters
            execution_time_ms: Execution time in milliseconds
            success: Whether the call succeeded
        """
        level = self.LEVEL_DEBUG if success else self.LEVEL_WARNING
        self.log(level, f"Function call: {function_name}", {
            'parameters': parameters,
            'execution_time_ms': execution_time_ms,
            'success': success,
        })

    def setEnabled(self, enabled: bool) -> 'DebugLogger':
        """
        Enable or disable logging.

        Args:
            enabled: Whether logging should be enabled

        Returns:
            self for chaining
        """
        self.enabled = enabled
        return self

    def setLogFile(self, path: str = None) -> 'DebugLogger':
        """
        Set the log file path.

        Args:
            path: Path to the log file (None to disable file logging)

        Returns:
            self for chaining
        """
        self.log_file = path
        return self

    def _formatMessage(self, level: str, message: str, context: dict) -> str:
        """
        Format a log message.

        Args:
            level: The log level
            message: The message
            context: Additional context

        Returns:
            The formatted message
        """
        parts = []

        if self.include_timestamp:
            # Use php_date to match PHP timezone (Europe/Berlin by default)
            parts.append(f"[{php_date('Y-m-d H:i:s')}]")

        parts.append(f"[{level.upper()}]")
        parts.append("[AIPortfolioAssistant]")
        parts.append(message)

        if context:
            parts.append(json.dumps(context, separators=(',', ':')))

        return ' '.join(parts)
