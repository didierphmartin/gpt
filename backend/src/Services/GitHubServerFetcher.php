<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Services;

/**
 * Fetches one MCP server folder from a public GitHub repo, pinned to a commit sha:
 * resolve the ref (commits API), download the archive (codeload), keep the folder's shippable files.
 * File selection and settings fields are twins of the mcps container (control.select_server_files, envfile.fields).
 */
final class GitHubServerFetcher
{
    public const ARCHIVE_MAX = 50 * 1024 * 1024;
    public const FOLDER_MAX = 20 * 1024 * 1024;
    public const TIMEOUT = 60;
    private const MANIFEST = 'synergyai-mcp.json';
    private const NOT_FOUND = 'Repository, branch or folder not found on GitHub';
    private const RATE_LIMIT = "GitHub's rate limit was reached; try again in an hour";
    private const UNREACHABLE = 'GitHub could not be reached';

    // copied from docker/mcps/mcphost/control.py (DEFAULT_EXCLUDES, ALWAYS_EXCLUDES)
    private const DEFAULT_EXCLUDES = ['.venv/', 'venv/', 'node_modules/', 'vendor/', '__pycache__/', 'dist/', 'build/', '.git/', 'log/', 'logs/', 'tests/', 'docs/', '.env', '*.sqlite*', '*.log',
        '*.pem', '*.key', '*.p12', '*.pfx', 'credentials*.json', 'token*.json', '*secret*'];
    private const ALWAYS_EXCLUDES = ['.env', '.venv/', 'data/', 'server.log*'];
    // copied from docker/mcps/mcphost/envfile.py (SECRET_FIELD_RE)
    private const SECRET_FIELD_RE = '/key|secret|token|password|passwd|credential|dsn|connection|connection_string|conn_str|connstr|auth|bearer|private/i';

    /** @var \Closure(string, int): array{status:int, body:string} */
    private \Closure $http;

    /** @param ?\Closure(string $url, int $maxBytes): array{status:int, body:string} $http status 0 = network failure */
    public function __construct(?\Closure $http = null)
    {
        $this->http = $http ?? self::curl(...);
    }

    /** @return array{folder:string, manifest:array, fields:list<array>, files:array<string,string>, source:array} files are base64 */
    public function fetch(string $url): array
    {
        try {
            $link = GitHubLink::parse($url);
        } catch (\InvalidArgumentException $e) {
            throw new GitHubFetchError(400, $e->getMessage());
        }
        $repoPath = rawurlencode($link['owner']) . '/' . rawurlencode($link['repo']);
        [$ref, $path, $sha] = $this->resolve($repoPath, GitHubLink::candidates($link['segments']));
        try {
            $folder = GitHubLink::folderName($path);
        } catch (\InvalidArgumentException $e) {
            throw new GitHubFetchError(422, $e->getMessage());
        }

        $res = $this->get('https://codeload.github.com/' . $repoPath . '/zip/' . rawurlencode($sha), self::ARCHIVE_MAX);
        if ($res['status'] === 413 || strlen($res['body']) > self::ARCHIVE_MAX) {
            throw new GitHubFetchError(413, 'The repository archive is larger than 50 MB');
        }
        if ($res['status'] === 404) {
            throw new GitHubFetchError(404, self::NOT_FOUND);
        }
        if ($res['status'] !== 200) {
            throw new GitHubFetchError(502, self::UNREACHABLE);
        }
        return $this->unpack($res['body'], $path) + [
            'folder' => $folder,
            'source' => ['url' => trim($url), 'owner' => $link['owner'], 'repo' => $link['repo'], 'ref' => $ref, 'sha' => $sha, 'path' => $path],
        ];
    }

    /** @return array{0:string, 1:string, 2:string} ref, path, sha of the first (longest) candidate ref GitHub knows */
    private function resolve(string $repoPath, array $candidates): array
    {
        foreach ($candidates as $c) {
            $res = $this->get('https://api.github.com/repos/' . $repoPath . '/commits/' . rawurlencode($c['ref']), 1024 * 1024);
            if ($res['status'] === 404 || $res['status'] === 422) {
                continue;   // not a ref: try a shorter one
            }
            if ($res['status'] !== 200) {
                throw new GitHubFetchError(502, self::UNREACHABLE);
            }
            $sha = json_decode($res['body'], true)['sha'] ?? null;
            if (!is_string($sha) || !preg_match('/^[0-9a-f]{1,64}$/i', $sha)) {
                throw new GitHubFetchError(502, self::UNREACHABLE);
            }
            return [$c['ref'], $c['path'], $sha];
        }
        throw new GitHubFetchError(404, self::NOT_FOUND);
    }

    /** @return array{status:int, body:string} */
    private function get(string $url, int $maxBytes): array
    {
        $res = ($this->http)($url, $maxBytes);
        $status = (int) ($res['status'] ?? 0);
        if ($status === 0) {
            throw new GitHubFetchError(502, self::UNREACHABLE);
        }
        if ($status === 403 || $status === 429) {
            throw new GitHubFetchError(429, self::RATE_LIMIT);
        }
        return ['status' => $status, 'body' => (string) ($res['body'] ?? '')];
    }

    /** @return array{manifest:array, fields:list<array>, files:array<string,string>} */
    private function unpack(string $bytes, string $path): array
    {
        $tmp = tempnam(sys_get_temp_dir(), 'ghzip');
        try {
            file_put_contents($tmp, $bytes);
            $zip = new \ZipArchive();
            if ($zip->open($tmp, \ZipArchive::RDONLY) !== true || $zip->numFiles === 0) {
                throw new GitHubFetchError(502, 'GitHub sent an archive that could not be read');
            }
            try {
                return $this->select($zip, $path);
            } finally {
                $zip->close();
            }
        } finally {
            @unlink($tmp);
        }
    }

    private function select(\ZipArchive $zip, string $path): array
    {
        // the archive's single top folder is <repo>-<sha>/
        $root = explode('/', (string) $zip->getNameIndex(0))[0];
        $prefix = $root . '/' . $path . '/';
        $entries = [];   // rel => [index, size]
        for ($i = 0; $i < $zip->numFiles; $i++) {
            $st = $zip->statIndex($i);
            $name = (string) ($st['name'] ?? '');
            if (str_ends_with($name, '/') || !str_starts_with($name, $prefix)) {
                continue;
            }
            $rel = substr($name, strlen($prefix));
            if (!self::safeRel($rel)) {
                continue;
            }
            if ($zip->getExternalAttributesIndex($i, $opsys, $attr) && $opsys === \ZipArchive::OPSYS_UNIX
                && (($attr >> 16) & 0170000) === 0120000) {
                continue;   // symlink
            }
            $entries[$rel] = [$i, (int) $st['size']];
        }
        if ($entries === []) {
            throw new GitHubFetchError(404, self::NOT_FOUND);
        }
        if (!isset($entries[self::MANIFEST])) {
            throw new GitHubFetchError(422, 'This folder has no synergyai-mcp.json');
        }
        $manifest = json_decode((string) $zip->getFromIndex($entries[self::MANIFEST][0]), true);
        if (!is_array($manifest) || ($manifest !== [] && array_is_list($manifest))) {
            throw new GitHubFetchError(422, 'synergyai-mcp.json is not valid JSON');
        }
        $runtime = $manifest['runtime'] ?? null;
        $runtime = ($runtime === null || $runtime === '') ? 'python' : $runtime;
        if ($runtime !== 'python' && $runtime !== 'php') {
            throw new GitHubFetchError(422, 'Unsupported runtime: ' . (is_string($runtime) ? $runtime : json_encode($runtime)));
        }

        $keep = self::selectServerFiles(array_map('strval', array_keys($entries)), $manifest);
        if ($runtime === 'php') {
            $entry = $manifest['entry'] ?? null;
            if (!is_string($entry) || $entry === '' || !in_array($entry, $keep, true)) {
                throw new GitHubFetchError(422, "The manifest's entry file is missing");
            }
        } elseif (!is_string($manifest['start'] ?? null) || $manifest['start'] === '') {
            throw new GitHubFetchError(422, 'The manifest has no start command');
        }
        if (array_sum(array_map(fn($rel) => $entries[$rel][1], $keep)) > self::FOLDER_MAX) {
            throw new GitHubFetchError(413, 'The server folder is larger than 20 MB');
        }

        $files = [];
        foreach ($keep as $rel) {
            $files[$rel] = base64_encode((string) $zip->getFromIndex($entries[$rel][0]));
        }
        $example = isset($entries['.env.example']) ? (string) $zip->getFromIndex($entries['.env.example'][0]) : '';
        return ['manifest' => $manifest, 'fields' => self::fields($manifest, $example), 'files' => $files];
    }

    private static function safeRel(string $rel): bool
    {
        foreach (explode('/', $rel) as $seg) {
            if ($seg === '' || $seg === '.' || $seg === '..' || preg_match('~[\\\\\x00-\x1f\x7f]~', $seg)) {
                return false;
            }
        }
        return true;
    }

    /** "dir/" = that directory name at any depth; no "/" = basename at any depth; inner "/" = whole path. */
    private static function matches(string $path, string $pattern): bool
    {
        $segs = explode('/', $path);
        if (str_ends_with($pattern, '/')) {
            return in_array(substr($pattern, 0, -1), array_slice($segs, 0, -1), true);
        }
        $re = '~^' . implode('.*', array_map(fn($p) => preg_quote($p, '~'), explode('*', $pattern))) . '$~sD';
        return (bool) preg_match($re, str_contains($pattern, '/') ? $path : end($segs));
    }

    /** Twin of control.select_server_files: include (if any), then exclude + defaults; dotfiles skipped but .env.example. */
    private static function selectServerFiles(array $paths, array $manifest): array
    {
        $inc = $manifest['include'] ?? null;
        $include = is_array($inc) && $inc !== [] ? array_filter($inc, 'is_string') : null;
        $exc = $manifest['exclude'] ?? null;
        $exclude = array_merge(self::DEFAULT_EXCLUDES, self::ALWAYS_EXCLUDES, is_array($exc) ? array_filter($exc, 'is_string') : []);
        $out = [];
        foreach ($paths as $p) {
            $segs = explode('/', $p);
            $base = array_pop($segs);
            foreach ($segs as $s) {
                if (str_starts_with($s, '.')) {
                    continue 2;
                }
            }
            if (str_starts_with($base, '.') && $base !== '.env.example') {
                continue;
            }
            foreach ($exclude as $x) {
                if (self::matches($p, $x)) {
                    continue 2;
                }
            }
            if ($include === null || array_filter($include, fn($x) => self::matches($p, $x)) !== []) {
                $out[] = $p;
            }
        }
        return $out;
    }

    /** Twin of envfile.fields: manifest env wins, else parsed from .env.example (comment lines above become the label). */
    private static function fields(array $manifest, string $example): array
    {
        if (isset($manifest['env']) && is_array($manifest['env']) && array_is_list($manifest['env'])) {
            $out = [];
            foreach ($manifest['env'] as $f) {
                if (is_array($f) && is_string($f['name'] ?? null)) {
                    $out[] = self::norm($f);
                }
            }
            return $out;
        }
        $out = [];
        $pending = [];
        foreach (preg_split('/\r?\n/', $example) as $raw) {
            $line = trim($raw);
            if ($line === '') {
                $pending = [];
                continue;
            }
            if (str_starts_with($line, '#')) {
                $pending[] = trim((string) preg_replace('/^#+\s*/', '', $line));
                continue;
            }
            if (!preg_match('/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/', $line, $m)) {
                $pending = [];
                continue;
            }
            $v = trim($m[2]);
            if (strlen($v) >= 2 && ($v[0] === '"' || $v[0] === "'") && $v[-1] === $v[0]) {
                $v = substr($v, 1, -1);
            }
            $out[] = self::norm(['name' => $m[1], 'label' => implode(' ', $pending), 'default' => $v]);
            $pending = [];
        }
        return $out;
    }

    private static function norm(array $f): array
    {
        $label = $f['label'] ?? '';
        $default = $f['default'] ?? null;
        return [
            'name' => $f['name'],
            'label' => is_scalar($label) && $label ? (string) $label : '',
            'required' => (bool) ($f['required'] ?? false),
            'secret' => isset($f['secret']) ? (bool) $f['secret'] : (bool) preg_match(self::SECRET_FIELD_RE, $f['name']),
            'default' => $default === null ? '' : (is_scalar($default) ? (string) $default : (string) json_encode($default)),
        ];
    }

    /** @return array{status:int, body:string} status 0 = network failure, 413 = body past $maxBytes */
    private static function curl(string $url, int $maxBytes): array
    {
        $body = '';
        $over = false;
        $headers = ['User-Agent: SynergyAI'];
        if (str_starts_with($url, 'https://api.github.com/')) {
            $headers[] = 'Accept: application/vnd.github+json';
        }
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_MAXREDIRS => 5,
            CURLOPT_TIMEOUT => self::TIMEOUT,
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_WRITEFUNCTION => static function ($ch, string $chunk) use (&$body, &$over, $maxBytes): int {
                if (strlen($body) + strlen($chunk) > $maxBytes) {
                    $over = true;
                    return 0;   // aborts the transfer
                }
                $body .= $chunk;
                return strlen($chunk);
            },
        ]);
        $ok = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);
        if ($over) {
            return ['status' => 413, 'body' => ''];
        }
        return $ok === false ? ['status' => 0, 'body' => ''] : ['status' => $status, 'body' => $body];
    }
}
