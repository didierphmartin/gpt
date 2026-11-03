<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Services;

/** SkillStore error (not allowed); statusCode() is the HTTP status the API answers with. */
final class SkillForbidden extends \RuntimeException
{
    public function statusCode(): int
    {
        return 403;
    }
}
