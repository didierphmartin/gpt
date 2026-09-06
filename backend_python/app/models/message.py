"""Message model."""
from datetime import datetime, timezone
from app.support.phpcompat import php_uniqid


class Message:
    """Represents a message in a conversation."""

    ROLE_USER = 'user'
    ROLE_ASSISTANT = 'assistant'
    ROLE_SYSTEM = 'system'

    def __init__(
        self,
        role: str,
        content: str,
        id: str = None,
        created_at: datetime = None,
        metadata: dict = None,
    ):
        """Initialize a message."""
        self.role = role
        self.content = content
        self.id = id or php_uniqid('msg_')
        self.created_at = created_at or datetime.now(timezone.utc)
        self.metadata = metadata or {}

    @staticmethod
    def user(content: str, metadata: dict = None) -> 'Message':
        """Create a user message."""
        return Message(Message.ROLE_USER, content, None, None, metadata)

    @staticmethod
    def assistant(content: str, metadata: dict = None) -> 'Message':
        """Create an assistant message."""
        return Message(Message.ROLE_ASSISTANT, content, None, None, metadata)

    @staticmethod
    def system(content: str) -> 'Message':
        """Create a system message."""
        return Message(Message.ROLE_SYSTEM, content)

    @staticmethod
    def fromArray(data: dict) -> 'Message':
        """Create from array. Mirrors PHP ?? operator (None is replaced by default)."""
        created_at = None
        if 'created_at' in data and data['created_at'] is not None:
            # Parse ISO format datetime
            created_at_str = data['created_at']
            if isinstance(created_at_str, str):
                # Handle ISO 8601 format
                if created_at_str.endswith('Z'):
                    created_at = datetime.fromisoformat(created_at_str[:-1] + '+00:00')
                else:
                    created_at = datetime.fromisoformat(created_at_str)
            else:
                created_at = created_at_str

        # PHP ?? operator: substitute if key absent OR value is None
        role = data.get('role')
        role = Message.ROLE_USER if role is None else role

        content = data.get('content')
        content = '' if content is None else content

        id_val = data.get('id')
        id_val = None if id_val is None else id_val

        metadata = data.get('metadata')
        metadata = {} if metadata is None else metadata

        return Message(
            role,
            content,
            id_val,
            created_at,
            metadata,
        )

    def getRole(self) -> str:
        """Get the message role."""
        return self.role

    def getContent(self) -> str:
        """Get the message content."""
        return self.content

    def getId(self) -> str:
        """Get the message ID."""
        return self.id

    def getCreatedAt(self) -> datetime:
        """Get the created timestamp."""
        return self.created_at

    def getMetadata(self) -> dict:
        """Get the message metadata."""
        return self.metadata

    def isUser(self) -> bool:
        """Check if this is a user message."""
        return self.role == self.ROLE_USER

    def isAssistant(self) -> bool:
        """Check if this is an assistant message."""
        return self.role == self.ROLE_ASSISTANT

    def toArray(self) -> dict:
        """Convert to array for API."""
        return {
            'role': self.role,
            'content': self.content,
        }

    def toClaudeFormat(self) -> dict:
        """Convert to Claude API format."""
        return {
            'role': self.role,
            'content': [
                {'type': 'text', 'text': self.content}
            ],
        }
