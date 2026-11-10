<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Services;

/** Parses a GitHub folder/blob link into owner, repo and unsplit ref+path segments. No network. */
final class GitHubLink
{
    private const MANIFEST = 'synergyai-mcp.json';

    /** @return array{owner:string, repo:string, segments:list<string>} */
    public static function parse(string $url): array
    {
        $parts = parse_url(trim($url));
        $host = strtolower((string) ($parts['host'] ?? ''));
        if ($host !== 'github.com' && $host !== 'www.github.com') {
            throw new \InvalidArgumentException('Not a GitHub link');
        }
        $path = array_values(array_filter(explode('/', (string) ($parts['path'] ?? '')), static fn($s) => $s !== ''));
        $msg = "Paste the link to one server's folder";
        if (count($path) < 5 || !in_array($path[2], ['tree', 'blob'], true)) {
            throw new \InvalidArgumentException($msg);
        }
        $repo = preg_replace('/\.git$/', '', $path[1]);
        return [
            'owner' => $path[0],
            'repo' => $repo,
            'segments' => array_map('rawurldecode', array_slice($path, 3)),
        ];
    }

    /** @return list<array{ref:string, path:string}> longest ref first */
    public static function candidates(array $segments): array
    {
        $segments = array_values($segments);
        if ($segments !== [] && end($segments) === self::MANIFEST) {
            array_pop($segments);
        }
        $out = [];
        for ($i = count($segments) - 1; $i >= 1; $i--) {
            $out[] = [
                'ref' => implode('/', array_slice($segments, 0, $i)),
                'path' => implode('/', array_slice($segments, $i)),
            ];
        }
        return $out;
    }

    public static function folderName(string $path): string
    {
        $parts = explode('/', trim($path, '/'));
        $name = end($parts);
        if (!preg_match('/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/', $name)) {
            throw new \InvalidArgumentException('This folder name cannot be used: ' . $name);
        }
        return $name;
    }
}
