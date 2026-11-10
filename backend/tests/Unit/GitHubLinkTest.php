<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Services\GitHubLink;

final class GitHubLinkTest extends TestCase
{
    public static function validUrls(): array
    {
        $b = 'github.com/didierphmartin/mcps/tree/main/arxiv';
        return [
            'plain' => ["https://$b"],
            'query' => ["https://$b?tab=readme"],
            'fragment' => ["https://$b#readme"],
            'trailing slash' => ["https://$b/"],
            'http' => ["http://$b"],
            'www' => ['https://www.' . $b],
        ];
    }

    #[DataProvider('validUrls')]
    public function testParse(string $url): void
    {
        $this->assertSame(
            ['owner' => 'didierphmartin', 'repo' => 'mcps', 'segments' => ['main', 'arxiv']],
            GitHubLink::parse($url)
        );
    }

    public function testDotGitRepo(): void
    {
        $r = GitHubLink::parse('https://github.com/didierphmartin/mcps.git/tree/main/arxiv');
        $this->assertSame('mcps', $r['repo']);
    }

    public function testBlobManifestDropped(): void
    {
        $r = GitHubLink::parse('https://github.com/didierphmartin/mcps/blob/main/arxiv/synergyai-mcp.json');
        $this->assertSame([['ref' => 'main', 'path' => 'arxiv']], GitHubLink::candidates($r['segments']));
    }

    public function testMissingFolder(): void
    {
        foreach (['https://github.com/didierphmartin/mcps', 'https://github.com/didierphmartin/mcps/tree/main'] as $u) {
            try {
                GitHubLink::parse($u);
                $this->fail('expected exception');
            } catch (\InvalidArgumentException $e) {
                $this->assertSame("Paste the link to one server's folder", $e->getMessage());
            }
        }
    }

    public function testNotGitHub(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessage('Not a GitHub link');
        GitHubLink::parse('https://gitlab.com/a/b/tree/main/x');
    }

    public function testCandidates(): void
    {
        $this->assertSame(
            [['ref' => 'feat/x', 'path' => 'arxiv'], ['ref' => 'feat', 'path' => 'x/arxiv']],
            GitHubLink::candidates(['feat', 'x', 'arxiv'])
        );
    }

    public function testFolderName(): void
    {
        $this->assertSame('arxiv', GitHubLink::folderName('tools/arxiv'));
        foreach (['tools/my server', 'a/..'] as $p) {
            try {
                GitHubLink::folderName($p);
                $this->fail('expected exception');
            } catch (\InvalidArgumentException $e) {
                $this->assertStringStartsWith('This folder name cannot be used: ', $e->getMessage());
            }
        }
    }

    public static function badFolders(): array
    {
        $m = "Paste the link to one server's folder";
        $g = 'https://github.com/o/r';
        return [
            'tree manifest only' => ["$g/tree/main/synergyai-mcp.json", $m],
            'blob manifest only' => ["$g/blob/main/synergyai-mcp.json", $m],
            'blob other file' => ["$g/blob/main/arxiv/README.md", $m],
            'dotdot segment' => ["$g/tree/main/a/..", $m],
            'encoded slash' => ["$g/tree/main/a%2Fb", $m],
            'encoded question' => ["$g/tree/main/a%3Fb", $m],
            'control char' => ["$g/tree/main/a%0Ab", $m],
            'owner dotdot' => ['https://github.com/../x/tree/main/a', 'Not a GitHub link'],
            'repo .git' => ['https://github.com/o/.git/tree/main/a', 'Not a GitHub link'],
            'repo encoded question' => ['https://github.com/o/a%3Fb/tree/main/a', 'Not a GitHub link'],
        ];
    }

    #[DataProvider('badFolders')]
    public function testBadLinks(string $url, string $message): void
    {
        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessage($message);
        GitHubLink::parse($url);
    }

    public function testDoubleSlashIgnored(): void
    {
        $this->assertSame(
            GitHubLink::parse('https://github.com/o/r/tree/main/arxiv'),
            GitHubLink::parse('https://github.com/o/r/tree/main//arxiv')
        );
    }
}
