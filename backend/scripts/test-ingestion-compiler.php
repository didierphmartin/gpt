<?php
declare(strict_types=1);
require dirname(__DIR__) . '/vendor/autoload.php';
use AgentTeam\Services\IngestionCompiler;

$failures = 0; $checks = 0;
function check(string $label, bool $cond): void {
    global $failures, $checks; $checks++;
    echo ($cond ? "  PASS  " : "  FAIL  ") . $label . "\n";
    if (!$cond) $failures++;
}

$loader = ['provider' => 'local', 'path' => '/srv/docs', 'is_dir' => true,
           'types' => ['pdf', 'html'], 'workers' => 4,
           'storage_mcp_url' => 'http://127.0.0.1:8077/mcp'];
$splitter = ['chunk_size' => 800, 'overlap' => 120];
$store = ['store' => 'mcp:45', 'provider' => 'qdrant', 'connection' => [],
          'collection' => 'docs', 'embedding' => ''];
$ctx = ['langfs_url' => 'http://127.0.0.1:8077/mcp', 'mcpqrant_url' => 'http://127.0.0.1:8008/mcp'];

$r = IngestionCompiler::compileScript($loader, $splitter, $store, $ctx);
$code = $r['code'];

// --- the new stack is present ---
check('filename slug from collection', $r['filename'] === 'ingestion_docs.py');
check('langfs url baked in', str_contains($code, 'http://127.0.0.1:8077/mcp'));
check('mcp_qrant url baked in', str_contains($code, 'http://127.0.0.1:8008/mcp'));
check('calls langfs list_files', str_contains($code, '"list_files"') || str_contains($code, "'list_files'"));
check('reads via format text', str_contains($code, '"format": "text"') || str_contains($code, '"format":"text"'));
check('calls mcp_qrant store', str_contains($code, '"store"'));
check('passes provider/connection/collection/items', str_contains($code, '"items"') && str_contains($code, 'VS_PROVIDER') && str_contains($code, 'CONNECTION') && str_contains($code, 'COLLECTION'));
check('in-process splitter only', str_contains($code, 'RecursiveCharacterTextSplitter') && str_contains($code, 'split_text'));
check('ThreadPoolExecutor (network-bound)', str_contains($code, 'ThreadPoolExecutor'));
check('config literals: chunk/overlap', str_contains($code, '800') && str_contains($code, '120'));
check('empty connection -> {} not []', str_contains($code, 'CONNECTION = {}'));
check('store missing-{stored} guard', str_contains($code, 'stored'));

// --- the old stack is GONE ---
check('no qdrant-store', !str_contains($code, 'qdrant-store'));
check('no ProcessPoolExecutor', !str_contains($code, 'ProcessPoolExecutor'));
check('no local decoders', !str_contains($code, 'pypdf') && !str_contains($code, 'docx2txt') && !str_contains($code, 'markdownify'));
check('no UniversalFS/base64 read', !str_contains($code, 'base64') && !str_contains($code, 'UFS'));
check('no langchain_community / pgvector emit', !str_contains($code, 'langchain_community') && !str_contains($code, 'langchain_postgres'));

// --- the emitted script actually compiles ---
$tmp = sys_get_temp_dir() . '/ingest_compile_test_' . getmypid() . '.py';
file_put_contents($tmp, $code);
exec('python3 -m py_compile ' . escapeshellarg($tmp) . ' 2>&1', $out, $rc);
@unlink($tmp);
check('emitted script py_compiles', $rc === 0);

echo "\n$checks checks, $failures failures\n";
exit($failures === 0 ? 0 : 1);
