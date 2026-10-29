<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Controllers;

use PDO;
use Quantis\AIPortfolioAssistant\Playbook\PlaybookStore;
use Quantis\AIPortfolioAssistant\Playbook\PlaybookStoreError;
use Quantis\AIPortfolioAssistant\Services\Edition;
use Quantis\AIPortfolioAssistant\Services\RobotAccount;
use Quantis\AIPortfolioAssistant\Services\RobotPolicy;

/** /api/v1/robot — the robot account's status and its published playbooks. */
final class RobotController
{
    private RobotPolicy $policy;

    public function __construct(private readonly PDO $db, private readonly array $config)
    {
        $this->policy = new RobotPolicy($db, $config);
    }

    public function show(array $request): array
    {
        return $this->guard($request, function (int $u) {
            RobotAccount::ensure($this->db);
            return ['success' => true, 'data' => [
                'exists' => true,
                'name' => RobotAccount::NAME,
                'can_use' => $this->policy->canUse($u),
                'can_manage' => $this->policy->canManage($u),
                'edition' => Edition::current($this->config),
            ]];
        });
    }

    public function playbooks(array $request): array
    {
        return $this->guard($request, function (int $u) {
            $this->requireAccess($u);
            return ['success' => true, 'data' => (new PlaybookStore($this->db))->robotList(RobotAccount::ensure($this->db))];
        });
    }

    public function unpublish(array $request): array
    {
        return $this->guard($request, function (int $u) use ($request) {
            $this->requireAccess($u);
            (new PlaybookStore($this->db))->unpublish(RobotAccount::ensure($this->db), (int) ($request['params']['id'] ?? 0));
            return ['success' => true];
        });
    }

    private function requireAccess(int $userId): void
    {
        if (!$this->policy->canUse($userId) && !$this->policy->canManage($userId)) {
            throw new PlaybookStoreError('forbidden', "Your role can't use the robot", 403);
        }
    }

    private function guard(array $request, \Closure $action): array
    {
        $userId = (int) ($request['user_id'] ?? 0);
        if ($userId <= 0) {
            return ['success' => false, 'error' => 'Authentication required', 'kind' => 'auth', 'status_code' => 401];
        }
        try {
            return $action($userId);
        } catch (PlaybookStoreError $e) {
            return ['success' => false, 'error' => $e->getMessage(), 'kind' => $e->kind, 'status_code' => $e->status];
        }
    }
}
