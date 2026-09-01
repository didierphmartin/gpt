<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit\Playbook;

use Quantis\AIPortfolioAssistant\Playbook\{PlaybookDocument, PlaybookNativeTools};

class PlaybookNativeToolsTest extends PlaybookDbTestCase
{
    private PlaybookNativeTools $tools;

    protected function setUp(): void
    {
        parent::setUp();
        $this->tools = new PlaybookNativeTools($this->state);
    }

    private function doc(): PlaybookDocument
    {
        return PlaybookDocument::fromArray(['title' => 'T',
            'trigger' => ['kind' => 'request', 'description' => 'd'], 'instructions' => '#Resolve Request.']);
    }

    public function testDefinitionsStructure(): void
    {
        $defs = $this->tools->definitions();
        $this->assertCount(6, $defs);
        foreach ($defs as $def) {
            $this->assertIsArray($def);
            $this->assertArrayHasKey('type', $def);
            $this->assertSame('function', $def['type']);
            $this->assertArrayHasKey('function', $def);
            $this->assertArrayHasKey('name', $def['function']);
            $this->assertArrayHasKey('parameters', $def['function']);
            $this->assertSame('object', $def['function']['parameters']['type']);
        }
    }

    public function testDefinitionNames(): void
    {
        $defs = $this->tools->definitions();
        $names = array_map(fn($d) => $d['function']['name'], $defs);
        $this->assertContains('send_direct_message', $names);
        $this->assertContains('send_channel_message', $names);
        $this->assertContains('send_email', $names);
        $this->assertContains('leave_internal_note', $names);
        $this->assertContains('set_priority', $names);
        $this->assertContains('resolve_request', $names);
    }

    public function testSendDirectMessage(): void
    {
        $id = $this->state->createRun(1, $this->doc(), ['email' => 'user@test'], []);
        $result = $this->tools->execute($id, 0, 'send_direct_message', ['text' => 'Hello user']);
        $this->assertArrayHasKey('ok', $result);
        $this->assertTrue($result['ok']);

        $stmt = $this->pdo->prepare('SELECT * FROM playbook_run_messages WHERE run_id = ?');
        $stmt->execute([$id]);
        $messages = $stmt->fetchAll(\PDO::FETCH_ASSOC);
        $this->assertCount(1, $messages);
        $this->assertSame('to_requester', $messages[0]['direction']);
        $this->assertNull($messages[0]['audience']);
        $this->assertSame('Hello user', $messages[0]['text']);
        $this->assertSame(0, (int)$messages[0]['sensitive']);
    }

    public function testSendDirectMessageWithSensitive(): void
    {
        $id = $this->state->createRun(1, $this->doc(), ['email' => 'user@test'], []);
        $result = $this->tools->execute($id, 0, 'send_direct_message', [
            'text' => 'Secret password',
            'sensitive' => true
        ]);
        $this->assertArrayHasKey('ok', $result);
        $this->assertTrue($result['ok']);

        $stmt = $this->pdo->prepare('SELECT * FROM playbook_run_messages WHERE run_id = ?');
        $stmt->execute([$id]);
        $messages = $stmt->fetchAll(\PDO::FETCH_ASSOC);
        $this->assertCount(1, $messages);
        $this->assertSame('to_requester', $messages[0]['direction']);
        $this->assertSame('«redacted»', $messages[0]['text']);
        $this->assertSame(1, (int)$messages[0]['sensitive']);
    }

    public function testSendChannelMessage(): void
    {
        $id = $this->state->createRun(1, $this->doc(), [], []);
        $result = $this->tools->execute($id, 0, 'send_channel_message', [
            'channel' => 'general',
            'text' => 'Channel message'
        ]);
        $this->assertArrayHasKey('ok', $result);
        $this->assertTrue($result['ok']);

        $stmt = $this->pdo->prepare('SELECT * FROM playbook_run_messages WHERE run_id = ?');
        $stmt->execute([$id]);
        $messages = $stmt->fetchAll(\PDO::FETCH_ASSOC);
        $this->assertCount(1, $messages);
        $this->assertSame('to_channel', $messages[0]['direction']);
        $this->assertSame('general', $messages[0]['audience']);
        $this->assertSame('Channel message', $messages[0]['text']);
    }

    public function testSendEmail(): void
    {
        $id = $this->state->createRun(1, $this->doc(), [], []);
        $result = $this->tools->execute($id, 0, 'send_email', [
            'to' => 'user@example.com',
            'subject' => 'Test',
            'text' => 'Email body'
        ]);
        $this->assertArrayHasKey('ok', $result);
        $this->assertTrue($result['ok']);

        $stmt = $this->pdo->prepare('SELECT * FROM playbook_run_messages WHERE run_id = ?');
        $stmt->execute([$id]);
        $messages = $stmt->fetchAll(\PDO::FETCH_ASSOC);
        $this->assertCount(1, $messages);
        $this->assertSame('to_email', $messages[0]['direction']);
        $this->assertSame('user@example.com', $messages[0]['audience']);
        $this->assertSame('Email body', $messages[0]['text']);
    }

    public function testLeaveInternalNote(): void
    {
        $id = $this->state->createRun(1, $this->doc(), [], []);
        $result = $this->tools->execute($id, 0, 'leave_internal_note', ['text' => 'Internal note']);
        $this->assertArrayHasKey('ok', $result);
        $this->assertTrue($result['ok']);

        // Verify note was added
        $stmt = $this->pdo->prepare('SELECT * FROM playbook_run_notes WHERE run_id = ?');
        $stmt->execute([$id]);
        $notes = $stmt->fetchAll(\PDO::FETCH_ASSOC);
        $this->assertCount(1, $notes);
        $this->assertSame('Internal note', $notes[0]['text']);
        $this->assertSame('agent', $notes[0]['author']);
    }

    public function testSetPriority(): void
    {
        $id = $this->state->createRun(1, $this->doc(), [], []);
        $result = $this->tools->execute($id, 0, 'set_priority', [
            'priority' => 'high',
            'reason' => 'Critical issue'
        ]);
        $this->assertArrayHasKey('ok', $result);
        $this->assertTrue($result['ok']);

        // Verify note was added with priority information
        $stmt = $this->pdo->prepare('SELECT * FROM playbook_run_notes WHERE run_id = ?');
        $stmt->execute([$id]);
        $notes = $stmt->fetchAll(\PDO::FETCH_ASSOC);
        $this->assertCount(1, $notes);
        $this->assertStringContainsString('priority', $notes[0]['text']);
        $this->assertStringContainsString('high', $notes[0]['text']);
        $this->assertStringContainsString('Critical issue', $notes[0]['text']);
    }

    public function testResolveRequest(): void
    {
        $id = $this->state->createRun(1, $this->doc(), [], []);
        $result = $this->tools->execute($id, 0, 'resolve_request', [
            'outcome' => 'success',
            'summary' => 'Resolved successfully'
        ]);
        $this->assertArrayHasKey('ok', $result);
        $this->assertTrue($result['ok']);
        $this->assertArrayHasKey('terminal', $result);
        $this->assertTrue($result['terminal']);

        // Verify status was changed
        $run = $this->state->getRun($id);
        $this->assertSame('resolved', $run['status']);
    }

    public function testUnknownTool(): void
    {
        $id = $this->state->createRun(1, $this->doc(), [], []);
        $result = $this->tools->execute($id, 0, 'unknown_tool', []);
        $this->assertArrayHasKey('ok', $result);
        $this->assertFalse($result['ok']);
        $this->assertArrayHasKey('error', $result);
    }
}
