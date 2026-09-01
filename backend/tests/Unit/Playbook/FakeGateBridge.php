<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit\Playbook;

use Quantis\AIPortfolioAssistant\Playbook\GateBridgeInterface;

final class FakeGateBridge implements GateBridgeInterface
{
    /** @var array<int,array{runId:int,kind:string,payload:array,timeoutMs:int}> */
    public array $calls = [];

    /** @param array<int,?array> $queue queued answers, in order; null entries mean timeout. Exhausted queue also times out. */
    public function __construct(
        private array $queue = [],
        private readonly ?\Closure $onAsk = null,
    ) {}

    public function ask(int $runId, string $kind, array $payload, int $timeoutMs): ?array
    {
        $this->calls[] = ['runId' => $runId, 'kind' => $kind, 'payload' => $payload, 'timeoutMs' => $timeoutMs];
        if ($this->onAsk !== null) {
            ($this->onAsk)($runId, $kind, $payload);
        }
        if (empty($this->queue)) {
            return null;
        }
        return array_shift($this->queue);
    }
}
