<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Services\SkillClashException;
use Quantis\AIPortfolioAssistant\Services\SkillForbidden;
use Quantis\AIPortfolioAssistant\Services\SkillNotFound;
use Quantis\AIPortfolioAssistant\Services\SkillPathInvalid;
use Quantis\AIPortfolioAssistant\Services\SkillRequiredBy;
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

    public function test_python_bytecode_is_not_skill_content(): void
    {
        $s = $this->store();
        $s->import(1, 'docx', $this->skill());
        // A run left Python's bytecode cache in the stored skill (older clients saved it back).
        $s->writeFile(1, 'docx', 'scripts/__pycache__/run.cpython-312.pyc', "\x00bytecode");
        $s->writeFile(1, 'docx', 'scripts/old.pyc', "\x00bytecode");
        $this->assertSame(['status' => 'identical'], $s->import(1, 'docx', $this->skill()));
        $this->assertSame('identical', $s->import(1, 'g/docx', $this->skill())['status']);
        // Incoming bytecode does not make an otherwise identical copy different either.
        $withPyc = $this->skill() + ['scripts/__pycache__/x.pyc' => 'b'];
        $this->assertSame(['status' => 'identical'], $s->import(1, 'docx', $withPyc));
        // And it is never served.
        $this->assertSame(['SKILL.md', 'scripts/run.py'], $this->sortedKeys($s->files(1, 'docx')));
    }

    /** @param array<string,string> $a */
    private function sortedKeys(array $a): array
    {
        $k = array_map('strval', array_keys($a));
        sort($k);
        return $k;
    }

    public function test_identical_reimport_reports_identical(): void
    {
        $s = $this->store();
        $s->import(1, 'docx', $this->skill());
        $this->assertSame(['status' => 'identical'], $s->import(1, 'docx', $this->skill()));
    }

    public function test_dry_run_import_reports_without_writing(): void
    {
        $s = $this->store();
        $this->assertSame(['status' => 'new'], $s->import(1, 'docx', $this->skill(), 'private', true));
        $this->assertSame([], $s->list(1));
        $this->assertFileDoesNotExist($this->root . '/users/1/docx/SKILL.md');
        $s->import(1, 'docx', $this->skill());
        $this->assertSame(['status' => 'identical'], $s->import(1, 'docx', $this->skill(), 'private', true));
        $this->expectException(SkillClashException::class);
        $s->import(1, 'docx', $this->skill('docx', 'changed'), 'private', true);
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
            $s->import(2, 'x/docx', $this->skill('docx', 'other'));
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
        $s->import(2, 'y/pdf', $this->skill('pdf', 'other'));
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

    public function test_identical_copy_under_other_group_or_of_public_is_identical(): void
    {
        $s = $this->store();
        $s->import(1, 'docx', $this->skill());
        $this->assertSame('identical', $s->import(1, 'g/docx', $this->skill())['status']);
        $s->setVisibility(1, 'docx', 'public');
        $this->assertSame('identical', $s->import(2, 'docx', $this->skill())['status']);
        $this->expectException(SkillClashException::class);
        $s->import(2, 'docx', $this->skill('docx', 'changed'));
    }

    public function test_individual_robot_grouped_path_does_not_match_leaf(): void
    {
        $s = $this->store('individual');
        $s->import(1, 'g/docx', $this->skill());
        $this->assertNull($s->absolutePath(99, 'docx', true));
        $this->assertNotNull($s->absolutePath(99, 'g/docx', true));
    }

    public function test_write_failures_throw(): void
    {
        $s = $this->store();
        $s->import(1, 'docx', $this->skill());
        chmod($this->root, 0555);
        try {
            $s->import(1, 'pdf', $this->skill('pdf'));
            $this->fail('expected failure');
        } catch (\RuntimeException $e) {
            $this->assertNotInstanceOf(SkillClashException::class, $e);
        } finally {
            chmod($this->root, 0755);
        }
    }

    public function test_corporate_robot_ignores_its_own_private_skills(): void
    {
        $s = $this->store('corporate');
        $s->import(99, 'mine', $this->skill('mine'));
        $this->assertSame([], $s->list(99, true));
        $this->assertNull($s->absolutePath(99, 'mine', true));
        $this->assertCount(1, $s->list(99));
    }

    public function test_move_public_checks_owner_private_leaf(): void
    {
        $s = $this->store();
        $s->import(1, 'docx', $this->skill());
        $s->setVisibility(1, 'docx', 'public');
        $s->import(1, 'pdf', $this->skill('pdf'));
        $this->expectException(SkillClashException::class);
        $s->move(1, 'docx', 'g/pdf');
    }

    public function test_import_clears_stale_folder_without_index_entry(): void
    {
        $s = $this->store();
        mkdir($this->root . '/users/1/docx', 0775, true);
        file_put_contents($this->root . '/users/1/docx/stale.txt', 'old');
        $s->import(1, 'docx', $this->skill());
        $this->assertArrayNotHasKey('stale.txt', $s->files(1, 'docx'));
    }

    /** A skill whose script loads $needs (load_script-style quoted name). */
    private function loader(string $name, string ...$needs): array
    {
        return ['SKILL.md' => "---\nname: $name\n---\n", 'scripts/create.py' => implode("\n", array_map(fn($n) => "load_script('$n', 'create.py')", $needs)) . "\n"];
    }

    private function refused(callable $fn): SkillRequiredBy
    {
        try {
            $fn();
        } catch (SkillRequiredBy $e) {
            return $e;
        }
        $this->fail('expected SkillRequiredBy');
    }

    public function test_delete_and_rename_refused_while_another_skill_requires_it_regroup_allowed(): void
    {
        $s = $this->store();
        $s->import(1, 'flow', $this->loader('flow'));
        $s->import(1, 'auto', $this->loader('auto', 'flow'));
        $e = $this->refused(fn() => $s->delete(1, 'flow'));
        $this->assertSame(409, $e->statusCode());
        $this->assertSame(['auto'], $e->data()['required_by']);
        $this->assertSame('"flow" can\'t be deleted: auto need(s) it to run (listed in its required skills). Delete auto first, or remove "flow" from its required skills.', $e->getMessage());
        $e = $this->refused(fn() => $s->move(1, 'flow', 'flow2'));
        $this->assertSame('"flow" can\'t be renamed: auto need(s) it to run (listed in its required skills).', $e->getMessage());
        $s->move(1, 'flow', 'grp/flow');   // regrouping keeps the leaf: still found
        $this->assertSame(['auto', 'grp/flow'], array_column($s->list(1), 'path'));
        $s->delete(1, 'auto');
        $s->delete(1, 'grp/flow');
        $this->assertSame([], $s->list(1));
    }

    public function test_another_users_private_dependent_never_blocks_or_shows(): void
    {
        $s = $this->store();
        $s->import(1, 'flow', $this->loader('flow'));
        $s->setVisibility(1, 'flow', 'public');
        $s->import(2, 'auto', $this->loader('auto', 'flow'));   // user 2's private skill needs it
        $s->delete(1, 'flow');
        $this->assertSame([], $s->list(1));
    }

    public function test_make_public_takes_own_private_required_skills_along_atomically(): void
    {
        $s = $this->store();
        $s->import(1, 'pb', $this->loader('pb'));
        $s->import(1, 'flow', $this->loader('flow', 'pb'));
        $s->import(1, 'auto', $this->loader('auto', 'flow'));
        $this->assertSame(['made_public' => ['flow', 'pb']], $s->setVisibility(1, 'auto', 'public', true));
        $this->assertSame(['private', 'private', 'private'], array_column($s->list(1), 'visibility'));   // dry run: nothing changed
        $this->assertSame(['made_public' => ['flow', 'pb']], $s->setVisibility(1, 'auto', 'public'));
        $this->assertSame(['public', 'public', 'public'], array_column($s->list(1), 'visibility'));
        $this->assertCount(3, $s->list(2));
        // Private again is refused while a public skill needs it.
        $e = $this->refused(fn() => $s->setVisibility(1, 'flow', 'private'));
        $this->assertSame('"flow" can\'t be made private: the public skill(s) auto need it to run.', $e->getMessage());
        $this->assertSame(['auto'], $e->data()['required_by']);
        $s->setVisibility(1, 'auto', 'private');
        $this->assertSame(['made_public' => []], $s->setVisibility(1, 'auto', 'public'));
    }

    public function test_make_public_clash_rolls_back(): void
    {
        $s = $this->store();
        $s->import(1, 'pb', $this->loader('pb'));
        $s->import(1, 'auto', $this->loader('auto', 'pb'));
        $s->import(2, 'g/pb', $this->loader('pb', 'zzz'));   // user 2's private pb (does not block user 1 yet)
        $s->setVisibility(2, 'g/pb', 'public');               // a public pb now exists: user 1's pb can no longer go public
        try {
            $s->setVisibility(1, 'auto', 'public');
            $this->fail('expected clash');
        } catch (SkillClashException $e) {
            $this->assertStringContainsString("'pb'", $e->getMessage());
        }
        $this->assertSame(['private', 'private'], array_column(array_filter($s->list(1), fn($r) => $r['mine']), 'visibility'));
    }

    public function test_make_public_refused_when_a_required_skill_cannot_be_made_public(): void
    {
        $s = $this->store();
        $s->import(1, 'auto', ['SKILL.md' => "---\nname: auto\nrequires-skills: [secret]\n---\n"]);
        $s->import(2, 'secret', $this->loader('secret'));   // user 2's private skill: invisible to user 1
        $e = $this->refused(fn() => $s->setVisibility(1, 'auto', 'public'));
        $this->assertSame('"auto" needs "secret", which you can\'t make public.', $e->getMessage());
        $this->assertSame('private', $s->list(1)[0]['visibility']);
    }
}
