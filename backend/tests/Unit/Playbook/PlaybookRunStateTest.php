<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit\Playbook;

use Quantis\AIPortfolioAssistant\Playbook\{PlaybookDocument, PlaybookTranscript};

class PlaybookRunStateTest extends PlaybookDbTestCase
{

    private function doc(): PlaybookDocument
    {
        return PlaybookDocument::fromArray(['title' => 'T',
            'trigger' => ['kind' => 'request', 'description' => 'd'], 'instructions' => '#Resolve Request.']);
    }

    public function testCreateRunAndStatus(): void
    {
        $id = $this->state->createRun(1, $this->doc(), ['email' => 'low@test'], []);
        $this->assertSame('running', $this->state->getRun($id)['status']);
        $this->state->setStatus($id, 'resolved');
        $this->assertSame('resolved', $this->state->getRun($id)['status']);
    }

    public function testLedgerReplayGuard(): void
    {
        $id = $this->state->createRun(1, $this->doc(), [], []);
        $this->state->ledgerAppend($id, 0, '#Reset Password (Okta)', 'okta.reset_password',
            ['user_id' => 'u1', 'send_email' => true], 'ok', 'done');
        $hit = $this->state->ledgerFindOk($id, 'okta.reset_password', ['user_id' => 'u1', 'send_email' => true]);
        $this->assertNotNull($hit);
        $this->assertNull($this->state->ledgerFindOk($id, 'okta.reset_password', ['user_id' => 'OTHER']));
        $this->assertNull($this->state->ledgerFindOk($id + 1, 'okta.reset_password', ['user_id' => 'u1', 'send_email' => true]));
    }

    public function testSensitiveRedaction(): void
    {
        $id = $this->state->createRun(1, $this->doc(), [], []);
        $this->state->ledgerAppend($id, 0, '#Get Key', 'okta.get_key', ['secret' => 'ABC'], 'ok', 'key=ABC', true);
        $row = $this->state->ledgerAll($id)[0];
        $this->assertSame('"«redacted»"', $row['args']);
        $this->assertSame('«redacted»', $row['result_summary']);
    }

    public function testTranscriptRoundTrip(): void
    {
        $id = $this->state->createRun(1, $this->doc(), [], []);
        $t = new PlaybookTranscript($this->dir);
        $t->append($id, ['type' => 'leg_started', 'leg' => 0]);
        $t->append($id, ['type' => 'tool_call', 'tool' => 'okta.search_users']);
        $events = $t->read($id);
        $this->assertCount(2, $events);
        $this->assertSame('leg_started', $events[0]['type']);
        $this->assertArrayHasKey('ts', $events[0]);
    }
}
