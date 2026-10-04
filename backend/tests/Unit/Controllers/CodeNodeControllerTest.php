<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit\Controllers;

use AgentTeam\Controllers\CodeNodeController;
use PDO;
use PHPUnit\Framework\TestCase;

final class CodeNodeControllerTest extends TestCase
{
    private array $calls = [];

    private function controller(array $answer = ['ok' => true, 'result' => ['content' => []]]): CodeNodeController
    {
        $factory = function (int $userId) use ($answer): \Closure {
            return function (string $server, string $tool, array $args) use ($userId, $answer): array {
                $this->calls[] = [$userId, $server, $tool, $args];
                return $answer;
            };
        };
        return new CodeNodeController(new PDO('sqlite::memory:'), [], $factory);
    }

    public function testCallsTheToolAsTheUser(): void
    {
        $r = $this->controller()->toolCall(['user_id' => 7, 'body' => ['server' => 'servicenow', 'tool' => 'poll_jobs', 'args' => ['tag' => 'x']]]);
        self::assertSame(['ok' => true, 'result' => ['content' => []]], $r);
        self::assertSame([[7, 'servicenow', 'poll_jobs', ['tag' => 'x']]], $this->calls);
    }

    public function testToolErrorIsAnOkFalseAnswer(): void
    {
        $r = $this->controller(['ok' => false, 'error' => 'MCP tool not found'])
            ->toolCall(['user_id' => 7, 'body' => ['server' => 'okta', 'tool' => 'reset']]);
        self::assertSame(['ok' => false, 'error' => 'MCP tool not found'], $r);
        self::assertSame([], $this->calls[0][3], 'missing args become {}');
    }

    public function testRefusesWithoutUserOrWithBadInput(): void
    {
        self::assertSame(['ok' => false, 'error' => 'Authentication required'], $this->controller()->toolCall(['body' => []]));
        foreach ([['server' => 'Service Now', 'tool' => 'x'], ['server' => 'servicenow', 'tool' => 'a b'],
                  ['server' => 'servicenow', 'tool' => 'x', 'args' => 'nope'], ['tool' => 'x']] as $body) {
            $r = $this->controller()->toolCall(['user_id' => 7, 'body' => $body]);
            self::assertFalse($r['ok'], json_encode($body));
        }
        self::assertSame([], $this->calls);
    }
}
