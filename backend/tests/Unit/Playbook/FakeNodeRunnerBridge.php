<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit\Playbook;

use Quantis\AIPortfolioAssistant\Playbook\GateBridgeInterface;

/**
 * Stand-in for SkillBridgeGateBridge in PlaybookNodeRunnerTest: mirrors the
 * real adapter's contract (emit a 'gate_request' event, then hand back a
 * decision) without touching SkillToolBridge's filesystem rendezvous, so the
 * unit test resolves synchronously instead of polling for a result file.
 */
final class FakeNodeRunnerBridge implements GateBridgeInterface
{
    /** @var array<int,array{runId:int,kind:string,payload:array}> */
    public array $calls = [];

    public function __construct(
        private readonly \Closure $emit,
        private readonly ?array $answer = ['actor' => 'approver1', 'decision' => 'approved'],
    ) {}

    public function ask(int $runId, string $kind, array $payload, int $timeoutMs): ?array
    {
        $toolCallId = bin2hex(random_bytes(16));
        $this->calls[] = ['runId' => $runId, 'kind' => $kind, 'payload' => $payload];
        ($this->emit)([
            'type' => 'gate_request',
            'tool_call_id' => $toolCallId,
            'kind' => $kind,
            'payload' => $payload,
            'run_id' => $runId,
        ]);
        return $this->answer;
    }
}
