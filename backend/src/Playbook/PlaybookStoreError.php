<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Playbook;

/** A refused collection operation: kind (not_found, invalid_text, invalid_key, key_taken, in_use, replaces), its HTTP status, and optional data for the client. */
final class PlaybookStoreError extends \RuntimeException
{
    public function __construct(public readonly string $kind, string $message, public readonly int $status, public readonly array $data = [])
    {
        parent::__construct($message);
    }
}
