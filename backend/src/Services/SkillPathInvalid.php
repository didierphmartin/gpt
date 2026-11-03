<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Services;

/** SkillStore error (invalid path); statusCode() is the HTTP status the API answers with. */
final class SkillPathInvalid extends \RuntimeException
{
    public function statusCode(): int
    {
        return 400;
    }
}
