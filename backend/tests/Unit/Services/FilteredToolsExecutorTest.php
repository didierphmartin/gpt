<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit\Services;

use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Contracts\FunctionExecutorInterface;
use Quantis\AIPortfolioAssistant\Services\FilteredToolsExecutor;

/**
 * A workflow node's tool selection is an EXACT allow-list: an empty list
 * means "no tools", null means "no filter" (conversation mode). Sending all
 * 113 tools to a node that selected none cost ~15k tokens per call.
 */
class FilteredToolsExecutorTest extends TestCase
{
    private function base(): FunctionExecutorInterface
    {
        return new class implements FunctionExecutorInterface {
            public function execute(string $functionName, array $parameters, mixed $context = null): array { return []; }
            public function hasFunction(string $functionName): bool { return true; }
            public function getRegisteredFunctions(): array { return ['a', 'mcp_b', 'c']; }
            public function getToolDefinitions(): array { return [['name' => 'a'], ['name' => 'mcp_b'], ['name' => 'c']]; }
            public function registerFunction(string $name, callable $handler, array $schema): self { return $this; }
            public function isMCPTool(string $functionName): bool { return str_starts_with($functionName, 'mcp_'); }
        };
    }

    public function testEmptyAllowListYieldsNoTools(): void
    {
        $ex = (new FilteredToolsExecutor($this->base()))->setAllowedTools([]);
        $this->assertTrue($ex->isFiltering());
        $this->assertSame([], $ex->getToolDefinitions());
    }

    public function testNullAllowListYieldsAllTools(): void
    {
        $ex = (new FilteredToolsExecutor($this->base()))->setAllowedTools(null);
        $this->assertFalse($ex->isFiltering());
        $this->assertCount(3, $ex->getToolDefinitions());
    }

    public function testAllowListKeepsOnlyNamedTools(): void
    {
        $ex = (new FilteredToolsExecutor($this->base()))->setAllowedTools(['mcp_b']);
        $this->assertSame([['name' => 'mcp_b']], $ex->getToolDefinitions());
    }
}
