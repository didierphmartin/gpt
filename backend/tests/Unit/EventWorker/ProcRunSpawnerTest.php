<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit\EventWorker;

use AgentTeam\Services\ProcRunSpawner;
use PHPUnit\Framework\TestCase;

/** The spawner reports exit codes and kills a run past its limit. */
final class ProcRunSpawnerTest extends TestCase
{
    private string $dir;
    /** @var array<string, int> exit codes seen so far (done() reports each once) */
    private array $seen = [];

    protected function setUp(): void
    {
        $this->dir = sys_get_temp_dir() . '/ew-' . bin2hex(random_bytes(4));
        mkdir($this->dir . '/bin', 0777, true);
        mkdir($this->dir . '/scheduler', 0777, true);
        // A stand-in run-schedule.php: id 7 exits 3, id 9 sleeps 30 s, others exit 0.
        file_put_contents($this->dir . '/bin/run-schedule.php',
            '<?php $id = (int) $argv[1]; if ($id === 9) { sleep(30); } exit($id === 7 ? 3 : 0);');
        file_put_contents($this->dir . '/scheduler/run-scheduled-workflows.php', '<?php exit(0);');
    }

    private function waitFor(ProcRunSpawner $s, string $key, float $max = 5.0): ?int
    {
        $end = microtime(true) + $max;
        while (microtime(true) < $end) {
            $this->seen = $s->done() + $this->seen;
            if (array_key_exists($key, $this->seen)) {
                return $this->seen[$key];
            }
            usleep(50000);
        }
        return null;
    }

    public function testExitCodes(): void
    {
        $s = new ProcRunSpawner(PHP_BINARY, $this->dir);
        $s->start('1:5', 5);
        $s->start('2:7', 7);
        $this->assertSame(0, $this->waitFor($s, '1:5'));
        $this->assertSame(3, $this->waitFor($s, '2:7'));
    }

    public function testARunPastItsLimitIsKilled(): void
    {
        $s = new ProcRunSpawner(PHP_BINARY, $this->dir, 1);
        $s->start('1:5', 9);
        $code = $this->waitFor($s, '1:5', 5.0);
        $this->assertNotNull($code);
        $this->assertNotSame(0, $code);
    }

    public function testALiveRunIsNotOverwritten(): void
    {
        $lines = [];
        $s = new ProcRunSpawner(PHP_BINARY, $this->dir, 1, function (string $l) use (&$lines) { $lines[] = $l; });
        $s->start('1:5', 9);     // sleeps
        try {
            $s->start('1:5', 5);     // refused: key 1:5 still runs
            $this->fail('expected a RuntimeException');
        } catch (\RuntimeException) {
        }
        $this->assertCount(1, $lines);
        $code = $this->waitFor($s, '1:5', 5.0);
        $this->assertNotSame(0, $code);   // it was the sleeping run, killed at the limit
        $s->stopAll(1);
    }

    public function testAHungSchedulerTickIsKilled(): void
    {
        file_put_contents($this->dir . '/scheduler/run-scheduled-workflows.php', '<?php sleep(30);');
        $lines = [];
        $s = new ProcRunSpawner(PHP_BINARY, $this->dir, 1, function (string $l) use (&$lines) { $lines[] = $l; });
        $s->scheduleTick();
        $end = microtime(true) + 5;
        while (!$lines && microtime(true) < $end) {
            $s->done();
            usleep(50000);
        }
        $this->assertCount(1, $lines);
        $this->assertStringContainsString('tick', $lines[0]);
        $s->scheduleTick();   // a fresh tick may start now
        $s->stopAll(0);
    }
}
