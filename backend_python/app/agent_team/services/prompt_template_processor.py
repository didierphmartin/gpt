"""Prompt Template Processor

Processes template placeholders in prompts, replacing them with dynamic
values. Supports date/time, user context, workflow context, and custom
variables.

Template syntax: [placeholder_name] or [var:custom_name]

Available placeholders:
- Date/Time: [date], [time], [datetime], [year], [month], [day], [weekday], [timezone]
- User: [username], [user_email], [user_id], [user_locale]
- Workflow: [workflow_name], [workflow_id], [agent_name], [node_name], [user_prompt]
- System: [app_name], [app_version]
- Custom: [var:name] for workflow-defined variables

Ported from backend/src/AgentTeam/Services/PromptTemplateProcessor.php.
"""
from __future__ import annotations

import re
from typing import Optional
from zoneinfo import ZoneInfo

from app.support.phpcompat import php_date, php_strval, php_tz

_PLACEHOLDER_RE = re.compile(r'\[([a-zA-Z_][a-zA-Z0-9_:]*)\]')
_HAS_PLACEHOLDER_RE = re.compile(r'\[[a-zA-Z_][a-zA-Z0-9_:]*\]')


class PromptTemplateProcessor:
    def __init__(self) -> None:
        self._context: dict = {}
        self._timezone: Optional[str] = None

    def setContext(self, context: dict) -> "PromptTemplateProcessor":
        """Set the context for template processing (merged into any existing context)."""
        self._context = {**self._context, **context}
        return self

    def setTimezone(self, timezone: str) -> "PromptTemplateProcessor":
        """Set timezone for date/time formatting."""
        self._timezone = timezone
        return self

    def process(self, prompt: str) -> str:
        """Process a prompt string, replacing all template placeholders."""
        return _PLACEHOLDER_RE.sub(lambda m: self._replacePlaceholder(m.group(1)), prompt)

    def _replacePlaceholder(self, placeholder: str) -> str:
        """Replace a single placeholder with its value."""
        if placeholder.startswith('var:'):
            varName = placeholder[4:]
            return self._getCustomVariable(varName)

        ctx = self._context

        if placeholder == 'date':
            return self._formatDate('F j, Y')            # April 7, 2026
        if placeholder == 'time':
            return self._formatDate('g:i A')              # 3:45 PM
        if placeholder == 'datetime':
            return self._formatDate('F j, Y g:i A')       # April 7, 2026 3:45 PM
        if placeholder == 'year':
            return self._formatDate('Y')                  # 2026
        if placeholder == 'month':
            return self._formatDate('F')                  # April
        if placeholder == 'month_num':
            return self._formatDate('n')                  # 4
        if placeholder == 'day':
            return self._formatDate('j')                  # 7
        if placeholder == 'weekday':
            return self._formatDate('l')                  # Monday
        if placeholder == 'timezone':
            return self._getTimezone()
        if placeholder == 'iso_date':
            return self._formatDate('Y-m-d')               # 2026-04-07
        if placeholder == 'iso_datetime':
            return self._formatDate('c')                   # ISO 8601 format

        if placeholder == 'username':
            v = ctx.get('username')
            return v if v is not None else 'User'
        if placeholder == 'user_email':
            v = ctx.get('user_email')
            return v if v is not None else ''
        if placeholder == 'user_id':
            v = ctx.get('user_id')
            return php_strval(v if v is not None else '')
        if placeholder == 'user_locale':
            v = ctx.get('user_locale')
            return v if v is not None else 'en-US'

        if placeholder == 'workflow_name':
            v = ctx.get('workflow_name')
            return v if v is not None else ''
        if placeholder == 'workflow_id':
            v = ctx.get('workflow_id')
            return php_strval(v if v is not None else '')
        if placeholder == 'agent_name':
            v = ctx.get('agent_name')
            return v if v is not None else ''
        if placeholder == 'node_name':
            v = ctx.get('node_name')
            return v if v is not None else ''
        if placeholder == 'node_id':
            v = ctx.get('node_id')
            return php_strval(v if v is not None else '')
        if placeholder == 'user_prompt':
            v = ctx.get('user_prompt')
            return v if v is not None else ''
        if placeholder == 'previous_output':
            v = ctx.get('previous_output')
            return v if v is not None else ''

        if placeholder == 'app_name':
            v = ctx.get('app_name')
            return v if v is not None else 'AI Assistant'
        if placeholder == 'app_version':
            v = ctx.get('app_version')
            return v if v is not None else '1.0'

        # Unknown placeholder - return as-is
        return f'[{placeholder}]'

    def _formatDate(self, fmt: str) -> str:
        """Format current date/time."""
        return php_date(fmt, tz=self._getTimezoneObject())

    def _getTimezone(self) -> str:
        """Get timezone string."""
        return self._timezone if self._timezone is not None else php_tz().key

    def _getTimezoneObject(self) -> ZoneInfo:
        """Get ZoneInfo object (PHP DateTimeZone equivalent)."""
        name = self._timezone if self._timezone is not None else php_tz().key
        try:
            return ZoneInfo(name)
        except Exception:
            return ZoneInfo('UTC')

    def _getCustomVariable(self, name: str) -> str:
        """Get a custom variable value."""
        # Check in custom_vars context
        customVars = self._context.get('custom_vars')
        if isinstance(customVars, dict) and customVars.get(name) is not None:
            return php_strval(customVars[name])

        # Check in workflow_vars context (alternative location)
        workflowVars = self._context.get('workflow_vars')
        if isinstance(workflowVars, dict) and workflowVars.get(name) is not None:
            return php_strval(workflowVars[name])

        # Return placeholder as-is if not found
        return f'[var:{name}]'

    @staticmethod
    def getAvailablePlaceholders() -> dict:
        """Get list of all available placeholders with descriptions."""
        return {
            'Date/Time': {
                '[date]': 'Current date (e.g., "April 7, 2026")',
                '[time]': 'Current time (e.g., "3:45 PM")',
                '[datetime]': 'Full date and time',
                '[year]': 'Current year (e.g., "2026")',
                '[month]': 'Current month name (e.g., "April")',
                '[month_num]': 'Current month number (e.g., "4")',
                '[day]': 'Day of month (e.g., "7")',
                '[weekday]': 'Day of week (e.g., "Monday")',
                '[timezone]': 'Current timezone',
                '[iso_date]': 'ISO date format (YYYY-MM-DD)',
                '[iso_datetime]': 'ISO 8601 datetime format',
            },
            'User Context': {
                '[username]': "Current user's name",
                '[user_email]': "User's email address",
                '[user_id]': "User's ID",
                '[user_locale]': 'User\'s locale (e.g., "en-US")',
            },
            'Workflow Context': {
                '[workflow_name]': 'Name of current workflow',
                '[workflow_id]': 'ID of current workflow',
                '[agent_name]': "This agent's name",
                '[node_name]': 'Current node name',
                '[node_id]': 'Current node ID',
                '[user_prompt]': 'Original user input/prompt',
                '[previous_output]': 'Output from previous node',
            },
            'System': {
                '[app_name]': 'Application name',
                '[app_version]': 'Application version',
            },
            'Custom Variables': {
                '[var:name]': 'Custom workflow variable (replace "name" with variable name)',
            },
        }

    @staticmethod
    def hasPlaceholders(text: str) -> bool:
        """Check if a string contains any template placeholders."""
        return _HAS_PLACEHOLDER_RE.search(text) is not None
