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
