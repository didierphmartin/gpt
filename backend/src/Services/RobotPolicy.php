<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Services;

use PDO;

/** Who may use (publish to, read) and manage (unpublish from) the robot: everyone on Individual; else by role. */
final class RobotPolicy
{
    private PackageResolver $resolver;

    public function __construct(PDO $db, private readonly array $config)
    {
        $this->resolver = new PackageResolver($db);
    }

    public function canUse(int $userId): bool
    {
        if (Edition::current($this->config) === 'individual') {
            return true;
        }
        return ($this->resolver->resolveForUser($userId)['capabilities']['use_robot'] ?? false) === true;
    }

    public function canManage(int $userId): bool
    {
        return Edition::current($this->config) === 'individual' || $this->resolver->resolveRole($userId) === 'admin';
    }
}
