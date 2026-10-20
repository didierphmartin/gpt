<?php
declare(strict_types=1);
namespace AgentTeam\Services;

/** A workflow graph names playbooks, components or exits that do not exist for its owner. */
final class UnresolvedRefsException extends \RuntimeException
{
    /** @param list<string> $missing */
    public function __construct(public readonly array $missing)
    {
        parent::__construct('unknown references: ' . implode('; ', $missing));
    }
}
