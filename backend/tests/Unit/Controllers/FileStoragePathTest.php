<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit\Controllers;

use PDO;
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Controllers\FileStorageController;

/** Storage paths stay inside the user's own folder. Only refusals are exercised: they return before any adapter is opened. */
class FileStoragePathTest extends TestCase
{
    private FileStorageController $c;

    protected function setUp(): void
    {
        $db = new PDO('sqlite::memory:');
        $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $db->exec("CREATE TABLE users (id INTEGER PRIMARY KEY, storage_provider TEXT, storage_folder TEXT)");
        $db->exec("INSERT INTO users VALUES (1, 'local', 'alice'), (2, 'local', '../..')");
        $this->c = new FileStorageController($db, ['storage_path' => sys_get_temp_dir() . '/no-such-storage-' . uniqid()]);
    }

    public function test_list_refuses_dot_dot(): void
    {
        foreach (['..', '../../backend', 'a/../../b', './x', "a\0b"] as $path) {
            $r = $this->c->listFiles(['user_id' => 1, 'query' => ['path' => $path]]);
            $this->assertFalse($r['success'], $path);
            $this->assertSame('Invalid path', $r['error']);
        }
    }

    public function test_read_refuses_paths_outside_the_users_folder(): void
    {
        foreach ([
            '../../backend/.env',
            '/etc/passwd',
            'synergyaichatroot/bob/x.txt',
            'synergyaichatroot/alice/../bob/x.txt',
            'synergyaichatroot/alice',
            'synergyaichatroot/alicex/x.txt',
        ] as $fileId) {
            $r = $this->c->readFile(['user_id' => 1, 'query' => ['fileId' => $fileId]]);
            $this->assertSame(['success' => false, 'error' => 'File not found'], $r, $fileId);
        }
    }

    public function test_a_dot_dot_storage_folder_setting_counts_as_none(): void
    {
        $r = $this->c->readFile(['user_id' => 2, 'query' => ['fileId' => 'synergyaichatroot/x.txt']]);
        $this->assertSame('File not found', $r['error']);
        $r = $this->c->listFiles(['user_id' => 2, 'query' => []]);
        $this->assertSame([], $r['items']);
        $this->assertSame('', $r['userFolder']);
    }
}
