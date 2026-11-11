<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use AgentTeam\Services\ADKGenerator;
use AgentTeam\Services\AgentRepository;
use AgentTeam\Services\LangGraphGenerator;
use AgentTeam\Services\MAFGenerator;
use AgentTeam\Services\NOOAGenerator;
use AgentTeam\Services\WorkflowGraphRepository;
use AgentTeam\Services\WorkflowRepository;
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Tests\Unit\Support\DispatcherDemoFixture;

/**
 * The workflow's "MLflow tracing" setting (agent_workflows.mlflow_tracing): on, every target and layout carries
 * its tracing block in the code every process runs, its tracing package in requirements.txt, the two MLFLOW_*
 * variables in .env.example and a README section. Off, nothing of it is emitted.
 */
final class MlflowTracingCompileTest extends TestCase
{
    /** [target, layout] => the files of that compile, path => text */
    private static function compile(string $target, string $layout, bool $tracing): array
    {
        $db = DispatcherDemoFixture::pdo();
        $db->exec('UPDATE agent_workflows SET mlflow_tracing = ' . ($tracing ? 1 : 0));
        $wf = DispatcherDemoFixture::WORKFLOW_ID;
        if ($target === 'langgraph') {
            $gen = new LangGraphGenerator($db, new WorkflowRepository($db), new WorkflowGraphRepository($db),
                new AgentRepository($db), sys_get_temp_dir() . '/no-skills', null);
            $r = $gen->generate($wf, '3', ['modular' => $layout === 'modular', 'a2a' => $layout === 'a2a']);
        } else {
            $gen = DispatcherDemoFixture::generator(['adk' => ADKGenerator::class, 'maf' => MAFGenerator::class,
                'nooa' => NOOAGenerator::class][$target], $db, sys_get_temp_dir() . '/no-skills');
            $r = match ($layout) {
                'modular' => $gen->generatePackage($wf, '3'),
                'a2a' => $gen->generateA2A($wf, '3'),
                default => $gen->generate($wf, '3'),
            };
        }
        if (isset($r['files'])) {
            $out = [];
            foreach ($r['files'] as $f) {
                $out[$f['path']] = ($f['encoding'] ?? '') === 'base64' ? '' : $f['code'];
            }
            return $out;
        }
        $out = [$r['filename'] => $r['code']];
        foreach ($r['package_files'] ?? [] as $f) {
            $out[$f['path']] = $f['code'];
        }
        return $out;
    }

    public static function cases(): array
    {
        $c = [];
        foreach (['langgraph', 'adk', 'maf', 'nooa'] as $t) {
            foreach (['single', 'modular', 'a2a'] as $l) {
                $c["$t $l"] = [$t, $l];
            }
        }
        return $c;
    }

    /** @dataProvider cases */
    public function testOnEmitsTracingAndItsPackageFiles(string $target, string $layout): void
    {
        $files = self::compile($target, $layout, true);
        $py = array_filter($files, fn($p) => str_ends_with((string) $p, '.py'), ARRAY_FILTER_USE_KEY);
        $traced = array_keys(array_filter($py, fn($code) => str_contains($code, 'MLFLOW_TRACKING_URI')));
        self::assertNotEmpty($traced, "$target $layout: no file starts tracing");
        $marker = $target === 'langgraph' ? 'mlflow.langchain.autolog()' : 'MlflowTracing.start("Dispatcher demo")';
        foreach ($traced as $p) {
            self::assertStringContainsString($marker, $py[$p], "$target $layout $p");
        }
        if ($layout === 'a2a') {
            // Every agent server is a process of its own: each must start tracing (directly or through common.py).
            $servers = array_filter(array_keys($py), fn($p) => preg_match('#^(agents|servers)/#', (string) $p)
                && !str_ends_with((string) $p, '__init__.py'));
            self::assertNotEmpty($servers);
            foreach ($servers as $p) {
                $code = $py[$p];
                self::assertTrue(str_contains($code, $marker) || str_contains($code, 'from common import')
                    || str_contains($code, 'import common'), "$target a2a server $p does not trace");
            }
        }
        if ($layout !== 'single' || isset($files['requirements.txt'])) {
            $req = $files['requirements.txt'] ?? '';
            self::assertStringContainsString($target === 'langgraph' ? 'mlflow-tracing' : 'opentelemetry-exporter-otlp-proto-http', $req);
            self::assertStringContainsString('MLFLOW_TRACKING_URI=', $files['.env.example'] ?? '');
            self::assertStringContainsString('MLFLOW_EXPERIMENT_NAME=', $files['.env.example'] ?? '');
            self::assertStringContainsString('## MLflow tracing', $files['README.md'] ?? '');
        }
        self::assertPythonParses($py, "$target $layout");
    }

    /** @dataProvider cases */
    public function testOffEmitsNothingOfIt(string $target, string $layout): void
    {
        foreach (self::compile($target, $layout, false) as $p => $text) {
            self::assertStringNotContainsStringIgnoringCase('mlflow', $text, "$target $layout $p");
        }
    }

    /** The setting survives a save: create and update write the column, findById reads it back. */
    public function testRepositoryRoundTrip(): void
    {
        $db = DispatcherDemoFixture::pdo();
        $repo = new WorkflowRepository($db);
        $wf = $repo->findById(DispatcherDemoFixture::WORKFLOW_ID);
        self::assertFalse($wf->isMlflowTracing());
        $repo->update($wf->setMlflowTracing(true));
        self::assertTrue($repo->findById(DispatcherDemoFixture::WORKFLOW_ID)->isMlflowTracing());
        self::assertTrue($repo->findById(DispatcherDemoFixture::WORKFLOW_ID)->toArray()['mlflow_tracing']);
        $copy = $repo->create((new \AgentTeam\Models\Workflow(['user_id' => 3, 'name' => 'copy']))->setMlflowTracing(true));
        self::assertTrue($repo->findById((int) $copy->getId())->isMlflowTracing());
    }

    /** @param array<string,string> $py */
    private static function assertPythonParses(array $py, string $what): void
    {
        $dir = sys_get_temp_dir() . '/mlflow-compile-' . bin2hex(random_bytes(4));
        mkdir($dir);
        try {
            $i = 0;
            $names = [];
            foreach ($py as $p => $code) {
                $f = $dir . '/f' . $i++ . '.py';
                file_put_contents($f, $code);
                $names[$f] = $p;
            }
            $cmd = 'python3 -c ' . escapeshellarg('import ast,sys' . "\n" . 'for f in sys.argv[1:]: ast.parse(open(f).read(), f)')
                . ' ' . implode(' ', array_map('escapeshellarg', array_keys($names))) . ' 2>&1';
            exec($cmd, $out, $rc);
            self::assertSame(0, $rc, "$what: " . implode("\n", $out));
        } finally {
            array_map('unlink', glob($dir . '/*.py') ?: []);
            rmdir($dir);
        }
    }
}
