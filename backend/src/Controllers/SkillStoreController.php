<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Controllers;

use PDO;
use Quantis\AIPortfolioAssistant\Services\SkillClashException;
use Quantis\AIPortfolioAssistant\Services\RobotSkillPolicy;
use Quantis\AIPortfolioAssistant\Services\SkillForbidden;
use Quantis\AIPortfolioAssistant\Services\SkillInUse;
use Quantis\AIPortfolioAssistant\Services\SkillNotFound;
use Quantis\AIPortfolioAssistant\Services\SkillPathInvalid;
use Quantis\AIPortfolioAssistant\Services\SkillStore;
use Quantis\AIPortfolioAssistant\Services\SkillWheelError;
use Quantis\AIPortfolioAssistant\Services\SkillWheelFetcher;

/**
 * /api/v1/skills — the Docker app's skills volume (SkillStore). Without SKILLS_DIR (folder mode) every route but
 * /store answers 404. Paths travel as query/body fields because they contain "/"; file bytes are base64 both ways.
 * `as=robot` only narrows the view to what the robot may see, so any signed-in user may ask for it.
 */
final class SkillStoreController
{
    /** @var \Closure(): ?SkillStore */
    private \Closure $storeFactory;

    private SkillWheelFetcher $wheels;

    public function __construct(private readonly PDO $db, private readonly array $config, ?\Closure $storeFactory = null, ?SkillWheelFetcher $wheels = null)
    {
        $this->wheels = $wheels ?? new SkillWheelFetcher();
        $this->storeFactory = $storeFactory ?? fn() => SkillStore::fromEnv(
            $this->config,
            fn(string $leaf) => (new RobotSkillPolicy($this->db, $this->config, null))->robotWorkflowsUsing($leaf)
        );
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

    /** Works in both modes (the export needs it everywhere), so it bypasses the "no skill store" guard. */
    public function nativeWheels(array $request): array
    {
        $deps = self::body($request)['dependencies'] ?? null;
        if (!is_array($deps) || array_filter($deps, fn($d) => !is_string($d))) {
            return ['success' => false, 'data' => ['message' => 'dependencies must be a list of strings.'], 'error' => 'dependencies must be a list of strings.', 'status_code' => 400];
        }
        try {
            $wheels = array_map('base64_encode', $this->wheels->fetch(array_values($deps)));
            return ['success' => true, 'data' => ['wheels' => (object) $wheels], 'status_code' => 200];
        } catch (SkillWheelError $e) {
            return ['success' => false, 'data' => ['message' => $e->getMessage()] + $e->data(), 'error' => $e->getMessage(), 'status_code' => $e->statusCode()];
        }
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
        } catch (SkillInUse $e) {
            return ['success' => false, 'data' => ['message' => $e->getMessage(), 'robot_workflows' => $e->workflows()], 'error' => $e->getMessage(), 'status_code' => $e->statusCode()];
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
