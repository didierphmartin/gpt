<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use AgentTeam\Services\ADKGenerator;
use AgentTeam\Services\PackageDocs;
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Tests\Unit\Support\DispatcherDemoFixture;

/**
 * The README opens with what the workflow does (its Description, then its steps), and documents the private
 * settings of each MCP server it calls, by the nodes that use it. The editor sends those settings; a secret's
 * value never reaches the README.
 */
final class ReadmeAboutAndServerSettingsTest extends TestCase
{
    private const VARS = ['keys' => [], 'decision' => [], 'mcp' => [], 'model' => null];

    public function testTheReadmeOpensWithWhatTheWorkflowDoes(): void
    {
        $steps = [
            ['id' => '1', 'type' => 'start', 'name' => 'Start'],
            ['id' => '2', 'type' => 'code', 'name' => 'Wait for mail', 'provider' => '', 'model' => '', 'tools' => ['outlook.*']],
            ['id' => '3', 'type' => 'agent', 'name' => 'Triage', 'provider' => 'anthropic', 'model' => 'claude-sonnet-5-5',
                'tools' => [], 'dispatch' => ['Reply', 'Archive']],
            ['id' => '4', 'type' => 'output', 'name' => 'Output'],
        ];
        $md = implode("\n", PackageDocs::head('Mail triage', ['A LangGraph program.'], 'mail_triage', self::VARS,
            ['description' => "Sorts the VIP mail.\nReplies to the urgent ones.", 'steps' => $steps]));

        self::assertStringStartsWith("# Mail triage\n\n## What this workflow does\n\nSorts the VIP mail.\nReplies to the urgent ones.\n", $md);
        self::assertStringContainsString("1. **Wait for mail** -- code node; MCP servers: outlook.\n", $md);
        self::assertStringContainsString('2. **Triage** -- dispatcher; anthropic claude-sonnet-5-5; routes to one of: Reply, Archive.', $md);
        self::assertStringNotContainsString('**Start**', $md);
        // the folder's own explanation follows, then the usual sections
        self::assertLessThan(strpos($md, '## Requirements'), strpos($md, "## This folder\n\nA LangGraph program."));
        self::assertStringNotContainsString('## MCP server settings', $md);   // none sent: no section
    }

    public function testNoDescriptionSaysWhereToWriteOne(): void
    {
        $md = implode("\n", PackageDocs::about('  ', []));
        self::assertStringContainsString('Description field', $md);
    }

    public function testServerSettingsAreListedByServerWithTheNodesThatUseThem(): void
    {
        $servers = ADKGenerator::cleanServerSettings([
            ['name' => 'Outlook', 'nodes' => ['Wait for mail', 'Save PDF'], 'fields' => [
                ['name' => 'OUTLOOK_TENANT_ID', 'label' => 'Tenant | directory', 'required' => true, 'value' => 'contoso'],
                ['name' => 'OUTLOOK_CLIENT_SECRET', 'label' => 'Client secret', 'required' => true, 'secret' => true, 'value' => 'leak-me'],
                ['name' => 'OUTLOOK_DROP_DIR', 'value' => ''],
                ['name' => 'bad name', 'value' => 'x'],
            ]],
            ['name' => 'Fetch', 'nodes' => [], 'fields' => []],
            ['name' => '', 'fields' => []],
            'junk',
        ]);
        self::assertCount(2, $servers);
        self::assertSame('', $servers[0]['fields'][1]['value']);   // a secret's value is dropped on arrival

        $md = implode("\n", PackageDocs::head('W', [], 'w', self::VARS, ['servers' => $servers]));
        self::assertStringContainsString("## MCP server settings\n", $md);
        self::assertStringContainsString('**Server settings** tab', $md);
        self::assertStringContainsString("### Outlook\n\nUsed by: **Wait for mail**, **Save PDF**.", $md);
        self::assertStringContainsString('| `OUTLOOK_TENANT_ID` | Tenant \| directory | **yes** | `contoso` |', $md);
        self::assertStringContainsString('| `OUTLOOK_CLIENT_SECRET` | Client secret | **yes** | *secret: enter your own* |', $md);
        self::assertStringContainsString('| `OUTLOOK_DROP_DIR` |  | no | *not set yet* |', $md);
        self::assertStringNotContainsString('leak-me', $md);
        self::assertStringNotContainsString('bad name', $md);
        self::assertStringContainsString("### Fetch\n\nThis server declares no settings.", $md);
        // after Configure: the program's own .env comes first
        self::assertGreaterThan(strpos($md, '## Configure'), strpos($md, '## MCP server settings'));
    }

    /** The MCP servers are separate services: each one's address compiled in, how to move it, its connection key. */
    public function testMcpServersSaysEachAddressCanBeMovedWithoutACompile(): void
    {
        $vars = ['mcp' => ['http://localhost:8790/outlook_mcp/mcp' => 'outlook', 'http://h:9/sp|x' => 'sharepoint']] + self::VARS;
        $md = implode("\n", PackageDocs::head('W', [], 'w', $vars, ['servers' => [['name' => 'Outlook', 'nodes' => [], 'fields' => []]]]));

        self::assertStringContainsString("## MCP servers\n\nThe MCP servers are not part of this folder", $md);
        self::assertStringContainsString('| outlook | `http://localhost:8790/outlook_mcp/mcp` | `MCP_URL_OUTLOOK` | `MCP_HEADERS_OUTLOOK` |', $md);
        self::assertStringContainsString('| sharepoint | `http://h:9/sp\|x` | `MCP_URL_SHAREPOINT` | `MCP_HEADERS_SHAREPOINT` |', $md);
        self::assertStringContainsString('e.g. `MCP_URL_OUTLOOK=http://mcp.example.com:8790/mcp`', $md);
        self::assertStringContainsString('No' . "\n" . 'compile is needed', $md);
        // after Configure, before the servers' own settings
        self::assertGreaterThan(strpos($md, '## Configure'), strpos($md, '## MCP servers'));
        self::assertLessThan(strpos($md, '## MCP server settings'), strpos($md, '## MCP servers'));
        self::assertSame([], PackageDocs::mcpServers([]));   // no server: no section
    }

    /** Every target and layout: a real compile's README opens with the workflow's steps and carries the settings sent. */
    public function testEveryTargetsReadmeCarriesBothSections(): void
    {
        $sent = [['name' => 'Outlook', 'nodes' => ['Router'], 'fields' => [['name' => 'OUTLOOK_TENANT_ID', 'required' => true, 'value' => 't1']]]];
        $readmes = [];
        foreach (['LangGraphGenerator', 'ADKGenerator', 'MAFGenerator', 'NOOAGenerator'] as $class) {
            $gen = fn() => DispatcherDemoFixture::generator("AgentTeam\\Services\\{$class}", DispatcherDemoFixture::pdo())->withServerSettings($sent);
            $single = $gen()->generate(DispatcherDemoFixture::WORKFLOW_ID);
            $readmes["{$class} single"] = array_column($single['package_files'], 'code', 'path')['README.md'];
            $pkg = $class === 'LangGraphGenerator'
                ? $gen()->generate(DispatcherDemoFixture::WORKFLOW_ID, null, ['modular' => true])
                : $gen()->generatePackage(DispatcherDemoFixture::WORKFLOW_ID);
            $readmes["{$class} modular"] = array_column($pkg['files'], 'code', 'path')['README.md'];
        }
        foreach ($readmes as $what => $md) {
            self::assertMatchesRegularExpression('/^# .+\n\n## What this workflow does\n/', $md, $what);
            self::assertStringContainsString("From its Start node, it runs these steps in order:\n\n1. **", $md, $what);
            self::assertStringContainsString("### Outlook\n\nUsed by: **Router**.", $md, $what);
            self::assertStringContainsString('| `OUTLOOK_TENANT_ID` |  | **yes** | `t1` |', $md, $what);
        }
    }
}
