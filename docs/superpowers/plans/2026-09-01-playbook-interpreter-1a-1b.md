# Playbook Interpreter (slices 1a + 1b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run a Console-style ITSM playbook (the Okta Password / MFA Reset reference) inside a SynergyAI workflow via a new "playbook" node, executed server-side in the PHP backend against a mock Okta MCP server, with immediate human gates answered in the browser run UI.

**Architecture:** A framework-neutral class library in `backend/src/Playbook/` (document, analyzer, run state, native tools, action space, gate manager, interpreter implementing the A′ loop — the LLM re-decides each round; no action queue). The workflow context wraps it: a `playbook` node type, a server SSE endpoint the browser orchestrator calls per node, gates blocking in-leg on the existing `SkillToolBridge` (browser posts answers to `/api/v1/workflows/tool-result`). Durable suspend/resume is slice 1c — NOT in this plan.

**Tech Stack:** PHP 8.1, PHPUnit 10 + Mockery (existing harness: `cd backend && vendor/bin/phpunit`), MySQL (CONTEXTS db) for runtime + SQLite in-memory for unit tests, FastRoute, existing `MCPToolsLoader` / `ParallelAgentExecutor` / `SkillToolBridge` / `WorkflowRunLog`, vanilla JS frontend (`workflow-editor.js`).

**Spec:** `docs/superpowers/specs/2026-09-01-playbook-interpreter-design.md`

## Global Constraints

- Namespaces: library `Quantis\AIPortfolioAssistant\Playbook\` → `backend/src/Playbook/` (PSR-4 `Quantis\AIPortfolioAssistant\` → `src/`); tests `Quantis\AIPortfolioAssistant\Tests\Unit\Playbook\` → `backend/tests/Unit/Playbook/`.
- New DB tables use `VARCHAR(32)` statuses (NOT MySQL enums) so unit tests can create the same tables in SQLite.
- Chatbot data lives in the **CONTEXTS db** (`netfo587_chatbot`); any standalone script must use the same PDO bootstrap the controllers use, never `$config['database']`.
- No class in `src/Playbook/` may reference `AgentTeam\`, controllers, `$_SERVER`, or emit SSE — context adapters do that.
- The interpreter never pre-computes an action queue; "what's next" is recomputed each round (spec §"not a queue").
- The model must never invent user input or unbound tools: missing input → `trigger_form`; unbound action → `on_unbound` policy (default `handoff`).
- Sensitive values are stored as `«redacted»` in ledger + transcript.
- Frontend edits to `frontend/assets/js/workflow-editor.js` REQUIRE bumping its `?v=` cache-buster in `frontend/index.html` in the same commit.
- Commit after every task (git, present tense, `feat(playbook): …`); branch `feat/playbook-interpreter`.
- Run `cd backend && vendor/bin/phpunit --filter Playbook` after every task; it must pass.

## File Structure

```
backend/schema/migrations/2026-09-01_playbook_runs.sql       Task 1
backend/src/Playbook/PlaybookDocument.php                     Task 2
backend/src/Playbook/PlaybookAnalyzer.php                     Task 3
backend/src/Playbook/PlaybookRunState.php                     Task 4
backend/src/Playbook/PlaybookTranscript.php                   Task 4
backend/src/Playbook/PlaybookNativeTools.php                  Task 5
backend/src/Playbook/McpExecutorInterface.php                 Task 6
backend/src/Playbook/PlaybookActionSpace.php                  Task 6
backend/src/Playbook/PlaybookInterpreter.php                  Task 7
backend/src/Playbook/GateBridgeInterface.php                  Task 8
backend/src/Playbook/GateManager.php                          Task 8
htdocs/mockokta/index.php + fixtures.php                      Task 9  (path: /Applications/XAMPP/xamppfiles/htdocs/mockokta/)
backend/scripts/register_mock_okta.php                        Task 10
backend/src/Playbook/Adapters/LoaderMcpExecutor.php           Task 10
backend/src/Controllers/PlaybookController.php                Task 11
backend/src/Playbook/Adapters/WorkflowLlmClient.php           Task 12
backend/src/Playbook/Adapters/SkillBridgeGateBridge.php       Task 12
backend/src/AgentTeam/Services/PlaybookNodeRunner.php         Task 12
frontend/assets/js/workflow-editor.js (+index.html buster)    Task 13
docs — acceptance checklist results                           Task 14
```

---

### Task 1: DB migration — playbook run tables + node type

**Files:**
- Create: `backend/schema/migrations/2026-09-01_playbook_runs.sql`

**Interfaces:**
- Produces: tables `playbook_runs`, `playbook_run_messages`, `playbook_run_notes`, `playbook_run_ledger`, `playbook_run_gates`; `workflow_nodes.node_type` accepts `'playbook'`.

- [ ] **Step 1: Write the migration**

```sql
-- 2026-09-01_playbook_runs.sql — playbook interpreter run record (spec §Data model)
-- VARCHAR statuses (not enum): unit tests recreate these tables in SQLite.
CREATE TABLE IF NOT EXISTS playbook_runs (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  playbook_title VARCHAR(255) NOT NULL,
  document JSON NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  requester JSON NULL,
  variables JSON NULL,
  pending_gate JSON NULL,
  current_leg INT NOT NULL DEFAULT 0,
  coverage JSON NULL,
  created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  resolved_at TIMESTAMP NULL DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS playbook_run_messages (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  run_id INT NOT NULL,
  direction VARCHAR(32) NOT NULL,          -- to_requester|from_requester|to_channel|to_email
  audience VARCHAR(255) NULL,
  text TEXT NOT NULL,
  sensitive TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_pbm_run (run_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS playbook_run_notes (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  run_id INT NOT NULL,
  author VARCHAR(32) NOT NULL DEFAULT 'agent',
  text TEXT NOT NULL,
  created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_pbn_run (run_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS playbook_run_ledger (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  run_id INT NOT NULL,
  leg INT NOT NULL DEFAULT 0,
  seq INT NOT NULL,
  action_name VARCHAR(255) NOT NULL,       -- the #Action or native verb name
  tool VARCHAR(255) NOT NULL,              -- resolved tool id (okta.search_users / native)
  args JSON NULL,                          -- redacted
  outcome VARCHAR(32) NOT NULL,            -- ok|failed|skipped|replayed
  result_summary TEXT NULL,
  returned_ids JSON NULL,
  sensitive TINYINT(1) NOT NULL DEFAULT 0,
  duration_ms INT NULL,
  created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_pbl_run (run_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS playbook_run_gates (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  run_id INT NOT NULL,
  leg INT NOT NULL DEFAULT 0,
  kind VARCHAR(32) NOT NULL,               -- form|await_message|approval|handoff|wait
  args JSON NULL,
  asked_of VARCHAR(32) NOT NULL,           -- requester|approver|operator|clock
  opened_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  closed_at TIMESTAMP NULL DEFAULT NULL,
  decision JSON NULL,
  actor VARCHAR(255) NULL,
  INDEX idx_pbg_run (run_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE workflow_nodes MODIFY node_type
  ENUM('start','output','agent','parallel','playbook') NOT NULL;
```

- [ ] **Step 2: Apply to the CONTEXTS db** (name per `backend/.env` / config — verify with `grep -ri "netfo587_chatbot\|CONTEXTS" backend/.env backend/src/Config | head`)

Run: `mysql -u root netfo587_chatbot < backend/schema/migrations/2026-09-01_playbook_runs.sql` (adjust user/db to the .env values). Verify: `mysql -u root netfo587_chatbot -e "SHOW TABLES LIKE 'playbook%'; SHOW COLUMNS FROM workflow_nodes LIKE 'node_type';"` — 5 tables, enum contains `playbook`.

- [ ] **Step 3: Commit** — `git add backend/schema/migrations/2026-09-01_playbook_runs.sql && git commit -m "feat(playbook): run-record tables and playbook node type"`

---

### Task 2: PlaybookDocument

**Files:**
- Create: `backend/src/Playbook/PlaybookDocument.php`
- Test: `backend/tests/Unit/Playbook/PlaybookDocumentTest.php`

**Interfaces:**
- Produces: `PlaybookDocument::fromArray(array $a): self`, `PlaybookDocument::fromConsoleText(string $text): self`, readonly props `title, trigger (array{kind:string,description:string}), instructions, toolsUsed (string[]), actionsUsed (string[]), bindings (array<string,?string>), policy (array{writes_enabled:bool,on_unbound:string,on_failure:string}), approvers (array<string,string>)`, `toArray(): array`.

- [ ] **Step 1: Write failing tests**

```php
<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit\Playbook;

use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Playbook\PlaybookDocument;

class PlaybookDocumentTest extends TestCase
{
    public function testFromArrayDefaultsPolicy(): void
    {
        $d = PlaybookDocument::fromArray([
            'title' => 'T', 'trigger' => ['kind' => 'request', 'description' => 'x'],
            'instructions' => 'Do #Foo.', 'tools_used' => ['Okta'],
            'actions_used' => ['#Foo'], 'bindings' => ['#Foo' => 'okta.foo'],
        ]);
        $this->assertSame('T', $d->title);
        $this->assertFalse($d->policy['writes_enabled']);
        $this->assertSame('handoff', $d->policy['on_unbound']);
        $this->assertSame('continue_then_handoff', $d->policy['on_failure']);
        $this->assertSame(['#Foo' => 'okta.foo'], $d->bindings);
    }

    public function testFromConsoleTextParsesSections(): void
    {
        $text = "Title: Okta Password / MFA Reset\n\n" .
            "Trigger: Requester reports being locked out.\n\n" .
            "Instructions: #Search Okta User by Email for the requester. #Resolve Request.\n\n" .
            "Tools used: Okta\n\n" .
            "Actions used: #Search Okta User by Email; #Resolve Request";
        $d = PlaybookDocument::fromConsoleText($text);
        $this->assertSame('Okta Password / MFA Reset', $d->title);
        $this->assertSame('request', $d->trigger['kind']);
        $this->assertStringContainsString('locked out', $d->trigger['description']);
        $this->assertStringContainsString('#Search Okta User by Email', $d->instructions);
        $this->assertSame(['Okta'], $d->toolsUsed);
        $this->assertSame(['#Search Okta User by Email', '#Resolve Request'], $d->actionsUsed);
        $this->assertSame([], $d->bindings);
    }

    public function testMissingTitleThrows(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        PlaybookDocument::fromArray(['instructions' => 'x']);
    }
}
```

- [ ] **Step 2: Run to verify failure** — `cd backend && vendor/bin/phpunit tests/Unit/Playbook/PlaybookDocumentTest.php` → FAIL (class not found).

- [ ] **Step 3: Implement**

```php
<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Playbook;

final class PlaybookDocument
{
    /** @param array<string,?string> $bindings @param string[] $toolsUsed @param string[] $actionsUsed */
    private function __construct(
        public readonly string $title,
        public readonly array $trigger,
        public readonly string $instructions,
        public readonly array $toolsUsed,
        public readonly array $actionsUsed,
        public readonly array $bindings,
        public readonly array $policy,
        public readonly array $approvers,
    ) {}

    public static function fromArray(array $a): self
    {
        $title = trim((string)($a['title'] ?? ''));
        $instructions = trim((string)($a['instructions'] ?? ''));
        if ($title === '' || $instructions === '') {
            throw new \InvalidArgumentException('Playbook needs a title and instructions');
        }
        $trigger = $a['trigger'] ?? [];
        return new self(
            $title,
            ['kind' => (string)($trigger['kind'] ?? 'request'),
             'description' => (string)($trigger['description'] ?? '')],
            $instructions,
            array_values(array_map('trim', (array)($a['tools_used'] ?? []))),
            array_values(array_map('trim', (array)($a['actions_used'] ?? []))),
            (array)($a['bindings'] ?? []),
            [
                'writes_enabled' => (bool)($a['policy']['writes_enabled'] ?? false),
                'on_unbound' => (string)($a['policy']['on_unbound'] ?? 'handoff'),
                'on_failure' => (string)($a['policy']['on_failure'] ?? 'continue_then_handoff'),
            ],
            (array)($a['approvers'] ?? []),
        );
    }

    /** Parse the Console library format: "Title: …", "Trigger: …", "Instructions: …", "Tools used: a; b", "Actions used: #A; #B". */
    public static function fromConsoleText(string $text): self
    {
        $sections = ['title' => '', 'trigger' => '', 'instructions' => '', 'tools used' => '', 'actions used' => ''];
        $current = null;
        foreach (preg_split('/\r?\n/', $text) as $line) {
            if (preg_match('/^\s*(Title|Trigger|Instructions|Tools used|Actions used)\s*:\s*(.*)$/i', $line, $m)) {
                $current = strtolower($m[1]);
                $sections[$current] = $m[2];
            } elseif ($current !== null) {
                $sections[$current] .= "\n" . $line;
            }
        }
        $semiList = fn(string $s): array => array_values(array_filter(array_map('trim', explode(';', $s)), fn($x) => $x !== ''));
        return self::fromArray([
            'title' => trim($sections['title']),
            'trigger' => ['kind' => 'request', 'description' => trim($sections['trigger'])],
            'instructions' => trim($sections['instructions']),
            'tools_used' => $semiList($sections['tools used']),
            'actions_used' => $semiList($sections['actions used']),
        ]);
    }

    public function toArray(): array
    {
        return [
            'title' => $this->title, 'trigger' => $this->trigger,
            'instructions' => $this->instructions, 'tools_used' => $this->toolsUsed,
            'actions_used' => $this->actionsUsed, 'bindings' => $this->bindings,
            'policy' => $this->policy, 'approvers' => $this->approvers,
        ];
    }
}
```

- [ ] **Step 4: Run tests** — same command → PASS.
- [ ] **Step 5: Commit** — `git add backend/src/Playbook backend/tests/Unit/Playbook && git commit -m "feat(playbook): PlaybookDocument parses JSON and Console text"`

---

### Task 3: PlaybookAnalyzer

**Files:**
- Create: `backend/src/Playbook/PlaybookAnalyzer.php`
- Test: `backend/tests/Unit/Playbook/PlaybookAnalyzerTest.php`

**Interfaces:**
- Consumes: `PlaybookDocument`.
- Produces: `PlaybookAnalyzer::NATIVE_VERBS` (const list), `analyze(PlaybookDocument $doc, array $availableTools, array $availableAgents = []): array` returning `['actions' => [['name','kind' /* native|bound|unbound */, 'target']], 'gates' => string[], 'checklist' => string[], 'errors' => string[], 'warnings' => string[]]`. `$availableTools` = list of `"server.tool"` ids that exist and are connected.

- [ ] **Step 1: Failing tests** — cover: native classification of `#Request Approval`/`#Resolve Request`/`#Send Direct Message`/`#Leave Internal Note`/`#Prompt for Handoff`/`#Send Channel Message`/`#Trigger Form`; bound when binding target ∈ availableTools; **error** when binding target ∉ availableTools (spec T4); **warning** (unbound) when action has no binding or `null`; gates list contains `approval`+`handoff` for the MFA text; checklist preserves prose order; `agent.researcher` bound iff in `$availableAgents`.

```php
<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit\Playbook;

use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Playbook\{PlaybookAnalyzer, PlaybookDocument};

class PlaybookAnalyzerTest extends TestCase
{
    private function doc(array $over = []): PlaybookDocument
    {
        return PlaybookDocument::fromArray(array_merge([
            'title' => 'MFA', 'trigger' => ['kind' => 'request', 'description' => 'locked out'],
            'instructions' => "#Search Okta User by Email first. Medium risk: #Request Approval from manager. " .
                "High: #Prompt for Handoff to security. Then #Reset Password (Okta). " .
                "#Reset User Factors (Custom) if lost device. #Leave Internal Note. #Resolve Request.",
            'tools_used' => ['Okta'],
            'actions_used' => ['#Search Okta User by Email', '#Request Approval', '#Prompt for Handoff',
                '#Reset Password (Okta)', '#Reset User Factors (Custom)', '#Leave Internal Note', '#Resolve Request'],
            'bindings' => ['#Search Okta User by Email' => 'okta.search_users',
                '#Reset Password (Okta)' => 'okta.reset_password',
                '#Reset User Factors (Custom)' => null],
        ], $over));
    }

    public function testClassification(): void
    {
        $r = (new PlaybookAnalyzer())->analyze($this->doc(), ['okta.search_users', 'okta.reset_password']);
        $byName = array_column($r['actions'], null, 'name');
        $this->assertSame('bound', $byName['#Search Okta User by Email']['kind']);
        $this->assertSame('okta.search_users', $byName['#Search Okta User by Email']['target']);
        $this->assertSame('native', $byName['#Request Approval']['kind']);
        $this->assertSame('native', $byName['#Resolve Request']['kind']);
        $this->assertSame('unbound', $byName['#Reset User Factors (Custom)']['kind']);
        $this->assertContains('approval', $r['gates']);
        $this->assertContains('handoff', $r['gates']);
        $this->assertSame([], $r['errors']);
        $this->assertNotEmpty($r['warnings']); // the unbound action
    }

    public function testDanglingBindingIsError(): void
    {
        $r = (new PlaybookAnalyzer())->analyze($this->doc(), ['okta.search_users']); // reset_password missing
        $this->assertNotEmpty($r['errors']);
        $this->assertStringContainsString('#Reset Password (Okta)', $r['errors'][0]);
    }

    public function testChecklistPreservesProseOrder(): void
    {
        $r = (new PlaybookAnalyzer())->analyze($this->doc(), ['okta.search_users', 'okta.reset_password']);
        $this->assertSame('#Search Okta User by Email', $r['checklist'][0]);
        $this->assertSame('#Resolve Request', end($r['checklist']));
    }

    public function testAgentBinding(): void
    {
        $doc = $this->doc(['bindings' => ['#Search Okta User by Email' => 'agent.researcher',
            '#Reset Password (Okta)' => 'okta.reset_password', '#Reset User Factors (Custom)' => null]]);
        $ok = (new PlaybookAnalyzer())->analyze($doc, ['okta.reset_password'], ['researcher']);
        $this->assertSame('bound', array_column($ok['actions'], null, 'name')['#Search Okta User by Email']['kind']);
        $bad = (new PlaybookAnalyzer())->analyze($doc, ['okta.reset_password'], []);
        $this->assertNotEmpty($bad['errors']);
    }
}
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement**

```php
<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Playbook;

final class PlaybookAnalyzer
{
    /** #Action name (case-insensitive, trimmed) => native tool id */
    public const NATIVE_VERBS = [
        '#send direct message' => 'send_direct_message',
        '#send channel message' => 'send_channel_message',
        '#send email' => 'send_email',
        '#leave internal note' => 'leave_internal_note',
        '#resolve request' => 'resolve_request',
        '#escalate request' => 'set_priority',
        '#request approval' => 'request_approval',
        '#prompt for handoff' => 'prompt_handoff',
        '#trigger form' => 'trigger_form',
    ];
    private const GATE_BY_NATIVE = [
        'request_approval' => 'approval', 'prompt_handoff' => 'handoff', 'trigger_form' => 'form',
    ];

    /** @param string[] $availableTools "server.tool" ids @param string[] $availableAgents agent names */
    public function analyze(PlaybookDocument $doc, array $availableTools, array $availableAgents = []): array
    {
        $actions = []; $gates = []; $errors = []; $warnings = [];
        // Checklist = #Actions in prose order (longest-name-first match so
        // "#Reset User Factors (Custom)" wins over "#Reset User Factor").
        $names = $doc->actionsUsed;
        usort($names, fn($a, $b) => strlen($b) <=> strlen($a));
        $positions = [];
        foreach ($names as $name) {
            $pos = stripos($doc->instructions, $name);
            $positions[$name] = $pos === false ? PHP_INT_MAX : $pos;
        }
        $ordered = $doc->actionsUsed;
        usort($ordered, fn($a, $b) => $positions[$a] <=> $positions[$b]);

        foreach ($ordered as $name) {
            $key = strtolower(trim($name));
            if (isset(self::NATIVE_VERBS[$key])) {
                $native = self::NATIVE_VERBS[$key];
                $actions[] = ['name' => $name, 'kind' => 'native', 'target' => $native];
                if (isset(self::GATE_BY_NATIVE[$native])) $gates[] = self::GATE_BY_NATIVE[$native];
                continue;
            }
            $target = $doc->bindings[$name] ?? null;
            if ($target === null) {
                $actions[] = ['name' => $name, 'kind' => 'unbound', 'target' => null];
                $warnings[] = "Unbound action {$name}: at run time the '{$doc->policy['on_unbound']}' policy applies.";
                continue;
            }
            if (str_starts_with($target, 'agent.')) {
                $agent = substr($target, 6);
                if (in_array($agent, $availableAgents, true)) {
                    $actions[] = ['name' => $name, 'kind' => 'bound', 'target' => $target];
                } else {
                    $actions[] = ['name' => $name, 'kind' => 'unbound', 'target' => $target];
                    $errors[] = "{$name} is bound to {$target} but no such agent exists.";
                }
                continue;
            }
            if (in_array($target, $availableTools, true)) {
                $actions[] = ['name' => $name, 'kind' => 'bound', 'target' => $target];
            } else {
                $actions[] = ['name' => $name, 'kind' => 'unbound', 'target' => $target];
                $errors[] = "{$name} is bound to {$target} but that tool is not available on any connected MCP server.";
            }
        }
        return ['actions' => $actions, 'gates' => array_values(array_unique($gates)),
                'checklist' => $ordered, 'errors' => $errors, 'warnings' => $warnings];
    }
}
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(playbook): analyzer classifies actions, detects gates, builds checklist"`

---

### Task 4: PlaybookRunState + PlaybookTranscript

**Files:**
- Create: `backend/src/Playbook/PlaybookRunState.php`, `backend/src/Playbook/PlaybookTranscript.php`
- Test: `backend/tests/Unit/Playbook/PlaybookRunStateTest.php`

**Interfaces:**
- Produces: `new PlaybookRunState(\PDO $pdo, PlaybookTranscript $transcript)`; `createRun(int $userId, PlaybookDocument $doc, array $requester, array $variables): int`; `setStatus(int $runId, string $status): void`; `addMessage(int $runId, string $direction, ?string $audience, string $text, bool $sensitive = false): void`; `addNote(int $runId, string $text, string $author = 'agent'): void`; `ledgerAppend(int $runId, int $leg, string $actionName, string $tool, array $args, string $outcome, ?string $summary, bool $sensitive = false): void`; `ledgerFindOk(int $runId, string $tool, array $args): ?array` (replay guard: same tool + identical json-encoded args with outcome `ok`); `getRun(int $runId): array`; `ledgerAll(int $runId): array`.
- `PlaybookTranscript`: `new PlaybookTranscript(string $dir)`; `append(int $runId, array $event): void`; `read(int $runId): array`; events get `ts` added. Writes `{dir}/playbook-{runId}.jsonl`.
- Redaction: when `sensitive`, `args`/`summary` are stored as `'«redacted»'`.

- [ ] **Step 1: Failing tests** — use in-memory SQLite; `setUp()` creates the five tables with the SQLite dialect (INTEGER PRIMARY KEY AUTOINCREMENT, TEXT for JSON, no ON UPDATE):

```php
<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit\Playbook;

use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Playbook\{PlaybookDocument, PlaybookRunState, PlaybookTranscript};

class PlaybookRunStateTest extends TestCase
{
    private \PDO $pdo;
    private PlaybookRunState $state;
    private string $dir;

    protected function setUp(): void
    {
        $this->pdo = new \PDO('sqlite::memory:');
        $this->pdo->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
        $this->pdo->exec("CREATE TABLE playbook_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INT, playbook_title TEXT,
            document TEXT, status TEXT DEFAULT 'pending', requester TEXT, variables TEXT, pending_gate TEXT,
            current_leg INT DEFAULT 0, coverage TEXT, created_at TEXT, updated_at TEXT, resolved_at TEXT)");
        $this->pdo->exec("CREATE TABLE playbook_run_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INT,
            direction TEXT, audience TEXT, text TEXT, sensitive INT DEFAULT 0, created_at TEXT)");
        $this->pdo->exec("CREATE TABLE playbook_run_notes (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INT,
            author TEXT DEFAULT 'agent', text TEXT, created_at TEXT)");
        $this->pdo->exec("CREATE TABLE playbook_run_ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INT, leg INT DEFAULT 0,
            seq INT, action_name TEXT, tool TEXT, args TEXT, outcome TEXT, result_summary TEXT, returned_ids TEXT,
            sensitive INT DEFAULT 0, duration_ms INT, created_at TEXT)");
        $this->pdo->exec("CREATE TABLE playbook_run_gates (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INT, leg INT DEFAULT 0,
            kind TEXT, args TEXT, asked_of TEXT, opened_at TEXT, closed_at TEXT, decision TEXT, actor TEXT)");
        $this->dir = sys_get_temp_dir() . '/pbtest-' . bin2hex(random_bytes(4));
        mkdir($this->dir);
        $this->state = new PlaybookRunState($this->pdo, new PlaybookTranscript($this->dir));
    }

    private function doc(): PlaybookDocument
    {
        return PlaybookDocument::fromArray(['title' => 'T',
            'trigger' => ['kind' => 'request', 'description' => 'd'], 'instructions' => '#Resolve Request.']);
    }

    public function testCreateRunAndStatus(): void
    {
        $id = $this->state->createRun(1, $this->doc(), ['email' => 'low@test'], []);
        $this->assertSame('running', $this->state->getRun($id)['status']);
        $this->state->setStatus($id, 'resolved');
        $this->assertSame('resolved', $this->state->getRun($id)['status']);
    }

    public function testLedgerReplayGuard(): void
    {
        $id = $this->state->createRun(1, $this->doc(), [], []);
        $this->state->ledgerAppend($id, 0, '#Reset Password (Okta)', 'okta.reset_password',
            ['user_id' => 'u1', 'send_email' => true], 'ok', 'done');
        $hit = $this->state->ledgerFindOk($id, 'okta.reset_password', ['user_id' => 'u1', 'send_email' => true]);
        $this->assertNotNull($hit);
        $this->assertNull($this->state->ledgerFindOk($id, 'okta.reset_password', ['user_id' => 'OTHER']));
        $this->assertNull($this->state->ledgerFindOk($id + 1, 'okta.reset_password', ['user_id' => 'u1', 'send_email' => true]));
    }

    public function testSensitiveRedaction(): void
    {
        $id = $this->state->createRun(1, $this->doc(), [], []);
        $this->state->ledgerAppend($id, 0, '#Get Key', 'okta.get_key', ['secret' => 'ABC'], 'ok', 'key=ABC', true);
        $row = $this->state->ledgerAll($id)[0];
        $this->assertSame('"«redacted»"', $row['args']);
        $this->assertSame('«redacted»', $row['result_summary']);
    }

    public function testTranscriptRoundTrip(): void
    {
        $id = $this->state->createRun(1, $this->doc(), [], []);
        $t = new PlaybookTranscript($this->dir);
        $t->append($id, ['type' => 'leg_started', 'leg' => 0]);
        $t->append($id, ['type' => 'tool_call', 'tool' => 'okta.search_users']);
        $events = $t->read($id);
        $this->assertCount(2, $events);
        $this->assertSame('leg_started', $events[0]['type']);
        $this->assertArrayHasKey('ts', $events[0]);
    }
}
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.** `PlaybookTranscript` (~30 lines): `append` json-encodes `$event + ['ts' => date('c')]` and appends a line with `FILE_APPEND|LOCK_EX`; `read` maps `json_decode` over `file()` (empty array when file missing). `PlaybookRunState` (~110 lines): plain prepared statements; `createRun` inserts with status `running` and returns `(int)$pdo->lastInsertId()`; `ledgerAppend` computes `seq` as `1 + (SELECT COALESCE(MAX(seq),0) … WHERE run_id=?)`, stores `json_encode($sensitive ? '«redacted»' : $args)` and `$sensitive ? '«redacted»' : $summary`; `ledgerFindOk` selects `outcome='ok' AND tool=? AND args=?` comparing against `json_encode($args)` (canonical: `ksort` recursively before encoding, in both append and find — write a private `canon(array $a): string`); `getRun`/`ledgerAll` fetchAssoc. All SQL must run on both MySQL and SQLite (no `NOW()` — pass `date('Y-m-d H:i:s')` from PHP).
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(playbook): run state with ledger, replay guard, redaction, transcript"`

---

### Task 5: PlaybookNativeTools

**Files:**
- Create: `backend/src/Playbook/PlaybookNativeTools.php`
- Test: `backend/tests/Unit/Playbook/PlaybookNativeToolsTest.php`

**Interfaces:**
- Consumes: `PlaybookRunState` (Task 4).
- Produces: `new PlaybookNativeTools(PlaybookRunState $state)`; `definitions(): array` — OpenAI-style tool defs `[['type'=>'function','function'=>['name','description','parameters'=>JSON-schema]], …]` for `send_direct_message {text, sensitive?}`, `send_channel_message {channel, text}`, `send_email {to, subject, text}`, `leave_internal_note {text}`, `set_priority {priority, reason}`, `resolve_request {outcome, summary}`; `execute(int $runId, int $leg, string $name, array $args): array` returning `['ok'=>true, …]`; `resolve_request` sets run status `resolved` and returns `['ok'=>true,'terminal'=>true]`. Gate verbs are NOT here (Task 8).

- [ ] **Step 1: Failing tests** — reuse the SQLite `setUp` from Task 4 (extract it into a shared `tests/Unit/Playbook/PlaybookDbTestCase.php` base class in this task; make `PlaybookRunStateTest` extend it too). Assert: `send_direct_message` inserts a `to_requester` message (and `sensitive:true` flag persists); `leave_internal_note` inserts a note; `resolve_request` flips status to `resolved` and returns `terminal`; unknown name returns `['ok'=>false,'error'=>…]`; `definitions()` contains 6 entries each with `function.name` and `function.parameters.type === 'object'`.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** (~90 lines): a `match` on `$name` writing through `PlaybookRunState`; `send_channel_message` stores direction `to_channel` with `audience = $args['channel']`; `send_email` direction `to_email`, `audience = $args['to']`; `set_priority` appends a note `"priority → {$args['priority']}: {$args['reason']}"` (v1 minimal per spec).
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(playbook): native verbs acting on the run record"`

---

### Task 6: PlaybookActionSpace

**Files:**
- Create: `backend/src/Playbook/McpExecutorInterface.php`, `backend/src/Playbook/PlaybookActionSpace.php`
- Test: `backend/tests/Unit/Playbook/PlaybookActionSpaceTest.php`

**Interfaces:**
- Consumes: analyzer result `actions` (Task 3), `PlaybookNativeTools` (Task 5), `PlaybookRunState`.
- Produces:
  - `interface McpExecutorInterface { /** @return array{ok:bool,result?:mixed,error?:string} */ public function call(string $server, string $tool, array $args): array; /** @return array<string,array{description:string,input_schema:array}> keyed "server.tool" */ public function availableTools(): array; }`
  - `new PlaybookActionSpace(array $analyzedActions, PlaybookNativeTools $native, McpExecutorInterface $mcp, PlaybookRunState $state, array $policy)`;
  - `toolDefinitions(): array` — native defs + one def per **bound** MCP action, LLM-visible name = sanitized target (`okta.search_users` → `okta__search_users`), description prefixed with the `#Action` name, parameters from the MCP schema; plus one def per **unbound** action named `unbound__<slug>` whose description says "NOT AVAILABLE — calling this applies the on_unbound policy" (so the model has an honest handle instead of inventing);
  - `execute(int $runId, int $leg, string $llmToolName, array $args): array` — dispatches native / MCP / unbound; **replay guard**: for MCP calls, `ledgerFindOk` first → return stored summary with `outcome 'replayed'` (no MCP call); **write policy**: if `policy['writes_enabled']` is false and the tool name matches `/reset|create|update|delete|write|add|remove|assign|invite|unlock/i`, refuse with ledger outcome `skipped`; every path appends to the ledger; unbound → outcome `skipped` + returns `['ok'=>false,'unbound'=>true,'policy'=>$policy['on_unbound'],'guidance'=>'This action has no connected implementation. Follow the policy: hand off to a human with prompt_handoff and note what could not be done.']`.

- [ ] **Step 1: Failing tests** — with a `FakeMcpExecutor` (records calls, returns canned results, exposes 2 tools): definitions include `okta__search_users` and `unbound__reset_user_factors_custom`; whitelist: executing a name not in definitions → `['ok'=>false]` + ledger `skipped`; MCP dispatch maps `okta__search_users`→`call('okta','search_users',…)`; replay: second identical call returns `outcome 'replayed'` and fake records only ONE call (spec T5 unit-level); write policy: `okta__reset_password` with `writes_enabled=false` → skipped, with `true` → executed; unbound execute returns `unbound=true` and guidance.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** (~140 lines). Name sanitizer: `strtolower(preg_replace('/[^a-z0-9]+/i', '_', $target))` with `.`→`__`; keep a private map llmName → `['kind','server','tool','action_name']` built in the constructor from `$analyzedActions`.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(playbook): action space with whitelist, replay guard, write policy"`

---

### Task 7: PlaybookInterpreter (the A′ loop)

**Files:**
- Create: `backend/src/Playbook/PlaybookInterpreter.php`
- Test: `backend/tests/Unit/Playbook/PlaybookInterpreterTest.php`

**Interfaces:**
- Consumes: `PlaybookDocument`, `PlaybookActionSpace`, `PlaybookRunState`, `PlaybookTranscript`.
- Produces: `new PlaybookInterpreter(PlaybookActionSpace $space, PlaybookRunState $state, PlaybookTranscript $transcript, \Closure $llm, int $maxRounds = 40, ?\Closure $onEvent = null)`. `$llm` contract: `fn(array $messages, array $toolDefs): array{text: ?string, tool_calls: array<array{id:string,name:string,arguments:array}>}` (throws on provider error). `$onEvent` receives `['type'=>…, …]` for streaming (`round`, `tool_call`, `tool_result`, `message`, `final`). `runLeg(int $runId, int $leg, PlaybookDocument $doc, array $variables, array $requester, string $requestText): array{status:string, output:string}`.
- Loop: build system prompt (below) + user message (request + variables); each round call `$llm`; for each tool call → `space->execute(...)`, append `role:'tool'` result message (json), emit events, write transcript (`tool_call`, `tool_result`); a result containing `'terminal'=>true` (resolve_request) or `'gate_ended_leg'=>true` (Task 8) stops after finishing the round's remaining calls; no tool calls → final text, transcript `leg_ended`, return; round budget exhausted → status `failed` with a `leave_internal_note` via space.
- System prompt (verbatim constant, used in tests):

```
You are a playbook interpreter for an IT service desk. Execute the PLAYBOOK below
for the current REQUEST, step by step, using ONLY the tools provided.
Rules:
- Never invent tool results, user input, or tools. If information from the requester
  is missing, you must obtain it through the provided tools; if an action has no
  working tool (an "unbound" tool tells you so), follow its guidance instead of guessing.
- Take parameters for later steps from earlier tool results.
- When the playbook says Stop or the work is complete, call resolve_request.
- Record what you did with leave_internal_note before resolving, as the playbook asks.
PLAYBOOK:
{instructions}
POLICY: {policy_json}
```

- [ ] **Step 1: Failing tests** — a `ScriptedLlm` closure popping queued responses. Scenario "T1-shaped": queue = (1) call `okta__search_users`; (2) call `okta__search_system_log` + `okta__list_user_factors` (parallel, one response, two tool_calls); (3) call `okta__verify_security_answers`; (4) call `okta__reset_password {user_id:'u1',send_email:true}`; (5) call `send_direct_message`; (6) call `leave_internal_note` then `resolve_request`; assert: return status `resolved`; ledger order exactly `okta.search_users, okta.search_system_log, okta.list_user_factors, okta.verify_security_answers, okta.reset_password, native send_direct_message, native leave_internal_note, native resolve_request`; `send_email=true` present in the reset args; transcript has `leg_started` first and `leg_ended` last. Second scenario: round budget 2 with an LLM that always calls a tool → status `failed`. Third: messages passed to round 2 include the round-1 `role:'tool'` result (data flow).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** (~130 lines). Messages array: `[['role'=>'system','content'=>$sys], ['role'=>'user','content'=>$req]]`, then append assistant tool_calls messages (`['role'=>'assistant','content'=>$text,'tool_calls'=>[['id'=>…,'type'=>'function','function'=>['name'=>…,'arguments'=>json_encode($args)]]]]`) and tool results (`['role'=>'tool','tool_call_id'=>…,'name'=>…,'content'=>json]`) — the same OpenAI-common-denominator shape `GraphWorkflowRunner` uses (see its lines ~1922-1975).
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(playbook): A-prime interpreter loop with scripted-LLM tests"`

---

### Task 8: GateManager + gate tools (slice 1b, immediate mode)

**Files:**
- Create: `backend/src/Playbook/GateBridgeInterface.php`, `backend/src/Playbook/GateManager.php`
- Modify: `backend/src/Playbook/PlaybookActionSpace.php` (accept optional `GateManager`, merge its defs, dispatch gate names to it)
- Test: `backend/tests/Unit/Playbook/GateManagerTest.php`

**Interfaces:**
- `interface GateBridgeInterface { /** Present the gate to a human and block until answered or timeout. @return ?array the decision payload, null on timeout */ public function ask(int $runId, string $kind, array $payload, int $timeoutMs): ?array; }`
- `new GateManager(PlaybookRunState $state, GateBridgeInterface $bridge, int $timeoutMs = 900000)`; `definitions(): array` for `trigger_form {prompt, fields:[{name,label,type,options?,sensitive?}]}`, `request_approval {approver, question, context}`, `prompt_handoff {team_or_person, reason, summary}`, `await_message {prompt}`; `execute(int $runId, int $leg, string $name, array $args): array`.
- Behaviour (immediate mode, v1): `execute` inserts a `playbook_run_gates` row (kind map: trigger_form→`form`, request_approval→`approval`, prompt_handoff→`handoff`, await_message→`await_message`; asked_of requester/approver/operator), sets run status to the matching waiting status, calls `bridge->ask(...)`; on answer → close gate (decision json + actor), set status back to `running`, return `['ok'=>true,'decision'=>$answer]` (for approval the answer is `{decision:'approved'|'denied', comment, actor}` — the LLM reads it and follows the playbook's deny branch itself); on timeout → close with `{decision:'timeout'}`, return `['ok'=>false,'timeout'=>true,'guidance'=>'No human answered in time. Leave an internal note and resolve as uncompleted.']`. Sensitive form fields: values whose field def had `sensitive:true` are redacted in the gate `decision` (store `«redacted»`) but returned verbatim to the caller.
- ActionSpace integration: gate tool names route to `GateManager::execute`; a gate result is wrapped `+ ['gate'=>true]` and the ledger records `outcome 'ok'` with the decision (redacted per above).

- [ ] **Step 1: Failing tests** — `FakeBridge` returning queued answers: approval approved → status sequence `awaiting_approval`→`running`, gate row closed with actor; approval timeout → `['ok'=>false,'timeout'=>true]` and decision `timeout`; form with a `sensitive` field → decision stored redacted, returned value intact; interpreter-level test: scripted LLM calls `request_approval` then (after `approved`) `okta__reset_password` — assert order and that the messages given to the post-gate round contain the decision.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** (~110 lines).
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(playbook): immediate-mode gates via blocking bridge"`

---

### Task 9: Mock Okta MCP server

**Files:**
- Create: `/Applications/XAMPP/xamppfiles/htdocs/mockokta/index.php`, `/Applications/XAMPP/xamppfiles/htdocs/mockokta/fixtures.php`
- Test: `backend/tests/Unit/Playbook/MockOktaHandlerTest.php` (tests the handler function directly, no HTTP)

**Interfaces:**
- Produces: a streamable-HTTP MCP endpoint at `http://localhost/mockokta/` answering JSON-RPC `initialize`, `tools/list`, `tools/call`. Tools (all `input_schema` `type:object` with the listed properties): `search_users {email}`, `search_system_log {email, event_types?, since_days?}`, `list_user_factors {user_id}`, `verify_security_answers {user_id, answers}`, `reset_password {user_id, send_email}`, `reset_factor {user_id, factor_id}`, `unlock_user {user_id}`. Structure the file as `function mockokta_handle(array $rpc, string $logDir): array` + a thin `echo json_encode(mockokta_handle(json_decode(file_get_contents('php://input'), true), __DIR__.'/log'))` so tests call the function.
- Fixtures (in `fixtures.php`, keyed by email): `low@test` → user `u-low`, empty log, factors `[{id:'f1',type:'sms'}]`, security answers `['fluffy','paris']`; `medium@test` → `u-med`, log has `[{event:'user.session.start', ip:'203.0.113.9', country:'unusual'}]`; `high@test` → `u-high`, log has 4 × `user.account.reset_password` events in the last 30 days. Unknown email → empty result set (not an error).
- Call log: every `tools/call` appends `{tool, args, ts}` to `log/calls.jsonl`; `tools/call` for tool `_reset_call_log` truncates it (test hook, not listed in `tools/list`); `_get_call_log` returns it. `reset_password` counts per-`user_id` and the T5 integration assert reads the log.
- Response shape: `{"jsonrpc":"2.0","id":…,"result":{"content":[{"type":"text","text": json_encode($data)}]}}` for `tools/call`; `tools/list` → `{"result":{"tools":[{name,description,inputSchema}]}}` — verify the exact field casing against what `MCPToolsLoader::callMCPServer` expects by reading `backend/src/Services/MCPToolsLoader.php:235-360` before finalizing.

- [ ] **Step 1: Failing tests** — call `mockokta_handle` for: `tools/list` returns 7 tools; `search_users {email:'low@test'}` → text content containing `u-low`; `search_system_log {email:'high@test'}` → 4 reset events; `reset_password` twice → call log has 2 entries; `_reset_call_log` empties it.
- [ ] **Step 2: Run → FAIL** (require the file with `require __DIR__.'/../../../../../mockokta/fixtures.php'` — compute the path with `realpath`; guard the HTTP echo with `if (PHP_SAPI !== 'cli')`).
- [ ] **Step 3: Implement** (~150 lines single file + fixtures array).
- [ ] **Step 4: Run tests → PASS; then smoke over HTTP:** `curl -s http://localhost/mockokta/ -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'` → 7 tools (requires XAMPP running; if not, note it and continue).
- [ ] **Step 5: Commit** — `git commit -am "feat(playbook): mock Okta MCP server with branch fixtures and call log"`

---

### Task 10: Register mock server + LoaderMcpExecutor adapter

**Files:**
- Create: `backend/scripts/register_mock_okta.php`, `backend/src/Playbook/Adapters/LoaderMcpExecutor.php`
- Test: `backend/tests/Unit/Playbook/LoaderMcpExecutorTest.php` (unit with a Mockery MCPToolsLoader) + manual integration step

**Interfaces:**
- `LoaderMcpExecutor implements McpExecutorInterface`: constructor `(MCPToolsLoader $loader)` (already `loadToolsForUser`'d by the caller); `availableTools()` maps `$loader->getTools()` (shape: key `mcp_<tool>` → `['original_name','server_name','description','input_schema_json',…]`, see `MCPToolsLoader.php:114-127`) to `"<server_name_slug>.<original_name>"` keys, where `server_name_slug = strtolower(preg_replace('/[^a-z0-9]+/i','_',$server_name))`; `call($server,$tool,$args)` finds the entry whose slug+original match and invokes `$loader->executeTool('mcp_'.$tool, $args)`; a loader result with `['error'=>true]` maps to `['ok'=>false,'error'=>message]`, else `['ok'=>true,'result'=>$result]`. **First step of this task: read `backend/src/Services/MCPToolsLoader.php:31-235` and confirm these key names; adjust the adapter to what you read.**
- `register_mock_okta.php`: CLI script; **read `backend/src/Controllers/MCPServerController.php` first** and reuse its DB bootstrap + any existing "refresh tools" method to (1) upsert a row in `mcp_servers` (`name='Okta'`, `url='http://localhost/mockokta/'`, `user_id` from argv, `enabled=1`), (2) populate `mcp_server_tools` from the live `tools/list` (via the controller's refresh logic if it exists; otherwise insert the 7 rows directly with the schemas from Task 9). Idempotent (DELETE+INSERT by server id).

- [ ] **Step 1: Failing unit test** — Mockery `MCPToolsLoader` with `getTools()` returning one entry (`mcp_search_users` for server `Okta`); assert `availableTools()` has key `okta.search_users`; `call('okta','search_users',['email'=>'x'])` proxies to `executeTool('mcp_search_users', ['email'=>'x'])`.
- [ ] **Step 2: Run → FAIL.** **Step 3: Implement.** **Step 4: Run → PASS.**
- [ ] **Step 5: Integration (XAMPP running):** `php backend/scripts/register_mock_okta.php <your_user_id>` then a scratch script or `php -r` that instantiates the loader with the contexts PDO, `loadToolsForUser`, and executes `okta.search_users {email:'low@test'}` through `LoaderMcpExecutor` — expect text containing `u-low`. Record the output in the commit message body.
- [ ] **Step 6: Commit** — `git commit -am "feat(playbook): MCP executor adapter + mock Okta registration script"`

---

### Task 11: Validate endpoint (spec T4)

**Files:**
- Create: `backend/src/Controllers/PlaybookController.php`
- Modify: `backend/src/routes.php` (add `$r->post('/api/v1/playbooks/validate', ['PlaybookController', 'validate']);` next to the workflow routes)
- Test: `backend/tests/Unit/Playbook/PlaybookControllerTest.php`

**Interfaces:**
- **First step: read `backend/index.php` to see how `['Controller','method']` route entries are instantiated (constructor args, auth middleware, how request body and `user_id` reach the method) and mirror an existing simple controller (e.g. `MCPServerController`).**
- `validate(array $request): array` (match the codebase's controller signature): body `{playbook: object|string}` — string → `PlaybookDocument::fromConsoleText`, object → `fromArray`; build `availableTools` via `MCPToolsLoader(loadToolsForUser($userId))` + `LoaderMcpExecutor->availableTools()`; agents via a `SELECT name FROM agents WHERE user_id=?`; run `PlaybookAnalyzer`; respond `{valid: errors===[], actions, gates, checklist, errors, warnings}` with HTTP 200 (valid) / 422 (errors).
- Unit test: instantiate the controller with a Mockery-stubbed loader/PDO and assert the 422 path for a dangling binding and the 200 path for the MFA document with the 7 mock tools present.

- [ ] Steps: failing test → FAIL → implement → PASS → commit `feat(playbook): validate endpoint (registration-time analysis)`.

---

### Task 12: Server node runner + SSE endpoint + LLM/gate adapters

**Files:**
- Create: `backend/src/Playbook/Adapters/WorkflowLlmClient.php`, `backend/src/Playbook/Adapters/SkillBridgeGateBridge.php`, `backend/src/AgentTeam/Services/PlaybookNodeRunner.php`
- Modify: `backend/src/routes.php` (add `$r->post('/api/v1/workflows/playbook-node/run', ['AgentTeam:WorkflowController', 'runPlaybookNode']);`), `backend/src/AgentTeam/Controllers/WorkflowController.php` (new method)
- Test: `backend/tests/Unit/Playbook/PlaybookNodeRunnerTest.php`

**Interfaces:**
- `WorkflowLlmClient`: wraps one LLM round. **First step: read `backend/src/AgentTeam/Services/ParallelAgentExecutor.php` in full (esp. `dispatchChunk`, ~lines 160-320) and `GraphWorkflowRunner.php:1840-1880` (state shape: `['agent'=>Agent,'messages'=>…,'tools_filter'=>…]`) to learn the exact state fields and how tool definitions are attached; then implement** `__invoke(array $messages, array $toolDefs): array{text:?string,tool_calls:array}` by building a single-entry state for an inline `\AgentTeam\Models\Agent` (provider/model from the node config, instructions unused — the interpreter's system message travels in `$messages`), calling `runConcurrentRound`, and mapping `parsed['text']` / `parsed['tool_calls']` (normalize both `function.name/arguments` and flat `name/input` shapes to the interpreter contract, `arguments` json-decoded to array). If `dispatchChunk` derives tools from the agent rather than accepting them, pass `toolDefs` via the state field it reads (find it; likely `tools` or built via `buildToolsForParallelAgent`) — adjust and document in a code comment.
- `SkillBridgeGateBridge implements GateBridgeInterface`: constructor `(\Closure $emit)`; `ask()` generates `$toolCallId = SkillToolBridge::generateToolCallId()`, calls `($this->emit)(['type'=>'gate_request','tool_call_id'=>$toolCallId,'kind'=>$kind,'payload'=>$payload,'run_id'=>$runId])`, then `(new SkillToolBridge())->awaitResult($toolCallId, $timeoutMs)` and returns the posted array (the browser posts to the existing `/api/v1/workflows/tool-result`, which accepts any hex id — verify by reading `WorkflowController::toolResult` ~line 1003).
- `PlaybookNodeRunner`: `run(int $userId, array $nodeConfig, string $requestText, \Closure $emit): array{output:string, run_id:int, status:string}` — wires everything: parse document from `$nodeConfig['playbook']` (string or array), loader+`LoaderMcpExecutor`, analyzer (errors → throw `RuntimeException` with them), `PlaybookRunState` (contexts PDO + `PlaybookTranscript(WorkflowRunLog::defaultDir($config))`), `PlaybookNativeTools`, `GateManager(new SkillBridgeGateBridge($emit))`, `PlaybookActionSpace`, `PlaybookInterpreter($space,…, new WorkflowLlmClient($nodeConfig), 40, $emit)`, `runLeg(...)`; output = final text + `\n\n[playbook run {id}: {status}]`.
- `WorkflowController::runPlaybookNode`: SSE endpoint — **mirror the SSE header/flush pattern of an existing streaming method in this controller (read one first)**; body `{node_config, prompt}`; `$emit` writes `data: {json}\n\n` + flush; ends with `event: done` carrying the result JSON; errors → `event: error`.
- Unit test (`PlaybookNodeRunnerTest`): fakes for LLM + MCP + bridge (reuse Task 7/8 fakes), real SQLite state — assert a T1-shaped run through `PlaybookNodeRunner::run` returns status `resolved` and emits `gate_request` when the scripted LLM calls `request_approval` (fake bridge answers `approved`). Construct `PlaybookNodeRunner` with injected factories (constructor takes optional `$llmFactory`, `$mcpFactory`, `$bridgeFactory` closures defaulting to the real adapters) so the unit test never needs providers or MySQL.

- [ ] Steps: read the three referenced code regions → failing unit test → FAIL → implement adapters + runner + controller method + route → PASS → commit `feat(playbook): workflow playbook-node runner with SSE gates`.

---

### Task 13: Frontend — playbook node in the editor

**Files:**
- Modify: `frontend/assets/js/workflow-editor.js`, `frontend/index.html` (cache-buster)

**Interfaces:**
- Consumes: `POST /api/v1/workflows/playbook-node/run` (SSE, Task 12), `POST /api/v1/playbooks/validate` (Task 11), `POST /api/v1/workflows/tool-result` (existing).
- Produces: palette card `data-node-type="playbook"`; node config `{node_type:'playbook', playbook:<string>, agent_provider, model, name}`; `_runNodeAsPlaybookUnit(node, ctx)`; gate modal.

- [ ] **Step 1: Palette card** — in the sidebar template next to the Ingestion section (around line 335), add a "Playbooks" section with one card: icon 📖, name "Playbook", type "Console-style playbook"; register `'playbook'` wherever `_wfNodeKind` / node-type lists enumerate kinds (grep `'loader'` to find every list — mirror each).
- [ ] **Step 2: Config panel** — mirror the ingestion config modal pattern (`showIngestionConfigModal`): a textarea bound to `node.data.playbook` (accepts pasted Console text or JSON), provider+model selects reusing the agent node's control markup, and a **Validate** button that POSTs `{playbook}` to `/api/v1/playbooks/validate` and renders `errors` (red list), `warnings` (amber), and the classified `actions` table (name / kind / target).
- [ ] **Step 3: Run dispatch** — in `executeWorkflowInBrowser`'s per-node branch (the `else` calling `_runNodeAsChatUnit`, ~line 10545 region), route `this._wfNodeKind(id, nodes) === 'playbook'` to `await this._runNodeAsPlaybookUnit(node, ctx)`.
- [ ] **Step 4: `_runNodeAsPlaybookUnit`** — `fetch(apiBase + '/workflows/playbook-node/run', {method:'POST', headers: auth+json, body: JSON.stringify({node_config: node.data, prompt: ctx})})`, read the SSE body with a `ReadableStream` line parser (copy the pattern used for ingestion `run-stream` if present, else a minimal `res.body.getReader()` loop splitting on `\n\n`); events: `message`/`tool_result` → append to `nodeExecutionData[id].activity`; `gate_request` → `await this._showPlaybookGateModal(ev)` then `fetch(apiBase + '/workflows/tool-result', {method:'POST', body: JSON.stringify({tool_call_id: ev.tool_call_id, result: answer})})` (match the exact body shape of the existing dispatcher — grep `tool-result` in chat.js and copy it); `done` → resolve `{output, success:true}`; `error` → highlight red.
- [ ] **Step 5: Gate modal** — one function `_showPlaybookGateModal(ev)`: `kind==='form'` → render `payload.fields` as inputs (`sensitive` → `type=password`), submit returns `{fields:{…}}`; `kind==='approval'` → show `payload.question` + Approve/Deny buttons + comment box, returns `{decision:'approved'|'denied', comment, actor:'<current user email from profile>'}`; `kind==='handoff'` → show summary + "Done"/"Cancel" → `{decision:'handoff_done'|'cancelled'}`; `kind==='await_message'` → prompt + text box → `{text}`. Reuse the modal CSS classes of the ingestion modal.
- [ ] **Step 6: Bump the cache-buster** — in `frontend/index.html`, change `workflow-editor.js?v=…` to `?v=20260901-playbook-node`.
- [ ] **Step 7: Manual verify (browser, per memory: hard-refresh 2-3×)** — create a workflow `start → playbook → output`; paste the full MFA Reset playbook + bindings JSON; Validate shows the unbound `#Reset User Factors (Custom)` warning; Run with prompt "I'm low@test and I forgot my password — my answers are fluffy and paris" → node completes, output mentions the reset; check `playbook_run_ledger` rows in the DB.
- [ ] **Step 8: Commit** — `git commit -am "feat(playbook): editor node, validate UI, gate modals, SSE run"`

---

### Task 14: Acceptance pass T1–T5

**Files:**
- Create: `docs/superpowers/plans/2026-09-01-playbook-acceptance-results.md` (fill in actual outcomes)

- [ ] **Step 1:** `php backend/scripts/register_mock_okta.php <user_id>`; curl `_reset_call_log`.
- [ ] **Step 2 — T1:** browser run as in Task 13 step 7. Record: ledger tool order (must match spec T1), final status, absence of `to_channel` messages.
- [ ] **Step 3 — T2a/T2b:** prompt "I'm medium@test, locked out" → approval modal appears; approve → reset executes; re-run and deny → assert DM + `#sec-alerts` channel message + resolved, and **no** `okta.reset_password` in that run's ledger.
- [ ] **Step 4 — T3:** prompt "I'm high@test, lost my phone with Authenticator" → handoff modal; after `handoff_done`, the unbound factor-wipe action leads to a `skipped` ledger row + second handoff (per `on_unbound=handoff`) and a `#sec-alerts` message.
- [ ] **Step 5 — T4:** Validate with a binding to `okta.no_such_tool` → 422 with the action named.
- [ ] **Step 6 — T5:** unit suite already covers the replay guard (`PlaybookActionSpaceTest`); additionally rerun T1 and check `log/calls.jsonl` — one `reset_password` per run.
- [ ] **Step 7:** write outcomes into the results file (pass/fail per test, deviations); commit `docs(playbook): acceptance results for slices 1a+1b`. Any FAIL → fix before closing the task (systematic-debugging skill).

---

## Self-review (done at planning time)

- **Spec coverage:** document ✓T2, analyzer ✓T3/T11, run record+ledger+transcript ✓T4, native verbs ✓T5, whitelist/write-policy/replay ✓T6, A′ loop ✓T7, immediate gates ✓T8, mock MCP ✓T9-10, T4-test ✓T11, workflow context ✓T12-13, acceptance ✓T14. Deliberately deferred per spec: durable suspend/resume, `wait_until`, `escalate_to_playbook`, webhook/schedule triggers, server-qualified alias inside `MCPToolsLoader` (the adapter namespaces instead), LLM-proposed bindings, coverage report (checklist exists; diff report is slice 1d).
- **Placeholder scan:** the four "read X first" steps are verification steps against named files/lines with expected shapes stated — retained intentionally because those internals were only partially surveyed.
- **Type consistency:** `McpExecutorInterface.call(server,tool,args)` used by Tasks 6/10/12; analyzer action shape `{name,kind,target}` used by Tasks 6/11; LLM contract `{text,tool_calls:[{id,name,arguments}]}` used by Tasks 7/8/12 — consistent.
