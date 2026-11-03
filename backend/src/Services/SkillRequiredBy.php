<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Services;

/**
 * A skill other skills need (their required skills, LangGraphPackage::requiredSkills) cannot be deleted, renamed or
 * made private; a skill cannot be made public with a required skill the caller cannot make public. 409.
 * reason: delete | rename | private | public; requiredBy: the dependent skills the caller can see; needs: (public) the
 * required skill that blocks it.
 */
final class SkillRequiredBy extends \RuntimeException
{
    /** @param list<string> $requiredBy */
    public function __construct(string $message, private readonly string $reason, private readonly string $skill,
        private readonly array $requiredBy = [], private readonly string $needs = '')
    {
        parent::__construct($message);
    }

    public function data(): array
    {
        return ['message' => $this->getMessage(), 'reason' => $this->reason, 'skill' => $this->skill, 'required_by' => $this->requiredBy]
            + ($this->needs !== '' ? ['needs' => $this->needs] : []);
    }

    public function statusCode(): int
    {
        return 409;
    }
}
