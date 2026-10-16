<?php

declare(strict_types=1);

namespace AgentTeam\Services;

use PDO;
use Quantis\AIPortfolioAssistant\Services\DecisionProviders;

/**
 * A dispatcher's decision-model routing as a compiled program bakes it, read at compile time only (the
 * program never reads the database): its decision question, routing mode, unclear branch, confidence floor
 * and the decision providers it may call. Same rules as LangGraphGenerator (which keeps its own copy) and
 * GraphWorkflowRunner: the saved agent record's name, description and settings when the node references one,
 * else the node's own.
 */
final class DispatcherDecisionFacts
{
    /**
     * @return array{decision_question:string, routing_mode:string, unclear_branch:string, min_confidence:float,
     *               decision:list<array{provider:string, protocol:string, url:string, model:string, key_env:string, url_env:string}>}
     */
    public static function of(?PDO $db, ?AgentRepository $agentRepo, array $node, string $wfName): array
    {
        $cfg = is_array($node['config'] ?? null) ? $node['config'] : [];
        $name = (string) ($cfg['agent_name'] ?? $cfg['name'] ?? ($node['name'] ?? ''));
        $desc = (string) ($cfg['description'] ?? '');
        $settings = is_array($cfg['settings'] ?? null) ? $cfg['settings'] : [];
        $agentId = $node['agent_id'] ?? ($cfg['agent_id'] ?? null);
        if ($agentRepo !== null && $agentId !== null && $agentId !== '') {
            try {
                $agent = $agentRepo->findById((int) $agentId);
            } catch (\Throwable) {
                $agent = null;
            }
            if ($agent !== null) {
                $a = $agent->toArray();
                if (trim((string) ($a['name'] ?? '')) !== '') {
                    $name = (string) $a['name'];
                }
                if (trim((string) ($a['description'] ?? '')) !== '') {
                    $desc = (string) $a['description'];
                }
                $rec = $a['settings'] ?? [];
                $rec = is_string($rec) ? json_decode($rec, true) : $rec;
                $settings = is_array($rec) ? $rec : [];
            }
        }
        $mode = trim((string) ($settings['routing_mode'] ?? ''));
        $floor = $settings['min_confidence'] ?? $settings['jev_min_confidence'] ?? null;
        return [
            'decision_question' => DispatchRouting::defaultInstructions($name, $desc, $wfName),
            'routing_mode' => $mode,
            'unclear_branch' => trim((string) ($settings['unclear_branch'] ?? '')),
            'min_confidence' => is_numeric($floor) ? max(0.0, min(1.0, (float) $floor)) : JevRouter::DEFAULT_CONFIDENCE_FLOOR,
            'decision' => $db === null ? [] : self::candidates($db, $mode),
        ];
    }

    /** The named provider row, every usable row (admin order) for an unset mode, none for 'llm'. */
    private static function candidates(PDO $db, string $mode): array
    {
        if ($mode === 'llm') {
            return [];
        }
        $out = [];
        try {
            $rows = DecisionProviders::rows($db);
        } catch (\Throwable) {
            return [];   // no decision provider table: nothing to route with
        }
        foreach ($rows as $row) {
            $key = (string) $row['provider_key'];
            $protocol = DecisionProviders::protocolOf($row);
            if ($protocol === null || ($mode !== '' && $key !== $mode)) {
                continue;
            }
            $stem = DecisionProviders::envStem($key);
            $out[] = [
                'provider' => $key,
                'protocol' => (string) $row['protocol'],
                'url' => trim((string) ($row['base_url'] ?? '')) ?: $protocol['url'],
                'model' => trim((string) ($row['model'] ?? '')) ?: $protocol['model'],
                'key_env' => $stem . '_API_KEY',
                'url_env' => $stem . '_BASE_URL',
            ];
        }
        return $out;
    }
}
