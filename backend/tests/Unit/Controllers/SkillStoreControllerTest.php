<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit\Controllers;

use PDO;
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Controllers\SkillStoreController;
use Quantis\AIPortfolioAssistant\Services\SkillStore;

final class SkillStoreControllerTest extends TestCase
{
    private string $root;

    protected function setUp(): void
    {
        $this->root = sys_get_temp_dir() . '/skillctl-' . bin2hex(random_bytes(4));
        mkdir($this->root);
    }

    protected function tearDown(): void
    {
        exec('rm -rf ' . escapeshellarg($this->root));
        unset($_ENV['SKILLS_DIR']);
    }

    private function ctl(bool $volume = true, string $edition = 'individual'): SkillStoreController
    {
        $store = $volume ? new SkillStore($this->root, $edition) : null;
        return new SkillStoreController(new PDO('sqlite::memory:'), ['edition' => $edition], fn() => $store);
    }

    private function req(array $q = [], array $b = [], int $uid = 7): array
    {
        return ['user_id' => $uid, 'query' => $q, 'body' => $b];
    }

    private function import(SkillStoreController $c, string $path = 'g/demo', string $text = 'hi'): array
    {
        return $c->import($this->req([], ['path' => $path, 'visibility' => 'private',
            'files' => ['SKILL.md' => base64_encode("---\nname: demo\ndescription: d\n---\n$text")]]));
    }

    public function test_store_reports_folder_mode_without_SKILLS_DIR(): void
    {
        $r = (new SkillStoreController(new PDO('sqlite::memory:'), []))->store($this->req());
        self::assertTrue($r['success']);
        self::assertSame('folder', $r['data']['mode']);
    }

    public function test_store_reports_volume_mode_and_edition(): void
    {
        $r = $this->ctl(true, 'corporate')->store($this->req());
        self::assertSame(['mode' => 'volume', 'edition' => 'corporate'], $r['data']);
    }

    public function test_routes_404_in_folder_mode(): void
    {
        $c = $this->ctl(false);
        foreach ([$c->list($this->req()), $c->files($this->req(['path' => 'a'])), $c->readFile($this->req(['path' => 'a', 'rel' => 'b'])),
                  $c->writeFile($this->req()), $c->import($this->req()), $c->visibility($this->req()),
                  $c->move($this->req()), $c->delete($this->req(['path' => 'a']))] as $r) {
            self::assertSame(404, $r['status_code']);
            self::assertSame('no skill store', $r['data']['message']);
        }
    }

    public function test_list_names_the_owner_of_skills_that_are_not_mine(): void
    {
        $db = new PDO('sqlite::memory:');
        $db->exec('CREATE TABLE users (id INTEGER, email TEXT, first_name TEXT, last_name TEXT)');
        $db->exec("INSERT INTO users VALUES (7, 'a@x.io', 'Ada', 'Lovelace'), (9, 'z@x.io', '', '')");
        $store = new SkillStore($this->root, 'corporate');
        $c = new SkillStoreController($db, ['edition' => 'corporate'], fn() => $store);
        $c->import($this->req([], ['path' => 'one', 'visibility' => 'public', 'files' => ['SKILL.md' => base64_encode("---\nname: one\ndescription: d\n---\n")]], 7));
        $c->import($this->req([], ['path' => 'two', 'visibility' => 'public', 'files' => ['SKILL.md' => base64_encode("---\nname: two\ndescription: d\n---\n")]], 9));
        $c->import($this->req([], ['path' => 'three', 'visibility' => 'public', 'files' => ['SKILL.md' => base64_encode("---\nname: three\ndescription: d\n---\n")]], 55));
        $by = [];
        foreach ($c->list($this->req([], [], 8))['data'] as $r) {
            $by[$r['path']] = $r['owner_name'];
        }
        ksort($by);
        self::assertSame(['one' => 'Ada Lovelace', 'three' => '', 'two' => 'z@x.io'], $by);
    }

    public function test_import_list_files_file_roundtrip(): void
    {
        $c = $this->ctl();
        $r = $this->import($c);
        self::assertSame(['status' => 'installed'], $r['data']);
        self::assertSame('identical', $this->import($c)['data']['status']);
        $rows = $c->list($this->req())['data'];
        self::assertSame('g/demo', $rows[0]['path']);
        $f = $c->files($this->req(['path' => 'g/demo']))['data']['files'];
        self::assertSame(['SKILL.md'], array_keys($f));
        $w = $c->writeFile($this->req([], ['path' => 'g/demo', 'rel' => 'a/b.txt', 'content' => base64_encode("x\0y")]));
        self::assertTrue($w['success']);
        $g = $c->readFile($this->req(['path' => 'g/demo', 'rel' => 'a/b.txt']));
        self::assertSame("x\0y", base64_decode($g['data']['content']));
    }

    public function test_files_leaves_wheels_out_when_wheels_is_0(): void
    {
        $c = $this->ctl();
        $c->import($this->req([], ['path' => 'g/demo', 'visibility' => 'private', 'files' => [
            'SKILL.md' => base64_encode("---\nname: demo\ndescription: d\n---\nhi"),
            '.wheels/pyodide/a.whl' => base64_encode('W'),
        ]]));
        $all = array_keys($c->files($this->req(['path' => 'g/demo']))['data']['files']);
        sort($all);
        self::assertSame(['.wheels/pyodide/a.whl', 'SKILL.md'], $all);
        $plain = $c->files($this->req(['path' => 'g/demo', 'wheels' => '0']))['data']['files'];
        self::assertSame(['SKILL.md'], array_keys($plain));
    }

    public function test_exception_status_codes_pass_through(): void
    {
        $c = $this->ctl(true, 'corporate');
        $this->import($c);
        $c->visibility($this->req([], ['path' => 'g/demo', 'visibility' => 'public']));
        $clash = $this->import($c, 'g/demo', 'other');
        self::assertSame(409, $clash['status_code']);
        self::assertSame('different', $clash['data']['clash']);
        self::assertSame("A different skill is already installed at 'g/demo'.", $clash['data']['message']);
        // A move onto a taken path says which path.
        $this->import($c, 'g/a', 'a');
        $this->import($c, 'g/b', 'b');
        $mv = $c->move($this->req([], ['from' => 'g/a', 'to' => 'g/b']));
        self::assertSame(409, $mv['status_code']);
        self::assertSame('different', $mv['data']['clash']);
        self::assertSame("A skill already exists at 'g/b'.", $mv['data']['message']);
        self::assertSame(404, $c->files($this->req(['path' => 'nope']))['status_code']);
        self::assertSame(403, $c->writeFile($this->req([], ['path' => 'g/demo', 'rel' => 'x', 'content' => ''], 8))['status_code']);
        self::assertSame(404, $c->readFile($this->req(['path' => 'g/demo', 'rel' => 'zzz'], [], 7))['status_code']);
    }

    public function test_bad_path_passes_through_as_400(): void
    {
        $c = $this->ctl();
        self::assertSame(400, $c->files($this->req(['path' => '../x']))['status_code']);
        self::assertSame(400, $c->import($this->req([], ['path' => '../x', 'files' => []]))['status_code']);
    }

    public function test_bad_base64_is_400(): void
    {
        $c = $this->ctl();
        self::assertSame(400, $c->import($this->req([], ['path' => 'a', 'files' => ['SKILL.md' => '***']]))['status_code']);
        self::assertSame(400, $c->writeFile($this->req([], ['path' => 'a', 'rel' => 'x', 'content' => '!!']))['status_code']);
        self::assertSame(400, $c->import($this->req([], ['path' => 'a', 'files' => 'nope']))['status_code']);
    }

    public function test_as_robot_requires_robot_workflow_access(): void
    {
        // Any signed-in user may ask for as=robot; it only narrows to robot visibility.
        $c = $this->ctl(true, 'corporate');
        $this->import($c);
        self::assertCount(1, $c->list($this->req())['data']);
        $r = $c->list($this->req(['as' => 'robot'], [], 8));
        self::assertTrue($r['success']);
        self::assertSame([], $r['data']);
        self::assertSame(404, $c->files($this->req(['path' => 'g/demo', 'as' => 'robot']))['status_code']);
    }

    public function test_visibility_move_delete(): void
    {
        $c = $this->ctl(true, 'corporate');
        $this->import($c);
        self::assertTrue($c->visibility($this->req([], ['path' => 'g/demo', 'visibility' => 'public']))['success']);
        self::assertSame('public', $c->list($this->req())['data'][0]['visibility']);
        self::assertSame(['path' => 'g/new'], $c->move($this->req([], ['from' => 'g/demo', 'to' => 'g/new']))['data']);
        self::assertTrue($c->delete($this->req(['path' => 'g/new']))['success']);
        self::assertSame([], $c->list($this->req())['data']);
    }
}
