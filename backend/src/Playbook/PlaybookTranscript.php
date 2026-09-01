<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Playbook;

final class PlaybookTranscript
{
    public function __construct(private readonly string $dir) {}

    public function append(int $runId, array $event): void
    {
        $event['ts'] = date('c');
        $line = json_encode($event, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . "\n";
        file_put_contents($this->path($runId), $line, FILE_APPEND | LOCK_EX);
    }

    public function read(int $runId): array
    {
        $path = $this->path($runId);
        if (!is_file($path)) {
            return [];
        }
        $lines = file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [];
        return array_map(fn(string $line) => json_decode($line, true), $lines);
    }

    private function path(int $runId): string
    {
        return rtrim($this->dir, '/') . '/playbook-' . $runId . '.jsonl';
    }
}
