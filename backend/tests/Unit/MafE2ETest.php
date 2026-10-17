<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use AgentTeam\Services\CompiledPackage;
use AgentTeam\Services\MAFGenerator;

/** Opt-in (MAF_E2E=1): the ADK E2E scenarios on the MAF target (code routing, headers, listening, Jev). */
class MafE2ETest extends AdkCodeNodeE2ETest
{
    protected const ENV_FLAG = 'MAF_E2E';

    protected function emit(array $analyzed): string
    {
        return MAFGenerator::emitMaf($analyzed);
    }

    protected function packageFiles(array $analyzed): array
    {
        return CompiledPackage::files($analyzed, sys_get_temp_dir(), [], MAFGenerator::FRAMEWORK, 'Microsoft Agent Framework');
    }
}
