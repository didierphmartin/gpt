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


def test_message_fromArray_php_null_coalesce():
    """PHP ?? operator: None or missing key both substitute default."""
    # role is None → defaults to 'user'
    m = Message.fromArray({'role': None, 'content': 'text'})
    assert m.getRole() == 'user'

    # content is None → defaults to ''
    m = Message.fromArray({'role': 'assistant', 'content': None})
    assert m.getContent() == ''

    # Both None
    m = Message.fromArray({'role': None, 'content': None})
    assert m.getRole() == 'user' and m.getContent() == ''

    # metadata None
    m = Message.fromArray({'role': 'user', 'content': 'text', 'metadata': None})
    assert m.getMetadata() == {}


def test_getLastMessages_array_slice_semantics():
    """PHP array_slice($messages, -$count) semantics."""
    c = Conversation()
    c.addUserMessage('msg1')
    c.addUserMessage('msg2')
    c.addUserMessage('msg3')
    c.addUserMessage('msg4')
    c.addUserMessage('msg5')

    # count 3 → last three
    last_three = c.getLastMessages(3)
    assert len(last_three) == 3
    assert last_three[0].getContent() == 'msg3'
    assert last_three[2].getContent() == 'msg5'

    # count 0 → the whole list
    all_msgs = c.getLastMessages(0)
    assert len(all_msgs) == 5

    # count -2 → everything from index 2 onwards
    from_two = c.getLastMessages(-2)
    assert len(from_two) == 3
    assert from_two[0].getContent() == 'msg3'
    assert from_two[2].getContent() == 'msg5'
