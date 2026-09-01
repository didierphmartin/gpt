<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit\Playbook;

use PDO;
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Playbook\Adapters\WorkflowLlmClient;

/**
 * Pins WorkflowLlmClient::flattenToolDefs — the nested OpenAI-style
 * {type:function, function:{name, description, parameters}} tool defs (the
 * shape PlaybookActionSpace/PlaybookNativeTools build) must convert to the
 * flat {name, description, input_schema} shape the rest of the AgentTeam
 * engine (MCPToolsLoader::getToolDefinitions, ParallelAgentExecutor,
 * OpenAIProvider/ClaudeProvider) expects. See the method's own docblock for
 * why passing the nested shape through verbatim breaks ClaudeProvider.
 */
final class WorkflowLlmClientTest extends TestCase
{
    private function invokeFlatten(array $toolDefs): array
    {
        $client = new WorkflowLlmClient([], [], new PDO('sqlite::memory:'));
        $method = new \ReflectionMethod(WorkflowLlmClient::class, 'flattenToolDefs');
        $method->setAccessible(true);
        return $method->invoke($client, $toolDefs);
    }

    public function testFlattensNestedFunctionShape(): void
    {
        $nested = [
            [
                'type' => 'function',
                'function' => [
                    'name' => 'leave_internal_note',
                    'description' => 'Leave an internal note on the run',
                    'parameters' => [
                        'type' => 'object',
                        'properties' => ['text' => ['type' => 'string']],
                        'required' => ['text'],
                    ],
                ],
            ],
        ];

        $flat = $this->invokeFlatten($nested);

        $this->assertSame([
            [
                'name' => 'leave_internal_note',
                'description' => 'Leave an internal note on the run',
                'input_schema' => [
                    'type' => 'object',
                    'properties' => ['text' => ['type' => 'string']],
                    'required' => ['text'],
                ],
            ],
        ], $flat);
    }

    public function testMissingFunctionFieldsDefaultSafely(): void
    {
        $nested = [
            ['type' => 'function', 'function' => ['name' => 'bare_tool']],
        ];

        $flat = $this->invokeFlatten($nested);

        $this->assertSame('bare_tool', $flat[0]['name']);
        $this->assertSame('', $flat[0]['description']);
        $this->assertSame(['type' => 'object', 'properties' => []], $flat[0]['input_schema']);
    }

    public function testAlreadyFlatDefsPassThroughUnchanged(): void
    {
        $alreadyFlat = [
            [
                'name' => 'okta__search_users',
                'description' => 'Search Okta users',
                'input_schema' => ['type' => 'object', 'properties' => ['email' => ['type' => 'string']]],
            ],
        ];

        $flat = $this->invokeFlatten($alreadyFlat);

        $this->assertSame($alreadyFlat, $flat);
    }
}
