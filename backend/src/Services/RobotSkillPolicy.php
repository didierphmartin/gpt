<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Services;

use AgentTeam\Services\WorkflowGraphAnalyzer;
use PDO;

/**
 * In the corporate edition (volume mode) the robot uses public skills only. Matching is on the skill's leaf name,
 * as everywhere in the store.
 */
final class RobotSkillPolicy
{
    public const MESSAGE = 'This workflow uses private skills. The robot can only use public skills.';

    public function __construct(private readonly PDO $db, private readonly array $config, private readonly ?SkillStore $store)
    {
    }

    /** The 409 every refusal answers with. @param list<array{path:string,owner_id:int,owner_name:string,missing?:true}> $skills */
    public static function refusal(array $skills): array
    {
        return ['success' => false, 'code' => 'private_skills', 'message' => self::MESSAGE,
            'error' => self::MESSAGE, 'data' => ['skills' => $skills], 'status_code' => 409];
    }

    /** @return list<array{path:string,owner_id:int,owner_name:string,missing?:true}> empty unless corporate + volume mode */
    public function privateSkills(int $workflowId): array
    {
        $robot = RobotAccount::id($this->db);
        if ($this->store === null || $robot === null || !Edition::isCorporate($this->config)) {
            return [];
        }
        $public = [];
        foreach ($this->store->list($robot, true) as $row) {
            $public[basename($row['path'])] = true;
        }
        $out = [];
        foreach ($this->boundSkills($workflowId) as $dir) {
            $leaf = basename($dir);
            if (isset($public[$leaf]) || isset($out[$leaf])) {
                continue;
            }
            $found = $this->store->findPrivate($leaf);
            $out[$leaf] = ['path' => $found['path'] ?? $dir, 'owner_id' => $found['owner_id'] ?? 0,
                'owner_name' => $found === null ? '' : $this->ownerName($found['owner_id'])]
                + ($found === null ? ['missing' => true] : []);
        }
        return array_values($out);
    }

    /** privateSkills() for a workflow run on behalf of $ownerId: only the robot's runs are held to public skills. */
    public function privateSkillsForOwner(int $ownerId, int $workflowId): array
    {
        return RobotAccount::id($this->db) === $ownerId ? $this->privateSkills($workflowId) : [];
    }

    /** @return list<array{id:int,name:string}> the robot's workflows whose nodes bind the skill $leafName */
    public function robotWorkflowsUsing(string $leafName): array
    {
        $robot = RobotAccount::id($this->db);
        if ($robot === null) {
            return [];
        }
        $st = $this->db->prepare('SELECT w.id, w.name, n.config FROM agent_workflows w JOIN workflow_nodes n ON n.workflow_id = w.id
            WHERE w.user_id = ? ORDER BY w.name, w.id');
        $st->execute([$robot]);
        $out = [];
        foreach ($st->fetchAll(PDO::FETCH_ASSOC) as $r) {
            foreach (self::dirs((string) $r['config']) as $dir) {
                if (basename($dir) === $leafName) {
                    $out[(int) $r['id']] = ['id' => (int) $r['id'], 'name' => (string) $r['name']];
                }
            }
        }
        return array_values($out);
    }

    /** @return list<string> */
    private function boundSkills(int $workflowId): array
    {
        $st = $this->db->prepare('SELECT config FROM workflow_nodes WHERE workflow_id = ?');
        $st->execute([$workflowId]);
        $dirs = [];
        foreach ($st->fetchAll(PDO::FETCH_COLUMN) as $config) {
            array_push($dirs, ...self::dirs((string) $config));
        }
        return $dirs;
    }

    /** @return list<string> */
    private static function dirs(string $config): array
    {
        $cfg = json_decode($config, true);
        $dirs = [];
        foreach (is_array($cfg) ? WorkflowGraphAnalyzer::skillsFromConfig($cfg) : [] as $s) {
            if (isset($s['dir'])) {
                $dirs[] = $s['dir'];
            }
        }
        return $dirs;
    }

    private function ownerName(int $userId): string
    {
        $st = $this->db->prepare('SELECT first_name, last_name FROM users WHERE id = ?');
        $st->execute([$userId]);
        $r = $st->fetch(PDO::FETCH_ASSOC);
        return $r ? trim($r['first_name'] . ' ' . $r['last_name']) : '';
    }
}
