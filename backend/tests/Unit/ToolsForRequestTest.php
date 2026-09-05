<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\AIPortfolioAssistant;

/**
 * The tool list handed to a provider: base tools + caller tools by default
 * (conversation), caller tools only under a skill turn, and — for workflow
 * nodes — EXACTLY the node's allow-list (tools_filter), [] meaning none.
 * The provider prefers options['tools'] over its executor, so this merge
 * is where a filter has to be enforced.
 */
class ToolsForRequestTest extends TestCase
{
    private array $base = [['name' => 'serpapi_search'], ['name' => 'search_assets']];
    private array $extra = [['name' => 'mcp_lookup_users'], ['name' => 'mcp_pin_message']];

    public function testDefaultMergesBaseAndCallerTools(): void
    {
        $this->assertSame(['serpapi_search', 'search_assets', 'mcp_lookup_users', 'mcp_pin_message'],
            array_column(AIPortfolioAssistant::resolveToolsForRequest($this->base, $this->extra, []), 'name'));
    }

    public function testSkillTurnKeepsCallerToolsOnly(): void
    {
        $this->assertSame(['mcp_lookup_users', 'mcp_pin_message'],
            array_column(AIPortfolioAssistant::resolveToolsForRequest($this->base, $this->extra, ['skill_metadata' => ['dir_name' => 'x']]), 'name'));
    }

    public function testEmptyFilterYieldsNoTools(): void
    {
        $this->assertSame([], AIPortfolioAssistant::resolveToolsForRequest($this->base, $this->extra, ['tools_filter' => []]));
    }

    public function testFilterKeepsOnlyNamedToolsFromBothSets(): void
    {
        $this->assertSame(['search_assets', 'mcp_pin_message'],
            array_column(AIPortfolioAssistant::resolveToolsForRequest($this->base, $this->extra, ['tools_filter' => ['mcp_pin_message', 'search_assets']]), 'name'));
    }
}
