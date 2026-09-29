<?php
declare(strict_types=1);

use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Services\JevUsage;
use Quantis\AIPortfolioAssistant\Services\UsageLogger;

final class JevUsageTest extends TestCase
{
    private function answered(string $outcome = 'routed'): array
    {
        return ['outcome' => $outcome, 'target' => null, 'confidence' => 0.9, 'ms' => 212,
                'usage' => ['input_tokens' => 342, 'output_tokens' => 39], 'reason' => $outcome === 'error' ? 'no choice in the response' : null];
    }

    public function testTransactionPayload(): void
    {
        $t = JevUsage::transaction(7, $this->answered());
        $this->assertSame(7, $t['user_id']);
        $this->assertSame('jev', $t['provider']);
        $this->assertSame('jev-latest', $t['model']);
        $this->assertSame(342, $t['prompt_tokens']);
        $this->assertSame(39, $t['completion_tokens']);
        $this->assertSame(212, $t['response_time_ms']);
        $this->assertSame('success', $t['status']);
        $this->assertNull($t['error_message']);
        $this->assertSame(['jev_outcome' => 'routed'], $t['request_metadata']);
    }

    public function testUnclearAndLowConfidenceAreSuccessfulCalls(): void
    {
        $this->assertSame('success', JevUsage::transaction(7, $this->answered('unclear'))['status']);
        $this->assertSame('success', JevUsage::transaction(7, $this->answered('low_confidence'))['status']);
    }

    public function testAnAnsweredErrorIsRecordedAsError(): void
    {
        $t = JevUsage::transaction(7, $this->answered('error'));
        $this->assertSame('error', $t['status']);
        $this->assertSame('no choice in the response', $t['error_message']);
    }

    public function testACallThatWasNeverSentIsNotRecorded(): void
    {
        $logger = $this->createMock(UsageLogger::class);
        $logger->expects($this->never())->method('logTransaction');
        JevUsage::record($logger, 7, ['outcome' => 'unavailable', 'ms' => null, 'usage' => [], 'reason' => 'no Jev key']);
        JevUsage::record($logger, 7, ['outcome' => 'error', 'ms' => null, 'usage' => [], 'reason' => 'a menu needs at least two targets']);
    }

    public function testNoUserNoRecord(): void
    {
        $logger = $this->createMock(UsageLogger::class);
        $logger->expects($this->never())->method('logTransaction');
        JevUsage::record($logger, null, $this->answered());
    }

    public function testAnsweredCallIsRecordedOnce(): void
    {
        $logger = $this->createMock(UsageLogger::class);
        $logger->expects($this->once())->method('logTransaction')
            ->with($this->callback(fn(array $t) => $t['provider'] === 'jev' && $t['prompt_tokens'] === 342))
            ->willReturn(1);
        JevUsage::record($logger, 7, $this->answered());
    }

    public function testALoggerFailureNeverThrows(): void
    {
        $logger = $this->createMock(UsageLogger::class);
        $logger->method('logTransaction')->willThrowException(new RuntimeException('db down'));
        JevUsage::record($logger, 7, $this->answered());
        $this->assertTrue(true);
    }
}
