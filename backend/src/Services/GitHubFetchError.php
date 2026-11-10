<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Services;

/** A GitHub import failure: an HTTP status for the caller plus a user-facing message. */
final class GitHubFetchError extends \RuntimeException
{
    public function __construct(public readonly int $status, string $message)
    {
        parent::__construct($message);
    }
}
