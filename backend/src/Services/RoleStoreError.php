<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Services;

/** A refused role operation: kind (invalid_key, invalid_name, exists, not_found, builtin, in_use) and its HTTP status. */
final class RoleStoreError extends \RuntimeException
{
    public function __construct(public readonly string $kind, string $message, public readonly int $status)
    {
        parent::__construct($message);
    }
}
