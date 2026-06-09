<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit\Models;

use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Models\Message;

class MessageTest extends TestCase
{
    public function testCanCreateUserMessage(): void
    {
        $message = Message::user('Hello, how are you?');

        $this->assertEquals('user', $message->getRole());
        $this->assertEquals('Hello, how are you?', $message->getContent());
        $this->assertTrue($message->isUser());
        $this->assertFalse($message->isAssistant());
    }

    public function testCanCreateAssistantMessage(): void
    {
        $message = Message::assistant('I am doing well, thank you!');

        $this->assertEquals('assistant', $message->getRole());
        $this->assertEquals('I am doing well, thank you!', $message->getContent());
        $this->assertTrue($message->isAssistant());
        $this->assertFalse($message->isUser());
    }

    public function testCanCreateSystemMessage(): void
    {
        $message = Message::system('You are a helpful assistant.');

        $this->assertEquals('system', $message->getRole());
        $this->assertEquals('You are a helpful assistant.', $message->getContent());
    }

    public function testMessageHasId(): void
    {
        $message = Message::user('Test');

        $this->assertStringStartsWith('msg_', $message->getId());
    }

    public function testMessageHasCreatedAt(): void
    {
        $message = Message::user('Test');

        $this->assertInstanceOf(\DateTimeImmutable::class, $message->getCreatedAt());
    }

    public function testCanCreateWithMetadata(): void
    {
        $metadata = ['tokens' => 100, 'model' => 'claude'];
        $message = Message::assistant('Response', $metadata);

        $this->assertEquals($metadata, $message->getMetadata());
    }

    public function testToArray(): void
    {
        $message = Message::user('Hello');
        $array = $message->toArray();

        $this->assertEquals(['role' => 'user', 'content' => 'Hello'], $array);
    }

    public function testToClaudeFormat(): void
    {
        $message = Message::user('Hello');
        $format = $message->toClaudeFormat();

        $this->assertEquals('user', $format['role']);
        $this->assertIsArray($format['content']);
        $this->assertEquals('text', $format['content'][0]['type']);
        $this->assertEquals('Hello', $format['content'][0]['text']);
    }

    public function testFromArray(): void
    {
        $data = [
            'role' => 'assistant',
            'content' => 'Test content',
            'id' => 'custom-id',
            'metadata' => ['key' => 'value'],
        ];

        $message = Message::fromArray($data);

        $this->assertEquals('assistant', $message->getRole());
        $this->assertEquals('Test content', $message->getContent());
        $this->assertEquals('custom-id', $message->getId());
        $this->assertEquals(['key' => 'value'], $message->getMetadata());
    }

    public function testFromArrayWithDefaults(): void
    {
        $data = ['content' => 'Just content'];

        $message = Message::fromArray($data);

        $this->assertEquals('user', $message->getRole()); // Default role
        $this->assertEquals('Just content', $message->getContent());
    }
}
