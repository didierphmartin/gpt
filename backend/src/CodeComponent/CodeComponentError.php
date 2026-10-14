<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\CodeComponent;

/** A refused collection operation: kind (not_found, invalid, name_taken, in_use, links_dropped), its HTTP status, and details. */
final class CodeComponentError extends \RuntimeException
{
    public function __construct(public readonly string $kind, string $message, public readonly int $status,
                                public readonly array $data = [])
    {
        parent::__construct($message);
    }
}
