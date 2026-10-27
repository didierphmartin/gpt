<?php
declare(strict_types=1);

namespace AgentTeam\Services;

/** A refused publish to the robot (task B2): kind (not_found, replaces, ...) for the editor, status for the API. */
final class WorkflowPublishError extends \RuntimeException
{
    public function __construct(public readonly string $kind, string $message, public readonly int $status)
    {
        parent::__construct($message);
    }
}
