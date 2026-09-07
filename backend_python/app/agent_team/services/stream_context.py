"""Port of backend/src/AgentTeam/Services/StreamContext.php.

Holds the SSE callback and provides methods for emitting agent activity events.
This context is passed through the delegation chain to enable real-time updates.
"""
from __future__ import annotations

import time
from typing import Callable, Optional

from app.support.logger import error_log
from app.support.phpcompat import mb_substr
from app.support.phpjson import php_json_encode


class StreamContext:
    def __init__(self, on_event: Optional[Callable[[dict], None]] = None, user_id: int = 0):
        self.onEvent = on_event
        self.userId = user_id
        self.rootExecutionId: int | None = None

    def setEventCallback(self, callback: Callable[[dict], None]) -> 'StreamContext':
        self.onEvent = callback
        return self

    def setRootExecutionId(self, execution_id: int) -> 'StreamContext':
        self.rootExecutionId = execution_id
        return self

    def getRootExecutionId(self) -> int | None:
        return self.rootExecutionId

    def getUserId(self) -> int:
        return self.userId

    def isStreaming(self) -> bool:
        return self.onEvent is not None

    def emitAgentStart(
        self,
        agent_id: int,
        agent_name: str,
        agent_type: str,
        parent_agent_id: int | None = None,
        execution_id: int | None = None,
    ) -> None:
        self.emit({
            'type': 'agent_start',
            'agent_id': agent_id,
            'agent_name': agent_name,
            'agent_type': agent_type,
            'parent_agent_id': parent_agent_id,
            'execution_id': execution_id,
            'timestamp': time.time(),
        })

    def emitAgentDelegate(
        self,
        from_agent_id: int,
        from_agent_name: str,
        to_agent_id: int,
        to_agent_name: str,
        task: str,
    ) -> None:
        self.emit({
            'type': 'agent_delegate',
            'from_agent_id': from_agent_id,
            'from_agent_name': from_agent_name,
            'to_agent_id': to_agent_id,
            'to_agent_name': to_agent_name,
            'task': mb_substr(task, 0, 200) + ('...' if len(task) > 200 else ''),
            'timestamp': time.time(),
        })

    def emitAgentComplete(
        self,
        agent_id: int,
        agent_name: str,
        agent_type: str,
        success: bool = True,
        error: str | None = None,
        execution_id: int | None = None,
    ) -> None:
        self.emit({
            'type': 'agent_complete',
            'agent_id': agent_id,
            'agent_name': agent_name,
            'agent_type': agent_type,
            'success': success,
            'error': error,
            'execution_id': execution_id,
            'timestamp': time.time(),
        })

    def emitAgentThinking(
        self,
        agent_id: int,
        agent_name: str,
        status: str = 'thinking',
    ) -> None:
        self.emit({
            'type': 'agent_thinking',
            'agent_id': agent_id,
            'agent_name': agent_name,
            'status': status,
            'timestamp': time.time(),
        })

    def emitChunk(self, text: str, agent_id: int, agent_name: str) -> None:
        self.emit({
            'type': 'chunk',
            'text': text,
            'agent_id': agent_id,
            'agent_name': agent_name,
        })

    def emitError(self, error: str, agent_id: int | None = None) -> None:
        self.emit({
            'type': 'error',
            'error': error,
            'agent_id': agent_id,
            'timestamp': time.time(),
        })

    def emit(self, data: dict) -> None:
        if self.onEvent is not None:
            event_type = data.get('type') if data.get('type') is not None else 'unknown'
            error_log(f'[StreamContext] Emitting event: {event_type} - {php_json_encode(data)}')
            self.onEvent(data)
        else:
            event_type = data.get('type') if data.get('type') is not None else 'unknown'
            error_log(f'[StreamContext] WARNING: No callback set, cannot emit: {event_type}')
