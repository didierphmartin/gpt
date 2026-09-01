<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Playbook;

/**
 * Whitelisted tool surface the LLM sees for one playbook run: native tools
 * plus a definition per bound/unbound analyzer action, with dispatch,
 * a replay guard for MCP calls, and a write-policy gate.
 */
final class PlaybookActionSpace
{
    private const WRITE_VERB_PATTERN = '/reset|create|update|delete|write|add|remove|assign|invite|unlock/i';

    private const UNBOUND_DESCRIPTION = 'NOT AVAILABLE — calling this applies the on_unbound policy';

    /** @var array<string,array{kind:string,action_name:string,server?:string,tool?:string,target?:?string}> */
    private array $map = [];

    /** @var array<string,array{kind:string,action_name:string,server?:string,tool?:string,target?:?string}> keyed by llm tool name, kind='mcp' entries only, used for building defs */
    private array $mcpEntries = [];

    /** @var array<string,array{action_name:string,note:string}> keyed by llm tool name, for unbound-style defs */
    private array $unboundEntries = [];

    public function __construct(
        private readonly array $analyzedActions,
        private readonly PlaybookNativeTools $native,
        private readonly McpExecutorInterface $mcp,
        private readonly PlaybookRunState $state,
        private readonly array $policy,
    ) {
        foreach ($analyzedActions as $action) {
            $name = (string)($action['name'] ?? '');
            $kind = (string)($action['kind'] ?? '');
            $target = $action['target'] ?? null;

            if ($kind === 'native' && $target !== null) {
                $this->map[$target] = [
                    'kind' => 'native',
                    'action_name' => $name,
                    'target' => $target,
                ];
                continue;
            }

            if ($kind === 'bound' && $target !== null && str_starts_with($target, 'agent.')) {
                // Bound agent.* targets are NOT implemented in this slice — no agent-invocation
                // dispatch exists yet. Treat them like unbound for now (honest handle + on_unbound
                // policy at execution time); real agent invocation arrives in a later slice.
                $llmName = 'unbound__' . $this->slug($name);
                $this->unboundEntries[$llmName] = [
                    'action_name' => $name,
                    'note' => 'NOT AVAILABLE — agent invocation arrives in a later slice; the on_unbound policy applies for now',
                ];
                $this->map[$llmName] = [
                    'kind' => 'unbound',
                    'action_name' => $name,
                    'target' => $target,
                ];
                continue;
            }

            if ($kind === 'bound' && $target !== null) {
                [$server, $tool] = $this->splitTarget($target);
                $llmName = $this->sanitizeTarget($target);
                $entry = [
                    'kind' => 'mcp',
                    'action_name' => $name,
                    'server' => $server,
                    'tool' => $tool,
                    'target' => $target,
                ];
                $this->map[$llmName] = $entry;
                $this->mcpEntries[$llmName] = $entry;
                continue;
            }

            // kind === 'unbound' (or anything else we don't recognize as bound/native)
            $llmName = 'unbound__' . $this->slug($name);
            $this->unboundEntries[$llmName] = [
                'action_name' => $name,
                'note' => self::UNBOUND_DESCRIPTION,
            ];
            $this->map[$llmName] = [
                'kind' => 'unbound',
                'action_name' => $name,
                'target' => $target,
            ];
        }
    }

    public function toolDefinitions(): array
    {
        $defs = $this->native->definitions();
        $available = $this->mcp->availableTools();

        foreach ($this->mcpEntries as $llmName => $entry) {
            $toolInfo = $available[$entry['target']] ?? null;
            $mcpDescription = $toolInfo['description'] ?? '';
            $parameters = $toolInfo['input_schema'] ?? ['type' => 'object', 'properties' => []];

            $description = trim($entry['action_name'] . ($mcpDescription !== '' ? ' — ' . $mcpDescription : ''));

            $defs[] = [
                'type' => 'function',
                'function' => [
                    'name' => $llmName,
                    'description' => $description,
                    'parameters' => $parameters,
                ],
            ];
        }

        foreach ($this->unboundEntries as $llmName => $entry) {
            $defs[] = [
                'type' => 'function',
                'function' => [
                    'name' => $llmName,
                    'description' => trim($entry['action_name'] . ': ' . $entry['note']),
                    'parameters' => ['type' => 'object', 'properties' => []],
                ],
            ];
        }

        return $defs;
    }

    public function execute(int $runId, int $leg, string $llmToolName, array $args): array
    {
        $entry = $this->map[$llmToolName] ?? null;

        if ($entry === null) {
            $this->state->ledgerAppend($runId, $leg, $llmToolName, $llmToolName, $args, 'skipped', null);
            return ['ok' => false, 'error' => 'tool not allowed'];
        }

        return match ($entry['kind']) {
            'native' => $this->executeNative($runId, $leg, $llmToolName, $entry, $args),
            'mcp' => $this->executeMcp($runId, $leg, $entry, $args),
            'unbound' => $this->executeUnbound($runId, $leg, $entry, $args),
            default => (function () use ($runId, $leg, $llmToolName, $args) {
                $this->state->ledgerAppend($runId, $leg, $llmToolName, $llmToolName, $args, 'skipped', null);
                return ['ok' => false, 'error' => 'tool not allowed'];
            })(),
        };
    }

    private function executeNative(int $runId, int $leg, string $llmToolName, array $entry, array $args): array
    {
        $result = $this->native->execute($runId, $leg, $llmToolName, $args);
        $outcome = ($result['ok'] ?? false) === false ? 'failed' : 'ok';
        $this->state->ledgerAppend($runId, $leg, $entry['action_name'], $llmToolName, $args, $outcome, $this->summarize($result));
        return $result;
    }

    private function executeMcp(int $runId, int $leg, array $entry, array $args): array
    {
        $target = $entry['target'];
        $server = $entry['server'];
        $tool = $entry['tool'];

        $replay = $this->state->ledgerFindOk($runId, $target, $args);
        if ($replay !== null) {
            $this->state->ledgerAppend($runId, $leg, $entry['action_name'], $target, $args, 'replayed', $replay['result_summary']);
            return ['ok' => true, 'outcome' => 'replayed', 'result' => $replay['result_summary']];
        }

        $writesEnabled = (bool)($this->policy['writes_enabled'] ?? false);
        if (!$writesEnabled && preg_match(self::WRITE_VERB_PATTERN, $tool) === 1) {
            $this->state->ledgerAppend($runId, $leg, $entry['action_name'], $target, $args, 'skipped', null);
            return ['ok' => false, 'error' => 'writes disabled by policy'];
        }

        $result = $this->mcp->call($server, $tool, $args);
        $outcome = ($result['ok'] ?? false) === false ? 'failed' : 'ok';
        $this->state->ledgerAppend($runId, $leg, $entry['action_name'], $target, $args, $outcome, $this->summarize($result));
        return $result;
    }

    private function executeUnbound(int $runId, int $leg, array $entry, array $args): array
    {
        $llmName = 'unbound__' . $this->slug($entry['action_name']);
        $this->state->ledgerAppend($runId, $leg, $entry['action_name'], $llmName, $args, 'skipped', null);
        return [
            'ok' => false,
            'unbound' => true,
            'policy' => $this->policy['on_unbound'] ?? null,
            'guidance' => 'This action has no connected implementation. Follow the policy: hand off to a human with prompt_handoff and note what could not be done.',
        ];
    }

    /** @return array{0:string,1:string} */
    private function splitTarget(string $target): array
    {
        $parts = explode('.', $target, 2);
        return [$parts[0], $parts[1] ?? ''];
    }

    private function sanitizeTarget(string $target): string
    {
        $sanitized = str_replace('.', '__', $target);
        $sanitized = preg_replace('/[^a-z0-9_]+/i', '_', $sanitized);
        return strtolower($sanitized);
    }

    private function slug(string $name): string
    {
        $slug = preg_replace('/[^a-z0-9]+/i', '_', $name);
        return trim(strtolower($slug), '_');
    }

    private function summarize(array $result): ?string
    {
        $json = json_encode($result, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        if ($json === false) {
            return null;
        }
        return strlen($json) > 500 ? substr($json, 0, 500) : $json;
    }
}
