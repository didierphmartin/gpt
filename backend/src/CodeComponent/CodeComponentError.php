<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\CodeComponent;

/** A refused collection operation: kind (not_found, invalid, name_taken, in_use) and its HTTP status. */
final class CodeComponentError extends \RuntimeException
{
    public function __construct(public readonly string $kind, string $message, public readonly int $status)
    {
        parent::__construct($message);
    }
}
