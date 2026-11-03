<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Services;

/** SkillStore error (clash); statusCode() is the HTTP status the API answers with. */
final class SkillClashException extends \RuntimeException
{
    public function statusCode(): int
    {
        return 409;
    }
}
