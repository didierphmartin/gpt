"""Port of backend/src/Playbook/PlaybookNativeTools.php (166 lines)."""
from __future__ import annotations

from app.support.phpcompat import php_bool


class PlaybookNativeTools:
    def __init__(self, state):
        self.state = state

    def definitions(self) -> list:
        """PHP 11-105."""
        return [
            {
                'type': 'function',
                'function': {
                    'name': 'send_direct_message',
                    'description': 'Send a message directly to the requester',
                    'parameters': {
                        'type': 'object',
                        'properties': {
                            'text': {'type': 'string', 'description': 'Message text'},
                            'sensitive': {'type': 'boolean', 'description': 'Mark as sensitive for redaction'},
                        },
                        'required': ['text'],
                    },
                },
            },
            {
                'type': 'function',
                'function': {
                    'name': 'send_channel_message',
                    'description': 'Send a message to a channel',
                    'parameters': {
                        'type': 'object',
                        'properties': {
                            'channel': {'type': 'string', 'description': 'Channel name'},
                            'text': {'type': 'string', 'description': 'Message text'},
                        },
                        'required': ['channel', 'text'],
                    },
                },
            },
            {
                'type': 'function',
                'function': {
                    'name': 'send_email',
                    'description': 'Send an email',
                    'parameters': {
                        'type': 'object',
                        'properties': {
                            'to': {'type': 'string', 'description': 'Email recipient'},
                            'subject': {'type': 'string', 'description': 'Email subject'},
                            'text': {'type': 'string', 'description': 'Email body'},
                        },
                        'required': ['to', 'subject', 'text'],
                    },
                },
            },
            {
                'type': 'function',
                'function': {
                    'name': 'leave_internal_note',
                    'description': 'Leave an internal note on the run',
                    'parameters': {
                        'type': 'object',
                        'properties': {
                            'text': {'type': 'string', 'description': 'Note text'},
                        },
                        'required': ['text'],
                    },
                },
            },
            {
                'type': 'function',
                'function': {
                    'name': 'set_priority',
                    'description': 'Set the priority of the request',
                    'parameters': {
                        'type': 'object',
                        'properties': {
                            'priority': {'type': 'string', 'description': 'Priority level'},
                            'reason': {'type': 'string', 'description': 'Reason for priority'},
                        },
                        'required': ['priority', 'reason'],
                    },
                },
            },
            {
                'type': 'function',
                'function': {
                    'name': 'resolve_request',
                    'description': 'Mark the request as resolved',
                    'parameters': {
                        'type': 'object',
                        'properties': {
                            'outcome': {'type': 'string', 'description': 'Resolution outcome'},
                            'summary': {'type': 'string', 'description': 'Resolution summary'},
                        },
                        'required': ['outcome', 'summary'],
                    },
                },
            },
        ]

    def execute(self, runId: int, leg: int, name: str, args: dict) -> dict:
        """PHP 107-118."""
        if name == 'send_direct_message':
            return self._sendDirectMessage(runId, args)
        if name == 'send_channel_message':
            return self._sendChannelMessage(runId, args)
        if name == 'send_email':
            return self._sendEmail(runId, args)
        if name == 'leave_internal_note':
            return self._leaveInternalNote(runId, args)
        if name == 'set_priority':
            return self._setPriority(runId, args)
        if name == 'resolve_request':
            return self._resolveRequest(runId, args)
        return {'ok': False, 'error': f'Unknown tool: {name}'}

    def _sendDirectMessage(self, runId: int, args: dict) -> dict:
        text = args.get('text') if args.get('text') is not None else ''
        sensitive = args.get('sensitive') if args.get('sensitive') is not None else False
        self.state.addMessage(runId, 'to_requester', None, text, php_bool(sensitive))
        return {'ok': True}

    def _sendChannelMessage(self, runId: int, args: dict) -> dict:
        channel = args.get('channel') if args.get('channel') is not None else ''
        text = args.get('text') if args.get('text') is not None else ''
        self.state.addMessage(runId, 'to_channel', channel, text, False)
        return {'ok': True}

    def _sendEmail(self, runId: int, args: dict) -> dict:
        to = args.get('to') if args.get('to') is not None else ''
        subject = args.get('subject') if args.get('subject') is not None else ''
        text = args.get('text') if args.get('text') is not None else ''
        self.state.addMessage(runId, 'to_email', to, text, False)
        return {'ok': True}

    def _leaveInternalNote(self, runId: int, args: dict) -> dict:
        text = args.get('text') if args.get('text') is not None else ''
        self.state.addNote(runId, text, 'agent')
        return {'ok': True}

    def _setPriority(self, runId: int, args: dict) -> dict:
        priority = args.get('priority') if args.get('priority') is not None else ''
        reason = args.get('reason') if args.get('reason') is not None else ''
        noteText = f'priority → {priority}: {reason}'
        self.state.addNote(runId, noteText, 'agent')
        return {'ok': True}

    def _resolveRequest(self, runId: int, args: dict) -> dict:
        self.state.setStatus(runId, 'resolved')
        return {'ok': True, 'terminal': True}
