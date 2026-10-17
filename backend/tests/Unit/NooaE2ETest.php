<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use AgentTeam\Services\CompiledPackage;
use AgentTeam\Services\NOOAGenerator;

/** Opt-in (NOOA_E2E=1): the ADK E2E scenarios on the NOOA target (code routing, headers, listening, Jev). */
class NooaE2ETest extends AdkCodeNodeE2ETest
{
    protected const ENV_FLAG = 'NOOA_E2E';

    protected function emit(array $analyzed): string
    {
        return NOOAGenerator::emitNooa($analyzed);
    }

    protected function packageFiles(array $analyzed): array
    {
        return CompiledPackage::files($analyzed, sys_get_temp_dir(), [], NOOAGenerator::FRAMEWORK, 'NVIDIA NOOA');
    }

    protected function packageSources(array $analyzed): array
    {
        return NOOAGenerator::packageFiles($analyzed);
    }

    protected function a2aPackage(array $analyzed): array
    {
        return NOOAGenerator::a2aPackage($analyzed);
    }
}
