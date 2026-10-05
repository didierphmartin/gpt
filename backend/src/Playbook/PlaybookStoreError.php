<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Playbook;

/** A refused collection operation: kind (not_found, invalid_text, invalid_key, key_taken, in_use) and its HTTP status. */
final class PlaybookStoreError extends \RuntimeException
{
    public function __construct(public readonly string $kind, string $message, public readonly int $status)
    {
        parent::__construct($message);
    }
}
