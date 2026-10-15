<?php
declare(strict_types=1);

namespace AgentTeam\Services;

/** A refused activation (spec 2026-10-14 event-worker §2): kind for the editor, status for the API. */
final class ActiveWorkflowError extends \RuntimeException
{
    public function __construct(public readonly string $kind, string $message, public readonly int $status)
    {
        parent::__construct($message);
    }
}
