<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Playbook;

use PDO;

/**
 * One-time move of playbook text from playbook agents and playbook workflow nodes into the
 * playbook collection. Runs in one transaction: committed when $write, rolled back otherwise
 * (a dry run), so the report is the same either way.
 */
class PlaybookMigration
{
    private PlaybookStore $store;
    private array $report;

    public function __construct(private readonly PDO $db)
    {
        $this->store = new PlaybookStore($db);
    }

    public function run(bool $write): array
    {
        $this->report = ['created' => [], 'suffixed' => [], 'dropped_bindings' => [],
            'dropped_policy' => [], 'agents_linked' => 0, 'nodes_linked' => 0, 'errors' => []];
        $this->db->beginTransaction();
        try {
            $this->migrateAgents();
            $this->migrateNodes();
        } catch (\Throwable $e) {
            $this->db->rollBack();
            throw $e;
        }
        $write ? $this->db->commit() : $this->db->rollBack();
        return $this->report;
    }

    private function migrateAgents(): void
    {
        $rows = $this->db->query("SELECT id, user_id, name, instructions FROM agents
            WHERE agent_type = 'playbook' AND playbook_id IS NULL AND instructions IS NOT NULL AND TRIM(instructions) <> ''
            ORDER BY id")->fetchAll(PDO::FETCH_ASSOC);
        $upd = $this->db->prepare("UPDATE agents SET playbook_id = ?, instructions = '' WHERE id = ?");
        foreach ($rows as $r) {
            $from = "agent #{$r['id']} \"{$r['name']}\"";
            $pb = $this->create((int) $r['user_id'], (string) $r['instructions'], $from);
            if ($pb === null) continue;
            $upd->execute([$pb, $r['id']]);
            $this->report['agents_linked']++;
        }
    }

    private function migrateNodes(): void
    {
        $rows = $this->db->query("SELECT n.id, n.agent_id, n.config, w.user_id, w.name AS wname
            FROM workflow_nodes n JOIN agent_workflows w ON w.id = n.workflow_id
            WHERE n.node_type = 'playbook' ORDER BY n.id")->fetchAll(PDO::FETCH_ASSOC);
        $upd = $this->db->prepare('UPDATE workflow_nodes SET config = ? WHERE id = ?');
        foreach ($rows as $r) {
            $cfg = json_decode((string) $r['config'], true);
            if (!is_array($cfg) || !empty($cfg['playbook_id'])) continue;
            $owner = (int) $r['user_id'];
            $from = "node #{$r['id']} \"" . ($cfg['name'] ?? 'Playbook') . "\" in workflow \"{$r['wname']}\"";
            // The config's agent_id, else the node row's agent_id column.
            $pb = $this->agentPlaybook($owner, (int) ($cfg['agent_id'] ?? $r['agent_id'] ?? 0));
            if ($pb === null) {
                $runSettings = [];
                $pb = $this->fromNodePlaybook($owner, $cfg['playbook'] ?? null, $from, $runSettings);
                if ($pb === null) continue;
                $cfg = $runSettings + $cfg; // policy / approvers of a JSON playbook: run settings live on the node
            }
            unset($cfg['playbook'], $cfg['playbook_missing']);
            $cfg['playbook_id'] = $pb;
            $upd->execute([json_encode($cfg, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), $r['id']]);
            $this->report['nodes_linked']++;
            $this->nodeLinked((int) $r['id']);
        }
    }

    /** Hook after each node is linked (a test seam; does nothing). */
    protected function nodeLinked(int $nodeId): void {}

    /** The playbook already linked to the owner's own agent (migrated above or linked before); null for another user's agent. */
    private function agentPlaybook(int $owner, int $agentId): ?int
    {
        if ($agentId === 0) return null;
        $st = $this->db->prepare('SELECT playbook_id FROM agents WHERE id = ? AND user_id = ? AND playbook_id IS NOT NULL');
        $st->execute([$agentId, $owner]);
        $v = $st->fetchColumn();
        return $v === false ? null : (int) $v;
    }

    private const DEFAULT_POLICY = ['writes_enabled' => false, 'on_unbound' => 'handoff', 'on_failure' => 'continue_then_handoff'];

    /** The collection playbook for a node's own playbook; a JSON one with a non-default policy or approvers
     *  reports them (dropped_policy) and hands them back in $runSettings for the node config. */
    private function fromNodePlaybook(int $owner, mixed $playbook, string $from, array &$runSettings = []): ?int
    {
        if (is_array($playbook)) {
            try {
                $doc = PlaybookDocument::fromArray($playbook);
            } catch (\InvalidArgumentException $e) {
                $this->report['errors'][] = ['from' => $from, 'error' => $e->getMessage()];
                return null;
            }
            foreach ($doc->bindings as $action => $tool) {
                if ($tool !== null && $tool !== '') {
                    $this->report['dropped_bindings'][] = ['title' => $doc->title, 'action' => (string) $action, 'tool' => (string) $tool];
                }
            }
            if ($doc->policy != self::DEFAULT_POLICY || $doc->approvers !== []) {
                $this->report['dropped_policy'][] = ['title' => $doc->title, 'policy' => $doc->policy, 'approvers' => $doc->approvers];
                $runSettings = ['policy' => $doc->policy, 'approvers' => $doc->approvers];
            }
            return $this->create($owner, self::render($doc), $from);
        }
        if (!is_string($playbook) || trim($playbook) === '') {
            $this->report['errors'][] = ['from' => $from, 'error' => 'The node has no playbook text.'];
            return null;
        }
        return $this->create($owner, $playbook, $from);
    }

    private static function render(PlaybookDocument $d): string
    {
        $out = "Title: {$d->title}\nTrigger: {$d->trigger['description']}\nInstructions:\n{$d->instructions}\n"
            . 'Tools used: ' . implode('; ', $d->toolsUsed) . "\n"
            . 'Actions used: ' . implode('; ', $d->actionsUsed) . "\n";
        return $d->domain === '' ? $out : $out . "Domain: {$d->domain}\n";
    }

    /** Create the playbook (key from the title, suffixed on a clash); null and an error entry when the text does not parse. */
    private function create(int $userId, string $text, string $from): ?int
    {
        try {
            $title = PlaybookDocument::fromConsoleText($text)->title;
        } catch (\InvalidArgumentException $e) {
            $this->report['errors'][] = ['from' => $from, 'error' => $e->getMessage()];
            return null;
        }
        $base = PlaybookStore::keyFromTitle($title);
        $key = $this->store->freeKey($userId, $base);
        $row = $this->store->save($userId, null, $text, $key);
        if ($key !== $base) {
            $this->report['suffixed'][] = ['title' => $title, 'pkey' => $key];
        }
        $this->report['created'][] = ['user_id' => $userId, 'pkey' => $key, 'title' => $title, 'from' => $from];
        return $row['id'];
    }
}
