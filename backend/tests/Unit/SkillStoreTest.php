<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Services\SkillClashException;
use Quantis\AIPortfolioAssistant\Services\SkillForbidden;
use Quantis\AIPortfolioAssistant\Services\SkillNotFound;
use Quantis\AIPortfolioAssistant\Services\SkillPathInvalid;
use Quantis\AIPortfolioAssistant\Services\SkillStore;

final class SkillStoreTest extends TestCase
{
    private string $root;

    protected function setUp(): void
    {
        $this->root = sys_get_temp_dir() . '/skillstore_' . bin2hex(random_bytes(6));
        mkdir($this->root);
    }

    protected function tearDown(): void
    {
        exec('rm -rf ' . escapeshellarg($this->root));
    }

    private function store(string $edition = 'corporate'): SkillStore
    {
        return new SkillStore($this->root, $edition);
    }

    private function skill(string $name = 'docx', string $extra = ''): array
    {
        return [
            'SKILL.md' => "---\nname: $name\ndescription: Does $name\ndependencies: [python-docx, lxml]\n---\nBody$extra\n",
            'scripts/run.py' => "print('hi')\n",
        ];
    }

    public function test_import_defaults_private_and_lists_only_for_owner(): void
    {
        $s = $this->store();
        $this->assertSame(['status' => 'installed'], $s->import(1, 'docx', $this->skill()));
        $rows = $s->list(1);
        $this->assertCount(1, $rows);
        $this->assertSame('private', $rows[0]['visibility']);
        $this->assertTrue($rows[0]['mine']);
        $this->assertSame('docx', $rows[0]['name']);
        $this->assertSame('Does docx', $rows[0]['description']);
        $this->assertSame(['python-docx', 'lxml'], $rows[0]['dependencies']);
        $this->assertSame([], $s->list(2));
    }

    public function test_public_skill_listed_for_everyone_with_owner(): void
    {
        $s = $this->store();
        $s->import(1, 'docx', $this->skill());
        $s->setVisibility(1, 'docx', 'public');
        $rows = $s->list(2);
        $this->assertCount(1, $rows);
        $this->assertSame('public', $rows[0]['visibility']);
        $this->assertFalse($rows[0]['mine']);
        $this->assertSame(1, $rows[0]['owner_id']);
        $this->assertDirectoryExists($this->root . '/public/docx');
        $this->assertDirectoryDoesNotExist($this->root . '/users/1/docx');
    }

    public function test_individual_edition_never_public(): void
    {
        $s = $this->store('individual');
        $s->import(1, 'docx', $this->skill());
        $this->expectException(SkillForbidden::class);
        $s->setVisibility(1, 'docx', 'public');
    }

    public function test_robot_sees_all_in_individual_public_only_in_corporate(): void
    {
        foreach (['individual' => 2, 'corporate' => 1] as $edition => $expected) {
            $root = $this->root . '/' . $edition;
            mkdir($root);
            $s = new SkillStore($root, $edition);
            $s->import(1, 'a', $this->skill('a'));
            $s->import(2, 'b', $this->skill('b'));
            if ($edition === 'corporate') {
                $s->setVisibility(1, 'a', 'public');
            }
            $this->assertCount($expected, $s->list(99, true), $edition);
        }
        $this->assertSame('print(\'hi\')' . "\n", (new SkillStore($this->root . '/individual', 'individual'))->readFile(99, 'b', 'scripts/run.py', true));
    }

    public function test_identical_reimport_reports_identical(): void
    {
        $s = $this->store();
        $s->import(1, 'docx', $this->skill());
        $this->assertSame(['status' => 'identical'], $s->import(1, 'docx', $this->skill()));
    }

    public function test_different_reimport_throws_clash(): void
    {
        $s = $this->store();
        $s->import(1, 'docx', $this->skill());
        $this->expectException(SkillClashException::class);
        $s->import(1, 'docx', $this->skill('docx', 'changed'));
    }

    public function test_leaf_name_unique_across_public_and_own_private(): void
    {
        $s = $this->store();
        $s->import(1, 'docx', $this->skill());
        $s->setVisibility(1, 'docx', 'public');
        try {
            $s->import(2, 'x/docx', $this->skill());
            $this->fail('expected clash');
        } catch (SkillClashException $e) {
            $this->assertSame(409, $e->statusCode());
            $this->assertStringNotContainsString('users/1', $e->getMessage());
            $this->assertStringNotContainsString('owner', strtolower($e->getMessage()));
        }
        // A's private skill does not block B.
        $s->import(1, 'pdf', $this->skill('pdf'));
        $this->assertSame(['status' => 'installed'], $s->import(2, 'x/pdf', $this->skill('pdf')));
        // B's own private skill blocks B.
        $this->expectException(SkillClashException::class);
        $s->import(2, 'y/pdf', $this->skill('pdf'));
    }

    public function test_clash_with_other_private_never_reveals(): void
    {
        $s = $this->store();
        $s->import(1, 'docx', $this->skill());
        $this->assertSame(['status' => 'installed'], $s->import(2, 'docx', $this->skill('docx', 'mine')));
    }

    public function test_make_public_blocked_by_existing_public_leaf(): void
    {
        $s = $this->store();
        $s->import(1, 'docx', $this->skill());
        $s->import(2, 'g/docx', $this->skill('docx', 'b'));
        $s->setVisibility(1, 'docx', 'public');
        $this->expectException(SkillClashException::class);
        $s->setVisibility(2, 'g/docx', 'public');
    }

    public function test_only_owner_writes_deletes_moves_changes_visibility(): void
    {
        $s = $this->store();
        $s->import(1, 'docx', $this->skill());
        $s->setVisibility(1, 'docx', 'public');
        $ops = [
            fn() => $s->writeFile(2, 'docx', 'SKILL.md', 'x'),
            fn() => $s->delete(2, 'docx'),
            fn() => $s->move(2, 'docx', 'other'),
            fn() => $s->setVisibility(2, 'docx', 'private'),
        ];
        foreach ($ops as $op) {
            try {
                $op();
                $this->fail('expected 403');
            } catch (SkillForbidden $e) {
                $this->assertSame(403, $e->statusCode());
            }
        }
        $this->assertSame("print('hi')\n", $s->readFile(2, 'docx', 'scripts/run.py'));
    }

    public function test_private_of_other_is_not_found(): void
    {
        $s = $this->store();
        $s->import(1, 'docx', $this->skill());
        $this->expectException(SkillNotFound::class);
        $s->files(2, 'docx');
    }

    public function test_owner_write_and_delete(): void
    {
        $s = $this->store();
        $s->import(1, 'g/docx', $this->skill());
        $s->writeFile(1, 'g/docx', 'notes/a.txt', 'A');
        $this->assertSame('A', $s->readFile(1, 'g/docx', 'notes/a.txt'));
        $s->delete(1, 'g/docx');
        $this->assertSame([], $s->list(1));
        $this->assertNull($s->absolutePath(1, 'g/docx'));
    }

    public function test_group_paths(): void
    {
        $s = $this->store();
        $s->import(1, 'GEO/geo-report', $this->skill('geo-report'));
        $this->assertSame('GEO/geo-report', $s->list(1)[0]['path']);
        $this->assertStringContainsString('Body', $s->readFile(1, 'GEO/geo-report', 'SKILL.md'));
        $s->move(1, 'GEO/geo-report', 'geo-report');
        $this->assertSame('geo-report', $s->list(1)[0]['path']);
        $this->assertDirectoryDoesNotExist($this->root . '/users/1/GEO');
        $this->assertNotNull($s->absolutePath(1, 'geo-report'));
    }

    public function test_rejects_unsafe_paths(): void
    {
        $s = $this->store();
        foreach (['../x', '/x', 'a/.hidden', 'a//b', '', 'a\\b', 'a/b/c'] as $bad) {
            try {
                $s->import(1, $bad, $this->skill());
                $this->fail("accepted '$bad'");
            } catch (SkillPathInvalid $e) {
                $this->assertSame(400, $e->statusCode());
            }
        }
        $s->import(1, 'ok', $this->skill());
        $this->expectException(SkillPathInvalid::class);
        $s->readFile(1, 'ok', '../../secret');
    }

    public function test_files_excludes_native_wheels(): void
    {
        $s = $this->store();
        $f = $this->skill() + ['.wheels/a.whl' => 'W', '.wheels/native/b.whl' => 'N'];
        $s->import(1, 'docx', $f);
        $this->assertSame(['.wheels/a.whl', 'SKILL.md', 'scripts/run.py'], array_keys($this->sorted($s->files(1, 'docx'))));
        $this->assertSame(['SKILL.md', 'scripts/run.py'], array_keys($this->sorted($s->files(1, 'docx', false, false))));
        // identical ignores wheels
        $this->assertSame('identical', $s->import(1, 'docx', $this->skill())['status']);
    }

    private function sorted(array $a): array
    {
        ksort($a);
        return $a;
    }
}
