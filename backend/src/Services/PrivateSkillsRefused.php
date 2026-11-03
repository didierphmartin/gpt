<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Services;

/** A robot workflow binds private skills; the robot can only use public ones. Answer with RobotSkillPolicy::refusal(). */
final class PrivateSkillsRefused extends \RuntimeException
{
    /** @param list<array{path:string,owner_id:int,owner_name:string}> $skills */
    public function __construct(public readonly array $skills)
    {
        parent::__construct(RobotSkillPolicy::MESSAGE);
    }
}
