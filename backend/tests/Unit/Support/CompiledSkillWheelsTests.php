<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit\Support;

/**
 * Skill-store Task 13, for each compile target (ADK, MAF, NOOA): a compiled package carries each used skill's
 * native wheels (never the browser's) and installs them from its own folder, offline. The using test class
 * names its generator in generatorClass().
 */
trait CompiledSkillWheelsTests
{
    abstract protected static function generatorClass(): string;

    private function wheelPackage(string|\Closure $skillsRoot, string $mode = 'modular'): array
    {
        $gen = DispatcherDemoFixture::generator(static::generatorClass(), DispatcherDemoFixture::pdoWithSkill(), $skillsRoot);
        return $mode === 'a2a' ? $gen->generateA2A(DispatcherDemoFixture::WORKFLOW_ID) : $gen->generatePackage(DispatcherDemoFixture::WORKFLOW_ID);
    }

    public function testNativeWheelsTravelWithTheSkill(): void
    {
        $root = DispatcherDemoFixture::wheelSkillsRoot();
        foreach (['modular', 'a2a'] as $mode) {
            $files = $this->wheelPackage($root, $mode)['files'];
            $this->assertSame(['skills/pdf-report/.wheels/native/fpdf2-2.8.1-py3-none-any.whl', 'skills/pdf-report/SKILL.md',
                'skills/pdf-report/run.py'], DispatcherDemoFixture::skillPaths($files), $mode);   // never .wheels/pyodide/
            $whl = array_column($files, null, 'path')['skills/pdf-report/.wheels/native/fpdf2-2.8.1-py3-none-any.whl'];
            $this->assertSame("PK\x03\x04\xffnative", base64_decode($whl['code']), $mode);
        }
    }

    public function testTheResolverPicksEachSkillFolder(): void
    {
        $root = DispatcherDemoFixture::wheelSkillsRoot();
        $asked = [];
        $files = $this->wheelPackage(function (string $dir) use ($root, &$asked): ?string {
            $asked[] = $dir;
            return "$root/$dir";
        })['files'];
        $this->assertSame(['pdf-report'], $asked);
        $this->assertContains('skills/pdf-report/.wheels/native/fpdf2-2.8.1-py3-none-any.whl', DispatcherDemoFixture::skillPaths($files));
    }

    public function testASkillTheResolverCannotFindIsAnError(): void
    {
        $this->expectException(\RuntimeException::class);
        $this->expectExceptionMessage('Skill folder "pdf-report" is not available on this server, so it can\'t be packaged.');
        $this->wheelPackage(fn(string $dir): ?string => null);
    }

    public function testTheProgramInstallsFromTheSkillsOwnWheels(): void
    {
        $code = implode("\n", array_column($this->wheelPackage(DispatcherDemoFixture::wheelSkillsRoot())['files'], 'code'));
        $this->assertStringContainsString('"--no-index", "--find-links"', $code);
        $this->assertStringContainsString('os.path.join(skill_dir, ".wheels", "native")', $code);
    }
}
