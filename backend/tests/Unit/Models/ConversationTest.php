<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit\Models;

use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Models\Conversation;
use Quantis\AIPortfolioAssistant\Models\Message;

class ConversationTest extends TestCase
{
    public function testCanCreateConversation(): void
    {
        $conversation = new Conversation();

        $this->assertStringStartsWith('conv_', $conversation->getId());
        $this->assertNull($conversation->getUserId());
        $this->assertEquals(0, $conversation->getMessageCount());
    }

    public function testCanCreateWithUserId(): void
    {
        $conversation = new Conversation(null, 'user-123');

        $this->assertEquals('user-123', $conversation->getUserId());
    }

    public function testCanCreateWithCustomId(): void
    {
        $conversation = new Conversation('custom-conv-id');

        $this->assertEquals('custom-conv-id', $conversation->getId());
    }

    public function testCanAddMessage(): void
    {
        $conversation = new Conversation();
        $message = Message::user('Hello');

        $conversation->addMessage($message);

        $this->assertEquals(1, $conversation->getMessageCount());
        $this->assertSame($message, $conversation->getLastMessage());
    }

    public function testCanAddUserMessage(): void
    {
        $conversation = new Conversation();
        $conversation->addUserMessage('Hello');

        $messages = $conversation->getMessages();
        $this->assertCount(1, $messages);
        $this->assertTrue($messages[0]->isUser());
        $this->assertEquals('Hello', $messages[0]->getContent());
    }

    public function testCanAddAssistantMessage(): void
    {
        $conversation = new Conversation();
        $conversation->addAssistantMessage('Hi there!', ['tokens' => 10]);

        $messages = $conversation->getMessages();
        $this->assertCount(1, $messages);
        $this->assertTrue($messages[0]->isAssistant());
        $this->assertEquals(['tokens' => 10], $messages[0]->getMetadata());
    }

    public function testGetHistory(): void
    {
        $conversation = new Conversation();
        $conversation->addUserMessage('Hello');
        $conversation->addAssistantMessage('Hi!');

        $history = $conversation->getHistory();

        $this->assertCount(2, $history);
        $this->assertEquals(['role' => 'user', 'content' => 'Hello'], $history[0]);
        $this->assertEquals(['role' => 'assistant', 'content' => 'Hi!'], $history[1]);
    }

    public function testGetLastMessages(): void
    {
        $conversation = new Conversation();
        $conversation->addUserMessage('Message 1');
        $conversation->addAssistantMessage('Response 1');
        $conversation->addUserMessage('Message 2');
        $conversation->addAssistantMessage('Response 2');

        $lastTwo = $conversation->getLastMessages(2);

        $this->assertCount(2, $lastTwo);
        $this->assertEquals('Message 2', $lastTwo[0]->getContent());
        $this->assertEquals('Response 2', $lastTwo[1]->getContent());
    }

    public function testGetLastMessageReturnsNullWhenEmpty(): void
    {
        $conversation = new Conversation();

        $this->assertNull($conversation->getLastMessage());
    }

    public function testClear(): void
    {
        $conversation = new Conversation();
        $conversation->addUserMessage('Hello');
        $conversation->addAssistantMessage('Hi!');

        $conversation->clear();

        $this->assertEquals(0, $conversation->getMessageCount());
        $this->assertEmpty($conversation->getMessages());
    }

    public function testUpdatedAtChangesOnAddMessage(): void
    {
        $conversation = new Conversation();
        $this->assertNull($conversation->getUpdatedAt());

        $conversation->addUserMessage('Hello');

        $this->assertNotNull($conversation->getUpdatedAt());
    }

    public function testMetadata(): void
    {
        $conversation = new Conversation(null, null, ['topic' => 'portfolio']);

        $this->assertEquals(['topic' => 'portfolio'], $conversation->getMetadata());

        $conversation->setMetadata(['topic' => 'stocks']);
        $this->assertEquals(['topic' => 'stocks'], $conversation->getMetadata());
    }

    public function testFromHistory(): void
    {
        $history = [
            ['role' => 'user', 'content' => 'Hello'],
            ['role' => 'assistant', 'content' => 'Hi there!'],
        ];

        $conversation = Conversation::fromHistory($history, 'user-456');

        $this->assertEquals('user-456', $conversation->getUserId());
        $this->assertEquals(2, $conversation->getMessageCount());
    }

    public function testToArray(): void
    {
        $conversation = new Conversation('test-id', 'user-123');
        $conversation->addUserMessage('Hello');

        $array = $conversation->toArray();

        $this->assertEquals('test-id', $array['id']);
        $this->assertEquals('user-123', $array['user_id']);
        $this->assertEquals(1, $array['message_count']);
        $this->assertArrayHasKey('messages', $array);
        $this->assertArrayHasKey('created_at', $array);
    }

    public function testCreatedAtIsImmutable(): void
    {
        $conversation = new Conversation();

        $this->assertInstanceOf(\DateTimeImmutable::class, $conversation->getCreatedAt());
    }
}
