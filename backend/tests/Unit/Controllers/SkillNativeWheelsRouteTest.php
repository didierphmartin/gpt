<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit\Controllers;

use PDO;
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Controllers\SkillStoreController;
use Quantis\AIPortfolioAssistant\Services\SkillWheelFetcher;

final class SkillNativeWheelsRouteTest extends TestCase
{
    private function call(array $body, \Closure $runner): array
    {
        // No store factory result (folder mode): the route must still work.
        $c = new SkillStoreController(new PDO('sqlite::memory:'), [], fn() => null, new SkillWheelFetcher($runner));
        return $c->nativeWheels(['user_id' => 1, 'body' => $body]);
    }

    public function test_bad_dependencies_are_400(): void
    {
        $never = fn() => $this->fail('no command expected');
        $this->assertSame(400, $this->call(['dependencies' => 'foo'], $never)['status_code']);
        $this->assertSame(400, $this->call([], $never)['status_code']);
        $this->assertSame(400, $this->call(['dependencies' => ['--index-url=x']], fn() => ['code' => 0, 'out' => ''])['status_code']);
    }

    public function test_empty_list_gives_empty_wheels_object(): void
    {
        $r = $this->call(['dependencies' => []], fn() => $this->fail('no command expected'));
        $this->assertSame(200, $r['status_code']);
        $this->assertSame('{"wheels":{}}', json_encode($r['data']));
    }

    public function test_no_wheel_is_422_with_library_and_platform(): void
    {
        $r = $this->call(['dependencies' => ['foo']], function (array $argv): array {
            if (in_array('--version', $argv, true)) {
                return ['code' => 0, 'out' => ''];
            }
            if ($argv[3] === 'wheel') {
                return ['code' => 1, 'out' => 'build failed'];
            }
            return ['code' => 1, 'out' => 'ERROR: No matching distribution found for foo'];
        });
        $this->assertSame(422, $r['status_code']);
        $this->assertSame('foo', $r['data']['library']);
        $this->assertSame('manylinux_2_17_x86_64', $r['data']['platform']);
    }

    public function test_wheels_come_back_base64(): void
    {
        $r = $this->call(['dependencies' => ['foo']], function (array $argv): array {
            if (!in_array('--version', $argv, true)) {
                $d = $argv[array_search('--dest', $argv, true) + 1];
                file_put_contents("$d/foo-1-py3-none-any.whl", 'abc');
            }
            return ['code' => 0, 'out' => ''];
        });
        $this->assertSame(['foo-1-py3-none-any.whl' => base64_encode('abc')], (array) $r['data']['wheels']);
    }
}
