"""Port of backend/src/AgentTeam/Services/PlaybookOutcome.php.

Playbook node exit rule, shared by all engines: a run whose final status is
'resolved' takes the 'done' exit; any other status takes 'failed'.
"""
from __future__ import annotations

import re

from app.support.phpcompat import php_trim

# PCRE's \s without UCP: ASCII whitespace only.
_WS_RE = re.compile(r'[ \t\n\r\f\v]+')


class PlaybookOutcome:
    @staticmethod
    def exit(status: str) -> str:
        return 'done' if status == 'resolved' else 'failed'

    @staticmethod
    def reason(status: str, gate: str | None) -> str | None:
        """None when done; otherwise 'gate:<kind>' when a gate stopped the run, else 'status:<status>'."""
        if status == 'resolved':
            return None
        return 'gate:' + gate if gate is not None else 'status:' + status

    @staticmethod
    def errorReason(e: BaseException) -> str:
        """'error:<message>' with whitespace runs collapsed to one space (a reason is one line)."""
        return 'error:' + php_trim(_WS_RE.sub(' ', str(e)))

    @staticmethod
    def nodeResult(reason: str | None, transcript: str, jobLine: str | None) -> dict:
        """The node's exit and output text: done iff reason is None; failed text starts with the reason
        line. The job line (from-input nodes), when given, ends the text on both outcomes."""
        text = transcript if reason is None else PlaybookOutcome.failureText(reason, transcript)
        if jobLine is not None:
            text += '\n\n' + jobLine
        return {'exit': 'done' if reason is None else 'failed', 'text': text}

    @staticmethod
    def failureText(reason: str, transcript: str) -> str:
        """Node output on the 'failed' exit: one reason line, a blank line, then the transcript."""
        return f'Playbook failed: {reason}\n\n{transcript}'
