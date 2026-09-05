<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit\Playbook;

use PHPUnit\Framework\TestCase;
use AgentTeam\Services\PlaybookNodeRunner;

/**
 * A playbook node hands the NEXT node the same story the run overlay shows:
 * tool calls with their outcome, the messages the playbook sent, the human
 * gates with their decision, and the final result/status — not just the
 * interpreter's last sentence.
 */
class PlaybookTranscriptTextTest extends TestCase
{
    public function testTranscriptMirrorsTheOverlay(): void
    {
        $events = [
            ['type' => 'round', 'round' => 1],
            ['type' => 'tool_call', 'name' => 'okta__lookup_users', 'args' => ['email' => 'a@b']],
            ['type' => 'tool_result', 'name' => 'okta__lookup_users', 'result' => ['ok' => true, 'id' => 'u-1']],
            ['type' => 'gate_request', 'kind' => 'approval', 'payload' => ['question' => 'Approve PTO for Didier?', 'context' => '5 days']],
            // GateManager wraps the whole answer under 'decision' — the renderer must unwrap it.
            ['type' => 'tool_result', 'name' => 'request_approval', 'result' => ['ok' => true, 'decision' => ['tool_call_id' => 'x', 'decision' => 'approved', 'comment' => 'fine', 'actor' => 'me']]],
            ['type' => 'message', 'text' => "Hi Marcus,\nApproved."],
            ['type' => 'message', 'text' => 'secret', 'sensitive' => true],
            ['type' => 'tool_call', 'name' => 'workday__submit_time_off', 'args' => []],
            ['type' => 'tool_result', 'name' => 'workday__submit_time_off', 'result' => ['ok' => false, 'error' => 'boom']],
            ['type' => 'final', 'leg' => 0, 'status' => 'resolved'],
        ];
        $t = PlaybookNodeRunner::renderTranscript('Time Off & Leave Requests', $events, 'Request TO-1 submitted.', 41, 'resolved');

        $this->assertStringContainsString('# Playbook: Time Off & Leave Requests', $t);
        $this->assertStringContainsString('run 41', $t);
        $this->assertStringContainsString('okta__lookup_users ✓', $t);
        $this->assertStringContainsString('workday__submit_time_off ✗', $t);
        $this->assertStringContainsString('Approval requested: Approve PTO for Didier?', $t);
        $this->assertStringContainsString('→ approved (fine)', $t);
        $this->assertStringNotContainsString('tool_call_id', $t);
        $this->assertStringContainsString("Hi Marcus,\n  Approved.", $t); // message body indented under its bullet
        $this->assertStringNotContainsString('secret', $t);
        $this->assertStringContainsString('(message redacted)', $t);
        $this->assertStringContainsString('Request TO-1 submitted.', $t);
        $this->assertStringContainsString('resolved', $t);
        // chronological: lookup before approval before submit
        $this->assertLessThan(strpos($t, 'Approval requested'), strpos($t, 'okta__lookup_users'));
        $this->assertLessThan(strpos($t, 'workday__submit_time_off'), strpos($t, 'Approval requested'));
    }
}
