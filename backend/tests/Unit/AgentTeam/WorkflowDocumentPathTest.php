<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit\AgentTeam;

use PHPUnit\Framework\TestCase;
use AgentTeam\Services\GraphWorkflowRunner;

/** A document node's path reads only files under the storage root folder. No user id, so no universalFS adapter is opened. */
class WorkflowDocumentPathTest extends TestCase
{
    private string $base;
    private GraphWorkflowRunner $runner;

    protected function setUp(): void
    {
        $this->base = sys_get_temp_dir() . '/wf-doc-' . uniqid();
        mkdir($this->base . '/synergyaichatroot/alice', 0777, true);
        file_put_contents($this->base . '/synergyaichatroot/alice/a.txt', 'inside');
        file_put_contents($this->base . '/secret.txt', 'outside');
        symlink($this->base . '/secret.txt', $this->base . '/synergyaichatroot/alice/link.txt');

        $ref = new \ReflectionClass(GraphWorkflowRunner::class);
        $this->runner = $ref->newInstanceWithoutConstructor();
        $ref->getProperty('config')->setValue($this->runner, ['storage_path' => $this->base]);
    }

    protected function tearDown(): void
    {
        exec('rm -rf ' . escapeshellarg($this->base));
    }

    private function read(array $doc): ?string
    {
        return (new \ReflectionMethod(GraphWorkflowRunner::class, 'readFileRaw'))->invoke($this->runner, $doc);
    }

    public function test_file_under_the_root_folder_is_read(): void
    {
        $this->assertSame('inside', $this->read(['path' => 'alice/a.txt']));
        $this->assertSame('inside', $this->read(['fullPath' => '/synergyaichatroot/alice/a.txt']));
    }

    public function test_paths_leaving_the_root_folder_are_refused(): void
    {
        foreach ([
            ['path' => '../secret.txt'],
            ['fullPath' => 'secret.txt'],
            ['fullPath' => 'synergyaichatroot/../secret.txt'],
            ['fullPath' => 'synergyaichatroot\\..\\secret.txt'],
            ['path' => 'alice/link.txt'],
            ['fullPath' => '/etc/passwd'],
        ] as $doc) {
            $this->assertNull($this->read($doc), json_encode($doc));
        }
    }
}
