<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Controllers;

use PDO;
use Quantis\AIPortfolioAssistant\Services\SkillClashException;
use Quantis\AIPortfolioAssistant\Services\SkillForbidden;
use Quantis\AIPortfolioAssistant\Services\SkillNotFound;
use Quantis\AIPortfolioAssistant\Services\SkillPathInvalid;
use Quantis\AIPortfolioAssistant\Services\SkillStore;

/**
 * /api/v1/skills — the Docker app's skills volume (SkillStore). Without SKILLS_DIR (folder mode) every route but
 * /store answers 404. Paths travel as query/body fields because they contain "/"; file bytes are base64 both ways.
 * `as=robot` only narrows the view to what the robot may see, so any signed-in user may ask for it.
 */
final class SkillStoreController
{
    /** @var \Closure(): ?SkillStore */
    private \Closure $storeFactory;

    public function __construct(private readonly PDO $db, private readonly array $config, ?\Closure $storeFactory = null)
    {
        $this->storeFactory = $storeFactory ?? fn() => SkillStore::fromEnv($this->config);
    }

    public function store(array $request): array
    {
        $s = ($this->storeFactory)();
        return ['success' => true, 'data' => [
            'mode' => $s === null ? 'folder' : 'volume',
            'edition' => (string) ($this->config['edition'] ?? ''),
        ], 'status_code' => 200];
    }

    public function list(array $request): array
    {
        return $this->run(fn(SkillStore $s) => $s->list(self::uid($request), self::robot($request)));
    }

    public function files(array $request): array
    {
        return $this->run(function (SkillStore $s) use ($request) {
            $files = $s->files(self::uid($request), self::q($request, 'path'), self::robot($request));
            return ['files' => array_map('base64_encode', $files)];
        });
    }

    public function readFile(array $request): array
    {
        return $this->run(fn(SkillStore $s) => ['content' => base64_encode(
            $s->readFile(self::uid($request), self::q($request, 'path'), self::q($request, 'rel'), self::robot($request))
        )]);
    }

    public function writeFile(array $request): array
    {
        return $this->run(function (SkillStore $s) use ($request) {
            $b = self::body($request);
            $s->writeFile(self::uid($request), (string) ($b['path'] ?? ''), (string) ($b['rel'] ?? ''), self::decode($b['content'] ?? null));
            return [];
        });
    }

    public function import(array $request): array
    {
        return $this->run(function (SkillStore $s) use ($request) {
            $b = self::body($request);
            $in = $b['files'] ?? null;
            if (!is_array($in)) {
                throw new SkillPathInvalid('files must be an object of base64 contents.');
            }
            $files = [];
            foreach ($in as $rel => $content) {
                $files[(string) $rel] = self::decode($content);
            }
            return $s->import(self::uid($request), (string) ($b['path'] ?? ''), $files, (string) ($b['visibility'] ?? 'private'));
        });
    }

    public function visibility(array $request): array
    {
        return $this->run(function (SkillStore $s) use ($request) {
            $b = self::body($request);
            $s->setVisibility(self::uid($request), (string) ($b['path'] ?? ''), (string) ($b['visibility'] ?? ''));
            return [];
        });
    }

    public function move(array $request): array
    {
        return $this->run(function (SkillStore $s) use ($request) {
            $b = self::body($request);
            $s->move(self::uid($request), (string) ($b['from'] ?? ''), (string) ($b['to'] ?? ''));
            return ['path' => (string) ($b['to'] ?? '')];
        });
    }

    public function delete(array $request): array
    {
        return $this->run(function (SkillStore $s) use ($request) {
            $s->delete(self::uid($request), self::q($request, 'path'));
            return [];
        });
    }

    /** @param \Closure(SkillStore): mixed $fn */
    private function run(\Closure $fn): array
    {
        $s = ($this->storeFactory)();
        if ($s === null) {
            return ['success' => false, 'data' => ['message' => 'no skill store'], 'error' => 'no skill store', 'status_code' => 404];
        }
        try {
            return ['success' => true, 'data' => $fn($s), 'status_code' => 200];
        } catch (SkillClashException) {
            return ['success' => false, 'data' => ['clash' => 'different'], 'error' => 'clash', 'status_code' => 409];
        } catch (SkillNotFound | SkillForbidden | SkillPathInvalid $e) {
            return ['success' => false, 'data' => ['message' => $e->getMessage()], 'error' => $e->getMessage(), 'status_code' => $e->statusCode()];
        }
    }

    private static function uid(array $request): int
    {
        return (int) $request['user_id'];
    }

    private static function robot(array $request): bool
    {
        return ($request['query']['as'] ?? '') === 'robot';
    }

    private static function q(array $request, string $key): string
    {
        return (string) ($request['query'][$key] ?? '');
    }

    private static function body(array $request): array
    {
        return (array) ($request['body'] ?? []);
    }

    private static function decode(mixed $v): string
    {
        $bytes = is_string($v) ? base64_decode($v, true) : false;
        if ($bytes === false) {
            throw new SkillPathInvalid('Content must be valid base64.');
        }
        return $bytes;
    }
}
