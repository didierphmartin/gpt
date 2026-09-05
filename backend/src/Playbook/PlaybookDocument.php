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
        public readonly string $domain = '',
    ) {}

    public static function fromArray(array $a): self
    {
        $title = trim((string)($a['title'] ?? ''));
        $instructions = trim((string)($a['instructions'] ?? ''));
        if ($title === '' || $instructions === '') {
            $missing = array_keys(array_filter(['title' => $title === '', 'instructions' => $instructions === '']));
            throw new \InvalidArgumentException(
                'Playbook JSON is missing the required "' . implode('" and "', $missing) . '" field'
                . (count($missing) > 1 ? 's' : '') . ' (or it is empty).'
            );
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
            trim((string)($a['domain'] ?? '')),
        );
    }

    /** Section header: optional "1." / "-" / "##" / "**" prefix, keyword, colon. */
    public const SECTION_HEADER_RE = '/^\s*(\d+[.)]|[-*•]|#{1,6})?\s*\**(Title|Trigger|Instructions|Tools used|Actions used|Domain)\**\s*:\**\s*(.*)$/i';

    /** Parse the Console library format: "Title: …", "Trigger: …", "Instructions: …", "Tools used: a; b", "Actions used: #A; #B". */
    public static function fromConsoleText(string $text): self
    {
        $sections = ['title' => '', 'trigger' => '', 'instructions' => '', 'tools used' => '', 'actions used' => '', 'domain' => ''];
        $current = null;
        foreach (preg_split('/\r?\n/', $text) as $line) {
            // Tolerate a list marker / markdown heading / bold before the keyword
            // ("1. Instructions: …", "## Title: …", "**Trigger:** …"). A numeric
            // marker is kept in the section body so the author's step 1 survives.
            if (preg_match(self::SECTION_HEADER_RE, $line, $m)) {
                $current = strtolower($m[2]);
                $marker = preg_match('/^\d/', $m[1]) ? $m[1] . ' ' : '';
                $sections[$current] = $m[3] === '' ? '' : $marker . $m[3];
            } elseif ($current !== null) {
                $sections[$current] .= "\n" . $line;
            }
        }
        $semiList = fn(string $s): array => array_values(array_filter(array_map('trim', explode(';', $s)), fn($x) => $x !== ''));
        // Name the missing section(s) and what WAS recognized, so an author
        // can spot the header they mistyped ("Instruction:", "Steps:", …).
        $missing = [];
        if (trim($sections['title']) === '') $missing[] = 'Title';
        if (trim($sections['instructions']) === '') $missing[] = 'Instructions';
        if ($missing !== []) {
            $found = [];
            foreach (['title' => 'Title', 'trigger' => 'Trigger', 'instructions' => 'Instructions',
                      'tools used' => 'Tools used', 'actions used' => 'Actions used', 'domain' => 'Domain'] as $k => $label) {
                if (trim($sections[$k]) !== '') $found[] = $label;
            }
            throw new \InvalidArgumentException(sprintf(
                'Missing "%s:" section. Recognized sections: %s. Each section must start on its own line as "%s: …" '
                . '(a list number, "##" or "**" before the keyword is fine).',
                implode(':" and "', $missing),
                $found === [] ? 'none' : implode(', ', $found),
                $missing[0]
            ));
        }
        return self::fromArray([
            'title' => trim($sections['title']),
            'trigger' => ['kind' => 'request', 'description' => trim($sections['trigger'])],
            'instructions' => trim($sections['instructions']),
            'tools_used' => $semiList($sections['tools used']),
            'actions_used' => $semiList($sections['actions used']),
            'domain' => trim($sections['domain']),
        ]);
    }

    public function toArray(): array
    {
        return [
            'title' => $this->title, 'trigger' => $this->trigger,
            'instructions' => $this->instructions, 'tools_used' => $this->toolsUsed,
            'actions_used' => $this->actionsUsed, 'bindings' => $this->bindings,
            'policy' => $this->policy, 'approvers' => $this->approvers,
            'domain' => $this->domain,
        ];
    }
}
