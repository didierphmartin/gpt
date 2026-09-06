from app.models.conversation import Conversation
from app.models.message import Message


def test_conversation_history_and_array():
    c = Conversation(None, '3', {'m': 1})
    c.addUserMessage('hi').addAssistantMessage('yo', {'provider': 'claude'})
    assert c.getHistory() == [{'role': 'user', 'content': 'hi'}, {'role': 'assistant', 'content': 'yo'}]
    assert c.getMessageCount() == 2 and c.getId().startswith('conv_') and c.getLastMessage().isAssistant()
    d = c.toArray()
    assert d['user_id'] == '3' and d['message_count'] == 2 and d['metadata'] == {'m': 1} and d['updated_at']
    assert Message.fromArray({'role': 'system', 'content': 's'}).toClaudeFormat() == {'role': 'system', 'content': [{'type': 'text', 'text': 's'}]}
    assert len(Conversation.fromHistory([{'role': 'user', 'content': 'a'}]).getMessages()) == 1
