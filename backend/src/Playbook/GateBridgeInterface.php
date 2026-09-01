<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Playbook;

/**
 * Presents a human gate (form / approval / handoff / await-message) to a
 * human and blocks the calling thread until it is answered or times out.
 * The immediate-mode GateManager calls this synchronously from inside the
 * interpreter loop.
 */
interface GateBridgeInterface
{
    /**
     * @param array $payload the gate's tool-call arguments (prompt/fields, approver/question, etc.)
     * @return ?array the decision payload the human gave, or null on timeout
     */
    public function ask(int $runId, string $kind, array $payload, int $timeoutMs): ?array;
}
