<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use AgentTeam\Models\Workflow;
use AgentTeam\Services\AgentRepository;
use AgentTeam\Services\LangGraphGenerator;
use AgentTeam\Services\StartOptionGraph;
use AgentTeam\Services\WorkflowGraphRepository;
use AgentTeam\Services\WorkflowRepository;
use PHPUnit\Framework\TestCase;

/** spec 2026-10-15 langgraph standalone §2: the Start decides the default mode. */
final class LangGraphStartModeTest extends TestCase
{
    private function pdo(?string $cron = null, bool $paused = false): \PDO
    {
        $pdo = new \PDO('sqlite::memory:');
        $pdo->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
        $pdo->exec('CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY, user_id TEXT, name TEXT, url TEXT, enabled INTEGER)');
        $pdo->exec('CREATE TABLE mcp_server_tools (id INTEGER PRIMARY KEY, server_id INTEGER, tool_name TEXT, description TEXT, input_schema TEXT)');
        $pdo->exec('CREATE TABLE system_llm_settings (provider_key TEXT, model TEXT, enabled INTEGER)');
        $pdo->exec('CREATE TABLE scheduled_workflows (id INTEGER PRIMARY KEY, workflow_id INTEGER, repeat_type TEXT, cron TEXT, status TEXT, event_trigger TEXT)');
        $pdo->exec("INSERT INTO mcp_servers VALUES (7, '3', 'Outlook', 'http://127.0.0.1:8770/mcp', 1)");
        $pdo->exec("INSERT INTO mcp_server_tools VALUES (1, 7, 'poll_new_mail', 'Poll', '{}')");
        $pdo->exec("INSERT INTO mcp_server_tools VALUES (2, 7, 'wait_for_new', 'Wait', '{}')");
        if ($cron !== null) {
            $pdo->exec("INSERT INTO scheduled_workflows VALUES (1, 44, 'cron', '{$cron}', '" . ($paused ? 'paused' : 'pending') . "', NULL)");
        }
        return $pdo;
    }

    private function generate(array $graph, array $options = [], ?\PDO $pdo = null): array
    {
        $wfRepo = $this->createMock(WorkflowRepository::class);
        $wfRepo->method('findById')->willReturn(new Workflow(['id' => 44, 'name' => 'Email prototype', 'user_id' => '3']));
        $graphRepo = $this->createMock(WorkflowGraphRepository::class);
        $graphRepo->method('getGraph')->willReturn($graph);
        $agentRepo = $this->createMock(AgentRepository::class);
        $agentRepo->method('findById')->willReturn(null);
        return (new LangGraphGenerator($pdo ?? $this->pdo(), $wfRepo, $graphRepo, $agentRepo))->generate(44, '3', $options);
    }

    private const POLL = "def run(input, call_tool):\n    r = call_tool('outlook', 'poll_new_mail', {})\n"
        . "    if r.get('mail') is None:\n        return {'route': 'no_mail', 'output': None}\n    return {'route': 'new_mail', 'output': r['mail']}\n";

    /** Start (17) on a Start option, expanded as WorkflowGraphRepository::getGraph does. */
    private function optionGraph(string $watchServer = 'Outlook'): array
    {
        $raw = ['nodes' => [
                ['id' => '17', 'node_type' => 'start', 'config' => ['type' => 'start', 'start_option' => 5]],
                ['id' => '18', 'node_type' => 'output', 'config' => ['type' => 'output']],
            ], 'edges' => [['from_node_id' => '17', 'to_node_id' => '18', 'from_port' => 'output_1']]];
        return StartOptionGraph::expand($raw, fn(int $id) => ['name' => 'Outlook: get new email', 'code' => self::POLL,
            'exits' => ['new_mail', 'no_mail'], 'mcp_servers' => ['Outlook'], 'timeout_s' => 30,
            'start_trigger' => ['label' => 'Outlook: get new email', 'work_exit' => 'new_mail',
                'watch' => ['server' => $watchServer, 'tool' => 'wait_for_new', 'args' => ['folder' => 'Inbox']]]]);
    }

    private function promptGraph(): array
    {
        return ['nodes' => [
                ['id' => '1', 'node_type' => 'start', 'config' => ['type' => 'start', 'prompt' => 'hi']],
                ['id' => '2', 'node_type' => 'output', 'config' => ['type' => 'output']],
            ], 'edges' => [['from_node_id' => '1', 'to_node_id' => '2', 'from_port' => 'output_1']]];
    }

    public function testStartOptionCompilesAsWatchWithItsOwnTrigger(): void
    {
        $code = $this->generate($this->optionGraph())['code'];
        self::assertStringContainsString('START_MODE = "watch"', $code);
        self::assertStringContainsString('WORK_EXIT = "new_mail"', $code);
        self::assertStringContainsString('TRIGGER_NODE_ID = "1000000017"', $code);
        // DEFAULT_WATCH keeps its existing pretty-printed shape; compare with whitespace collapsed.
        self::assertStringContainsString('DEFAULT_WATCH = {"server": "outlook", "tool": "wait_for_new", "args": {"folder": "Inbox"}}',
            preg_replace('/\s*\n\s*/', ' ', preg_replace('/\{\s+/', '{', preg_replace('/\s+\}/', '}', $code))));
    }

    public function testWatchServerNameIsSlugged(): void   // Review Focus 1
    {
        $code = $this->generate($this->optionGraph('outlook'))['code'];
        self::assertStringContainsString('"server": "outlook"', $code);
    }

    public function testPromptStart(): void
    {
        $code = $this->generate($this->promptGraph())['code'];
        self::assertStringContainsString('START_MODE = "prompt"', $code);
        self::assertStringContainsString('WORK_EXIT = None', $code);
        self::assertStringContainsString('TRIGGER_NODE_ID = None', $code);
    }

    public function testScheduleStartAndPausedSchedule(): void
    {
        self::assertStringContainsString('START_MODE = "cron"', $this->generate($this->promptGraph(), [], $this->pdo('*/5 * * * *'))['code']);
        self::assertStringContainsString('START_MODE = "prompt"', $this->generate($this->promptGraph(), [], $this->pdo('*/5 * * * *', true))['code']);
    }

    public function testModularWorkflowCarriesTheMode(): void
    {
        $files = array_column($this->generate($this->optionGraph(), ['modular' => true])['files'], 'code', 'path');
        self::assertStringContainsString('START_MODE = "watch"', $files['workflow.py']);
    }

    public function testStartOptionRefusedInA2A(): void
    {
        $this->expectExceptionMessage('A Start option (Outlook: get new email) needs the single-file or modular format.');
        $this->generate($this->optionGraph(), ['a2a' => true]);
    }
}
