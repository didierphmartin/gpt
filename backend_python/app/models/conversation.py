"""Conversation model."""
from datetime import datetime, timezone
from app.support.phpcompat import php_uniqid
from .message import Message


class Conversation:
    """Represents a conversation with message history."""

    def __init__(
        self,
        id: str = None,
        user_id: str = None,
        metadata: dict = None,
    ):
        """Initialize a conversation."""
        self.id = id or php_uniqid('conv_')
        self.user_id = user_id
        self.messages = []
        self.created_at = datetime.now(timezone.utc)
        self.updated_at = None
        self.metadata = metadata or {}

    def addMessage(self, message: Message) -> 'Conversation':
        """Add a message to the conversation."""
        self.messages.append(message)
        self.updated_at = datetime.now(timezone.utc)
        return self

    def addUserMessage(self, content: str) -> 'Conversation':
        """Add a user message."""
        return self.addMessage(Message.user(content))

    def addAssistantMessage(self, content: str, metadata: dict = None) -> 'Conversation':
        """Add an assistant message."""
        return self.addMessage(Message.assistant(content, metadata))

    def getMessages(self) -> list:
        """Get all messages."""
        return self.messages

    def getHistory(self) -> list:
        """Get message history as array for API."""
        return [m.toArray() for m in self.messages]

    def getLastMessages(self, count: int) -> list:
        """
        Get the last N messages using PHP array_slice($messages, -$count) semantics:
        - count 3 → last three
        - count 0 → the whole list
        - count -2 → everything from index 2
        """
        return self.messages[-count:] if count else self.messages

    def getLastMessage(self) -> Message | None:
        """Get the last message."""
        return self.messages[-1] if self.messages else None

    def clear(self) -> 'Conversation':
        """Clear all messages."""
        self.messages = []
        self.updated_at = datetime.now(timezone.utc)
        return self

    def getMessageCount(self) -> int:
        """Get message count."""
        return len(self.messages)

    def getId(self) -> str:
        """Get the conversation ID."""
        return self.id

    def getUserId(self) -> str | None:
        """Get the user ID."""
        return self.user_id

    def getCreatedAt(self) -> datetime:
        """Get the created timestamp."""
        return self.created_at

    def getUpdatedAt(self) -> datetime | None:
        """Get the updated timestamp."""
        return self.updated_at

    def getMetadata(self) -> dict:
        """Get the conversation metadata."""
        return self.metadata

    def setMetadata(self, metadata: dict) -> 'Conversation':
        """Set the conversation metadata."""
        self.metadata = metadata
        return self

    @staticmethod
    def fromHistory(history: list, user_id: str = None) -> 'Conversation':
        """Create from message history array."""
        conversation = Conversation(None, user_id)

        for msg in history:
            conversation.addMessage(Message.fromArray(msg))

        return conversation

    def toArray(self) -> dict:
        """Export to array."""
        return {
            'id': self.id,
            'user_id': self.user_id,
            'messages': self.getHistory(),
            'message_count': self.getMessageCount(),
            'created_at': self.created_at.isoformat(timespec='seconds'),
            'updated_at': self.updated_at.isoformat(timespec='seconds') if self.updated_at else None,
            'metadata': self.metadata,
        }
