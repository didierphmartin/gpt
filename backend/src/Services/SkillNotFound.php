<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Services;

/** SkillStore error (no such skill); statusCode() is the HTTP status the API answers with. */
final class SkillNotFound extends \RuntimeException
{
    public function statusCode(): int
    {
        return 404;
    }
}
