<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Automation;

final class AutomationError extends \RuntimeException
{
    public function __construct(string $message, public readonly int $status = 400, public readonly string $errorCode = 'bad_request')
    {
        parent::__construct($message);
    }
}
