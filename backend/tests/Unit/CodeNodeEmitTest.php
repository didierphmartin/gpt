<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use AgentTeam\Services\CodeNodeEmit;
use PHPUnit\Framework\TestCase;

final class CodeNodeEmitTest extends TestCase
{
    private function node(array $cfg): array
    {
        return ['id' => '5', 'node_type' => 'code', 'config' => $cfg + ['type' => 'code', 'name' => 'Poll',
            'code' => "def run(i, c):\n    return {'route': 'job', 'output': 1}", 'exits' => ['job', 'no_job', 'error'],
            'mcp_tools' => ['servicenow.poll_jobs'], 'timeout_s' => 20]];
    }

    private const EDGES = [
        ['from' => '5', 'to' => '6', 'from_port' => 'output_1'],
        ['from' => '5', 'to' => '7', 'from_port' => 'output_2'],
        ['from' => '5', 'to' => '8', 'from_port' => 'output_1'],
        ['from' => '1', 'to' => '5', 'from_port' => 'output_1'],
    ];

    public function testNodeDataMapsPortsToExits(): void
    {
        $d = CodeNodeEmit::nodeData($this->node([]), self::EDGES, ['servicenow' => 'http://localhost/servicenow/']);
        self::assertSame('code', $d['kind']);
        self::assertSame(['job' => ['6', '8'], 'no_job' => ['7'], 'error' => []], $d['exit_targets']);
        self::assertSame(['http://localhost/servicenow/'], $d['servers']);
        self::assertSame(20, $d['timeout_s']);
        self::assertSame('Poll', $d['display']);
    }

    public function testDefaultsAndValidation(): void
    {
        $d = CodeNodeEmit::nodeData(['id' => '5', 'node_type' => 'code', 'config' => ['type' => 'code', 'code' => "def run(i, c):\n    return i"]], [], []);
        self::assertSame(['next'], $d['exits']);
        self::assertSame(30, $d['timeout_s']);
        foreach ([['exits' => ['Bad']], ['exits' => ['a', 'a']], ['exits' => []], ['mcp_tools' => ['servicenow']],
                  ['mcp_tools' => ['okta.reset']], ['timeout_s' => 0]] as $bad) {
            try {
                CodeNodeEmit::nodeData($this->node($bad), [], ['servicenow' => 'u']);
                self::fail('accepted ' . json_encode($bad));
            } catch (\RuntimeException $e) {
                self::assertStringContainsString("'Poll'", $e->getMessage());
            }
        }
    }

    public function testSlugAndRefusal(): void
    {
        self::assertSame('service_now_prod_', CodeNodeEmit::slug('Service Now (prod)'));
        $graph = ['nodes' => [$this->node([])], 'edges' => []];
        self::assertTrue(CodeNodeEmit::hasCodeNodes($graph));
        $this->expectExceptionMessage('Code nodes are not supported by the ADK target yet');
        CodeNodeEmit::refuseUnsupported($graph, 'ADK');
    }
}
