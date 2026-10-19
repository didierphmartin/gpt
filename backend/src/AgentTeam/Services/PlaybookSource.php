<?php
declare(strict_types=1);

namespace AgentTeam\Services;

use PDO;
use Quantis\AIPortfolioAssistant\Playbook\PlaybookStore;
use Quantis\AIPortfolioAssistant\Services\RobotAccount;

/**
 * Playbook node "from input": the parent's output (JSON) names the playbook key;
 * it resolves to the robot's published copy, never the owner's draft.
 */
final class PlaybookSource
{
    public static function isFromInput(array $nodeConfig): bool
    {
        return ($nodeConfig['playbook_source'] ?? 'fixed') === 'input';
    }

    /** @return array{ok:true,key:string,text:string}|array{ok:false,reason:string} */
    public static function fromInput(PDO $db, int $ownerId, array $nodeConfig, string $parentText): array
    {
        $field = $nodeConfig['playbook_input_field'] ?? 'playbook';
        $field = is_string($field) && $field !== '' ? $field : 'playbook';
        $json = preg_replace('/\A## [^\n]*\n/', '', ltrim($parentText)) ?? $parentText;
        $data = json_decode(trim($json), true);
        $key = is_array($data) ? ($data[$field] ?? null) : null;
        if (!is_string($key) || !PlaybookStore::isValidKey($key)) {
            return ['ok' => false, 'reason' => 'bad_input'];
        }
        $store = new PlaybookStore($db);
        $robotId = RobotAccount::id($db);
        $row = $robotId === null ? null : $store->getByKey($robotId, $key);
        if ($row !== null) {
            return ['ok' => true, 'key' => $key, 'text' => (string) $row['text']];
        }
        return ['ok' => false, 'reason' => ($store->getByKey($ownerId, $key) !== null ? 'playbook_not_published:' : 'playbook_not_found:') . $key];
    }
}
