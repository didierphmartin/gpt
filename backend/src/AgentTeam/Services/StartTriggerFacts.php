<?php

declare(strict_types=1);

namespace AgentTeam\Services;

use PDO;
use PDOException;
use RuntimeException;

/**
 * The Start's mode as a compiled program bakes it (spec 2026-10-15 §2): the Start option's trigger node
 * (the hidden code node StartOptionGraph adds), its event trigger, the workflow's schedule. Read at compile
 * time only; the program never reads the database. Same rules as LangGraphGenerator::analyzeForEmit, which
 * keeps its own copy.
 */
final class StartTriggerFacts
{
    /**
     * @param array $orderedNodes nodes in topological order (each with config)
     * @param array $serverSlugs  url => slug of the servers this workflow uses
     * @return array{startMode:string, defaultCron:?string, defaultWatch:?array, triggerNodeId:?string}
     */
    public static function of(?PDO $db, int $workflowId, array $orderedNodes, array $serverSlugs): array
    {
        $triggerNodeId = null;
        $startTrigger = null;
        foreach ($orderedNodes as $node) {
            $st = ($node['config'] ?? [])['start_trigger'] ?? null;
            if (WorkflowGraphAnalyzer::typeOf($node) === 'code' && is_array($st)) {
                $triggerNodeId = (string) $node['id'];
                $startTrigger = $st;
                break;
            }
        }
        $defaultCron = self::defaultCron($db, $workflowId);
        $slugs = array_values($serverSlugs);
        return [
            'startMode' => $startTrigger !== null ? 'watch' : ($defaultCron !== null ? 'cron' : 'prompt'),
            'defaultCron' => $defaultCron,
            'defaultWatch' => $startTrigger !== null
                ? self::watchFromTrigger((array) ($startTrigger['watch'] ?? []), $slugs)
                : self::defaultWatch($db, $workflowId, $slugs),
            'triggerNodeId' => $triggerNodeId,
        ];
    }

    private static function defaultCron(?PDO $db, int $workflowId): ?string
    {
        if ($db === null) {
            return null;
        }
        try {
            $stmt = $db->prepare("SELECT cron FROM scheduled_workflows WHERE workflow_id = ? AND repeat_type = 'cron' AND status <> 'paused' ORDER BY id DESC LIMIT 1");
            $stmt->execute([$workflowId]);
            $c = $stmt->fetchColumn();
            return is_string($c) && $c !== '' ? $c : null;
        } catch (PDOException) {
            return null;   // no schedules table, or one without the cron column: no default
        }
    }

    private static function defaultWatch(?PDO $db, int $workflowId, array $slugs): ?array
    {
        if ($db === null) {
            return null;
        }
        try {
            $stmt = $db->prepare("SELECT event_trigger FROM scheduled_workflows WHERE workflow_id = ? AND repeat_type = 'event' AND status <> 'paused' ORDER BY id DESC LIMIT 1");
            $stmt->execute([$workflowId]);
            $raw = $stmt->fetchColumn();
        } catch (PDOException) {
            return null;   // no schedules table, or one without the event_trigger column: no default
        }
        $t = is_string($raw) ? json_decode($raw, true) : null;
        return is_array($t) ? self::watchFromTrigger($t, $slugs) : null;
    }

    /** {server (a name), tool, args} as DEFAULT_WATCH with the server slugged; a server the workflow does not use is an error. */
    private static function watchFromTrigger(array $t, array $slugs): ?array
    {
        if (trim((string) ($t['server'] ?? '')) === '' || trim((string) ($t['tool'] ?? '')) === '') {
            return null;
        }
        $slug = CodeNodeEmit::slug((string) $t['server']);
        if (!in_array($slug, $slugs, true)) {
            throw new RuntimeException('The event trigger waits on MCP server "' . $t['server'] . '", which no node of this'
                . ' workflow uses; check it on the node that polls it (e.g. the code node calling poll_new_mail).');
        }
        return ['server' => $slug, 'tool' => (string) $t['tool'], 'args' => is_array($t['args'] ?? null) ? $t['args'] : []];
    }
}
