"""Tests for DebugLogger."""
import os
import tempfile
from app.services.debug_logger import DebugLogger
from app.support.phpcompat import php_date


def test_debug_logger_timestamp_uses_php_date():
    """Timestamp must use php_date (PHP timezone) not naive datetime."""
    logger = DebugLogger(enabled=True, include_timestamp=True)

    # Format a message and check the timestamp matches php_date pattern
    formatted = logger._formatMessage('debug', 'test message', {})

    # Extract the timestamp from the formatted message
    # Format: [YYYY-MM-DD HH:MM:SS] [LEVEL] [AIPortfolioAssistant] message
    import re
    match = re.match(r'\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]', formatted)
    assert match is not None, f"Timestamp not found in: {formatted}"

    # Get current php_date time (to the minute since seconds might vary)
    php_now = php_date('Y-m-d H:i:s')
    timestamp_from_log = match.group(1)

    # Compare to the minute (first 16 characters: YYYY-MM-DD HH:MM)
    assert timestamp_from_log[:16] == php_now[:16], f"Timestamp {timestamp_from_log} doesn't match php_date {php_now}"


def test_debug_logger_file_output():
    """DebugLogger should write to file when log_file is set."""
    with tempfile.NamedTemporaryFile(mode='w', delete=False, suffix='.log') as f:
        log_file = f.name

    try:
        logger = DebugLogger(enabled=True, log_file=log_file, include_timestamp=False)
        logger.info('test message', {'key': 'value'})

        # Read the file and verify content
        with open(log_file, 'r') as f:
            content = f.read()

        assert 'test message' in content
        assert 'key' in content
        assert 'value' in content
    finally:
        if os.path.exists(log_file):
            os.remove(log_file)


def test_debug_logger_disabled():
    """DebugLogger should not output when disabled."""
    with tempfile.NamedTemporaryFile(mode='w', delete=False, suffix='.log') as f:
        log_file = f.name

    try:
        logger = DebugLogger(enabled=False, log_file=log_file)
        logger.info('should not appear', {})

        # File should be empty or not created
        if os.path.exists(log_file):
            with open(log_file, 'r') as f:
                content = f.read()
            assert content == '', "DebugLogger should not output when disabled"
    finally:
        if os.path.exists(log_file):
            os.remove(log_file)


def test_debug_logger_chainable_methods():
    """setEnabled and setLogFile should return self for chaining."""
    logger = DebugLogger()
    result = logger.setEnabled(True).setLogFile('/tmp/test.log')
    assert result is logger, "setEnabled/setLogFile should return self for chaining"
    assert logger.enabled is True
    assert logger.log_file == '/tmp/test.log'
