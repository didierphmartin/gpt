<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Exceptions;

/**
 * Thrown when a token price cannot be resolved from system_llm_settings
 * (no row, a NULL price, or a failed DB query). Never swallowed into a
 * hardcoded fallback — callers on the billing path surface it.
 */
class PricingUnavailableException extends \RuntimeException
{
}
