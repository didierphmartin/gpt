<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Playbook\Adapters;

use AgentTeam\Services\SkillToolBridge;
use Quantis\AIPortfolioAssistant\Playbook\GateBridgeInterface;

/**
 * Wires GateManager's immediate-mode human gates (trigger_form /
 * request_approval / prompt_handoff / await_message) onto the existing
 * workflow client-tool bridge: emit a 'gate_request' SSE event carrying a
 * fresh tool_call_id, then block on SkillToolBridge::awaitResult() until the
 * browser posts a decision to the existing /api/v1/workflows/tool-result
 * endpoint (WorkflowController::toolResult() accepts any 32-hex tool_call_id
 * with no further validation — see that method, ~line 1003).
 */
final class SkillBridgeGateBridge implements GateBridgeInterface
{
    public function __construct(private readonly \Closure $emit)
    {
    }

    public function ask(int $runId, string $kind, array $payload, int $timeoutMs): ?array
    {
        $toolCallId = SkillToolBridge::generateToolCallId();

        ($this->emit)([
            'type' => 'gate_request',
            'tool_call_id' => $toolCallId,
            'kind' => $kind,
            'payload' => $payload,
            'run_id' => $runId,
        ]);

        return (new SkillToolBridge())->awaitResult($toolCallId, $timeoutMs);
    }
}
