<?php
declare(strict_types=1);

namespace AgentTeam\Services;

/** A refused Owner -> Robot transfer: kind (forbidden, not_found, clash) for the editor, status for the API. */
final class WorkflowTransferError extends \RuntimeException
{
    /** @param array<array{kind: string, name: string}> $clashes the robot's rows in the way (kind clash) */
    public function __construct(public readonly string $kind, string $message, public readonly int $status,
        public readonly array $clashes = [])
    {
        parent::__construct($message);
    }
}
