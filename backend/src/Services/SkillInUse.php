<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Services;

/** A public skill the robot's workflows bind cannot be made private, renamed or deleted; carries those workflows. */
final class SkillInUse extends \RuntimeException
{
    /** @param list<array{id:int,name:string}> $workflows */
    public function __construct(private readonly array $workflows)
    {
        parent::__construct('A workflow of the robot uses this skill.');
    }

    /** @return list<array{id:int,name:string}> */
    public function workflows(): array
    {
        return $this->workflows;
    }

    public function statusCode(): int
    {
        return 409;
    }
}
