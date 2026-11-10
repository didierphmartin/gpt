<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Services\GitHubFetchError;
use Quantis\AIPortfolioAssistant\Services\GitHubServerFetcher;

class GitHubServerFetcherTest extends TestCase
{
    private const MANIFEST = '{"name":"arXiv","runtime":"php","entry":"mcp.php"}';

    /** @var list<array{url:string,max:int}> */
    private array $calls = [];

    /** @param array<string,string> $entries archive path => content */
    private function zip(array $entries): string
    {
        $tmp = tempnam(sys_get_temp_dir(), 'ghz');
        $z = new \ZipArchive();
        $z->open($tmp, \ZipArchive::OVERWRITE);
        foreach ($entries as $name => $content) {
            $z->addFromString($name, $content);
        }
        $z->close();
        $bytes = (string) file_get_contents($tmp);
        unlink($tmp);
        return $bytes;
    }

    /** @param array<string,array{0:int,1:string}> $routes url => [status, body]; anything else 404 */
    private function fetcher(array $routes): GitHubServerFetcher
    {
        return new GitHubServerFetcher(function (string $url, int $max) use ($routes): array {
            $this->calls[] = ['url' => $url, 'max' => $max];
            [$status, $body] = $routes[$url] ?? [404, '{"message":"Not Found"}'];
            return ['status' => $status, 'body' => $body];
        });
    }

    private function arxiv(array $extra = [], string $manifest = self::MANIFEST): array
    {
        return [
            'https://api.github.com/repos/o/mcps/commits/main' => [200, '{"sha":"abc123"}'],
            'https://codeload.github.com/o/mcps/zip/abc123' => [200, $this->zip(array_merge([
                'mcps-abc123/README.md' => 'root readme',
                'mcps-abc123/arxiv/mcp.php' => '<?php echo 1;',
                'mcps-abc123/arxiv/synergyai-mcp.json' => $manifest,
                'mcps-abc123/arxiv/.gitignore' => 'x',
                'mcps-abc123/arxiv/.env' => 'SECRET=1',
                'mcps-abc123/arxiv/debug.log' => 'log',
                'mcps-abc123/other/x.py' => 'nope',
            ], $extra))],
        ];
    }

    private function expectError(callable $fn, int $status, string $message): void
    {
        try {
            $fn();
            $this->fail('expected GitHubFetchError');
        } catch (GitHubFetchError $e) {
            $this->assertSame($status, $e->status);
            $this->assertSame($message, $e->getMessage());
        }
    }

    public function testHappyPath(): void
    {
        $out = $this->fetcher($this->arxiv())->fetch('https://github.com/o/mcps/tree/main/arxiv');
        $this->assertSame('arxiv', $out['folder']);
        $this->assertSame(['mcp.php', 'synergyai-mcp.json'], array_keys($out['files']));
        $this->assertSame('<?php echo 1;', base64_decode($out['files']['mcp.php']));
        $this->assertSame('arXiv', $out['manifest']['name']);
        $this->assertSame([], $out['fields']);
        $this->assertSame([
            'url' => 'https://github.com/o/mcps/tree/main/arxiv', 'owner' => 'o', 'repo' => 'mcps',
            'ref' => 'main', 'sha' => 'abc123', 'path' => 'arxiv',
        ], $out['source']);
        $this->assertSame(50 * 1024 * 1024, $this->calls[1]['max']);
    }

    public function testSlashRefPicksLongestExistingRef(): void
    {
        $routes = [
            'https://api.github.com/repos/o/mcps/commits/feat%2Fx' => [200, '{"sha":"def456"}'],
            'https://codeload.github.com/o/mcps/zip/def456' => [200, $this->zip([
                'mcps-def456/arxiv/mcp.php' => '<?php',
                'mcps-def456/arxiv/synergyai-mcp.json' => self::MANIFEST,
            ])],
        ];
        $out = $this->fetcher($routes)->fetch('https://github.com/o/mcps/tree/feat/x/arxiv');
        $this->assertSame('feat/x', $out['source']['ref']);
        $this->assertSame('arxiv', $out['source']['path']);
        $this->assertSame('def456', $out['source']['sha']);

        $routes = [
            'https://api.github.com/repos/o/mcps/commits/feat' => [200, '{"sha":"aaa111"}'],
            'https://codeload.github.com/o/mcps/zip/aaa111' => [200, $this->zip([
                'mcps-aaa111/x/arxiv/mcp.php' => '<?php',
                'mcps-aaa111/x/arxiv/synergyai-mcp.json' => self::MANIFEST,
            ])],
        ];
        $out = $this->fetcher($routes)->fetch('https://github.com/o/mcps/tree/feat/x/arxiv');
        $this->assertSame('feat', $out['source']['ref']);
        $this->assertSame('x/arxiv', $out['source']['path']);
    }

    public function testNoManifest(): void
    {
        $routes = $this->arxiv();
        $routes['https://codeload.github.com/o/mcps/zip/abc123'] = [200, $this->zip(['mcps-abc123/arxiv/mcp.php' => '<?php'])];
        $this->expectError(fn() => $this->fetcher($routes)->fetch('https://github.com/o/mcps/tree/main/arxiv'),
            422, 'This folder has no synergyai-mcp.json');
    }

    public function testInvalidManifest(): void
    {
        $this->expectError(fn() => $this->fetcher($this->arxiv([], '{nope'))->fetch('https://github.com/o/mcps/tree/main/arxiv'),
            422, 'synergyai-mcp.json is not valid JSON');
    }

    public function testUnsupportedRuntime(): void
    {
        $this->expectError(fn() => $this->fetcher($this->arxiv([], '{"runtime":"node"}'))->fetch('https://github.com/o/mcps/tree/main/arxiv'),
            422, 'Unsupported runtime: node');
    }

    public function testPhpEntryMissing(): void
    {
        $f = fn(string $m) => fn() => $this->fetcher($this->arxiv([], $m))->fetch('https://github.com/o/mcps/tree/main/arxiv');
        $this->expectError($f('{"runtime":"php","entry":"server.php"}'), 422, "The manifest's entry file is missing");
        $this->expectError($f('{"runtime":"php"}'), 422, "The manifest's entry file is missing");
    }

    public function testPythonNeedsStart(): void
    {
        $this->expectError(fn() => $this->fetcher($this->arxiv([], '{"name":"x"}'))->fetch('https://github.com/o/mcps/tree/main/arxiv'),
            422, 'The manifest has no start command');
        $out = $this->fetcher($this->arxiv([], '{"start":"python server.py"}'))->fetch('https://github.com/o/mcps/tree/main/arxiv');
        $this->assertSame('arxiv', $out['folder']);
    }

    public function testFolderTooLarge(): void
    {
        $routes = $this->arxiv(['mcps-abc123/arxiv/big.bin' => str_repeat('a', 20 * 1024 * 1024 + 1)]);
        $this->expectError(fn() => $this->fetcher($routes)->fetch('https://github.com/o/mcps/tree/main/arxiv'),
            413, 'The server folder is larger than 20 MB');
    }

    public function testEveryCandidate404(): void
    {
        $this->expectError(fn() => $this->fetcher([])->fetch('https://github.com/o/mcps/tree/feat/x/arxiv'),
            404, 'Repository, branch or folder not found on GitHub');
        $this->assertSame([
            'https://api.github.com/repos/o/mcps/commits/feat%2Fx',
            'https://api.github.com/repos/o/mcps/commits/feat',
        ], array_column($this->calls, 'url'));
    }

    public function testFolderAbsentFromArchiveIs404(): void
    {
        $this->expectError(fn() => $this->fetcher($this->arxiv())->fetch('https://github.com/o/mcps/tree/main/missing'),
            404, 'Repository, branch or folder not found on GitHub');
    }

    public function testRateLimit(): void
    {
        $routes = ['https://api.github.com/repos/o/mcps/commits/main' => [403, '{"message":"API rate limit exceeded"}']];
        $this->expectError(fn() => $this->fetcher($routes)->fetch('https://github.com/o/mcps/tree/main/arxiv'),
            429, "GitHub's rate limit was reached; try again in an hour");
    }

    public function testNetworkFailure(): void
    {
        $routes = ['https://api.github.com/repos/o/mcps/commits/main' => [0, '']];
        $this->expectError(fn() => $this->fetcher($routes)->fetch('https://github.com/o/mcps/tree/main/arxiv'),
            502, 'GitHub could not be reached');
    }

    public function testFieldsFromEnvExample(): void
    {
        $routes = $this->arxiv(['mcps-abc123/arxiv/.env.example' => "# Event hub\n# connection\nEVENTHUB_CONNECTION=\nREGION=\"eu\"\n"]);
        $out = $this->fetcher($routes)->fetch('https://github.com/o/mcps/tree/main/arxiv');
        $this->assertSame([
            ['name' => 'EVENTHUB_CONNECTION', 'label' => 'Event hub connection', 'required' => false, 'secret' => true, 'default' => ''],
            ['name' => 'REGION', 'label' => '', 'required' => false, 'secret' => false, 'default' => 'eu'],
        ], $out['fields']);
        $this->assertArrayHasKey('.env.example', $out['files']);
    }

    public function testFieldsFromManifestEnv(): void
    {
        $m = '{"runtime":"php","entry":"mcp.php","env":[{"name":"API_KEY","required":true},"bad",{"name":"HOST","secret":false,"default":3}]}';
        $out = $this->fetcher($this->arxiv([], $m))->fetch('https://github.com/o/mcps/tree/main/arxiv');
        $this->assertSame([
            ['name' => 'API_KEY', 'label' => '', 'required' => true, 'secret' => true, 'default' => ''],
            ['name' => 'HOST', 'label' => '', 'required' => false, 'secret' => false, 'default' => '3'],
        ], $out['fields']);
    }

    public function testManifestIncludeExclude(): void
    {
        $m = '{"runtime":"php","entry":"mcp.php","exclude":["README.md"]}';
        $routes = $this->arxiv(['mcps-abc123/arxiv/README.md' => 'r', 'mcps-abc123/arxiv/src/a.php' => 'a',
            'mcps-abc123/arxiv/vendor/x.php' => 'v', 'mcps-abc123/arxiv/.cache/y' => 'c'], $m);
        $out = $this->fetcher($routes)->fetch('https://github.com/o/mcps/tree/main/arxiv');
        $this->assertEqualsCanonicalizing(['mcp.php', 'synergyai-mcp.json', 'src/a.php'], array_keys($out['files']));
    }
}
