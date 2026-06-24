<?php

declare(strict_types=1);

/**
 * Harness test for AgentTeam\Services\IngestionLoader — the interpreter's
 * file-read step (recursive list_files -> read_file -> decode -> text).
 *
 * Plain-assert style (same as test-vector-mcp-store.php). The MCP transport
 * (list_files / read_file) is INJECTED as callables, so the recursive
 * enumeration and decoding are tested with no live MCP server. Run with:
 *
 *     php backend/scripts/test-ingestion-loader.php
 */

require __DIR__ . '/../vendor/autoload.php';

use AgentTeam\Services\IngestionLoader;

$FIXTURES = __DIR__ . '/../tests/fixtures';
$failures = 0;
$checks = 0;

function check(string $label, bool $cond): void
{
    global $failures, $checks;
    $checks++;
    if ($cond) {
        echo "  PASS  $label\n";
    } else {
        $failures++;
        echo "  FAIL  $label\n";
    }
}

// ---------------------------------------------------------------------------
// Fixtures: a fake list_files backed by an in-memory tree, a fake read_file
// backed by a blob map, and a minimal real .docx (zip) built in-process so
// decode is tested against the real libraries, not a mock.
// ---------------------------------------------------------------------------
function fakeListFiles(array $tree): callable
{
    return fn(string $provider, string $path): array => ['files' => $tree[$path] ?? []];
}

function fakeReadFile(array $blobs): callable
{
    return fn(string $provider, string $fileId): string => $blobs[$fileId];
}

function f(string $path): array
{
    return ['id' => $path, 'name' => basename($path), 'type' => 'file'];
}

function d(string $path): array
{
    return ['id' => $path, 'name' => basename($path), 'type' => 'folder'];
}

function makeDocx(string $text): string
{
    $tmp = tempnam(sys_get_temp_dir(), 'docx');
    $z = new ZipArchive();
    $z->open($tmp, ZipArchive::OVERWRITE);
    $z->addFromString(
        '[Content_Types].xml',
        '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        . '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.'
        . 'wordprocessingml.document.main+xml"/></Types>'
    );
    $z->addFromString(
        'word/document.xml',
        '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        . "<w:body><w:p><w:r><w:t>$text</w:t></w:r></w:p></w:body></w:document>"
    );
    $z->close();
    $bytes = file_get_contents($tmp);
    unlink($tmp);
    return $bytes;
}

// ===========================================================================
// detectType
// ===========================================================================
check('detectType pdf', IngestionLoader::detectType('report.pdf') === 'pdf');
check('detectType PDF (case)', IngestionLoader::detectType('notes.PDF') === 'pdf');
check('detectType docx', IngestionLoader::detectType('memo.docx') === 'word');
check('detectType doc', IngestionLoader::detectType('memo.doc') === 'word');
check('detectType txt', IngestionLoader::detectType('readme.txt') === 'text');
check('detectType csv', IngestionLoader::detectType('data.csv') === 'csv');
check('detectType path', IngestionLoader::detectType('a/b/deep.pdf') === 'pdf');
check('detectType html', IngestionLoader::detectType('page.html') === 'html');
check('detectType htm', IngestionLoader::detectType('page.htm') === 'html');
check('detectType unsupported', IngestionLoader::detectType('archive.zip') === null);
check('detectType no ext', IngestionLoader::detectType('noext') === null);

// ===========================================================================
// decode
// ===========================================================================
check('decode text', IngestionLoader::decode('readme.txt', 'hello world') === 'hello world');
check('decode csv', IngestionLoader::decode('data.csv', "x,y\n1,2\n3,4") === "x,y\n1,2\n3,4");
check('decode docx', str_contains(IngestionLoader::decode('memo.docx', makeDocx('Hello DOCX world')), 'Hello DOCX world'));
check('decode html', str_contains(IngestionLoader::decode('a.html', '<html><body><h1>Hello HTML world</h1><p>Body text.</p></body></html>'), 'Hello HTML world'));
check('decode html strips script', !str_contains(IngestionLoader::decode('a.html', '<html><body><script>var secret=1;</script><p>Visible only.</p></body></html>'), 'secret'));
check('decode pdf', str_contains(IngestionLoader::decode('report.pdf', file_get_contents("$FIXTURES/loader-sample.pdf")), 'Hello PDF world'));
check('decode auto routes pdf', str_contains(IngestionLoader::decode('report.pdf', file_get_contents("$FIXTURES/loader-sample.pdf"), 'auto'), 'Hello PDF world'));
check('decode auto routes text', IngestionLoader::decode('notes.txt', 'plain', 'auto') === 'plain');

$threw = false;
try {
    IngestionLoader::decode('archive.zip', 'PK');
} catch (\InvalidArgumentException $e) {
    $threw = true;
}
check('decode unsupported throws', $threw);

// ===========================================================================
// enumerateFiles
// ===========================================================================
// $allowedTypes is the checkbox filter: [] = no restriction (all supported).
$single = IngestionLoader::enumerateFiles(fakeListFiles([]), 'local', 'doc.pdf', [], false);
check('enumerate single count', count($single) === 1);
check('enumerate single file_id', $single[0]['file_id'] === 'doc.pdf');
check('enumerate single source', $single[0]['source'] === 'doc.pdf');
check('enumerate single doc_type', $single[0]['doc_type'] === 'pdf');
check('enumerate single provider', $single[0]['provider'] === 'local');

// Single file whose type is NOT in the checked set -> filtered out.
$excluded = IngestionLoader::enumerateFiles(fakeListFiles([]), 'local', 'doc.pdf', ['word'], false);
check('enumerate single excluded by filter', $excluded === []);
// ...and kept when its type IS checked.
$included = IngestionLoader::enumerateFiles(fakeListFiles([]), 'local', 'doc.pdf', ['pdf', 'word'], false);
check('enumerate single kept when type checked', count($included) === 1 && $included[0]['doc_type'] === 'pdf');

$tree = [
    'root'           => [f('root/a.pdf'), f('root/notes.txt'), f('root/image.png'), d('root/sub')],
    'root/sub'       => [f('root/sub/b.docx'), d('root/sub/deep')],
    'root/sub/deep'  => [f('root/sub/deep/c.csv')],
];
$all = IngestionLoader::enumerateFiles(fakeListFiles($tree), 'local', 'root', [], true);
$bySource = [];
foreach ($all as $it) {
    $bySource[$it['source']] = $it['doc_type'];
}
check('enumerate folder recursive, no filter = all supported', $bySource === [
    'root/a.pdf' => 'pdf',
    'root/notes.txt' => 'text',
    'root/sub/b.docx' => 'word',
    'root/sub/deep/c.csv' => 'csv',
]);
check('enumerate folder skips unsupported', !isset($bySource['root/image.png']));

$onlyPdf = IngestionLoader::enumerateFiles(fakeListFiles($tree), 'local', 'root', ['pdf'], true);
check('enumerate folder filter single type', array_map(fn($i) => $i['source'], $onlyPdf) === ['root/a.pdf']);

// The user's example: check Word + PDF -> only .docx and .pdf are processed.
$pdfWord = IngestionLoader::enumerateFiles(fakeListFiles($tree), 'local', 'root', ['pdf', 'word'], true);
$pwSources = array_map(fn($i) => $i['source'], $pdfWord);
sort($pwSources);
check('enumerate folder filter PDF+Word', $pwSources === ['root/a.pdf', 'root/sub/b.docx']);

$cycleTree = [
    'root'      => [f('root/a.pdf'), d('root/loop')],
    'root/loop' => [f('root/loop/b.txt'), d('root')],   // back-edge
];
$cyc = IngestionLoader::enumerateFiles(fakeListFiles($cycleTree), 'local', 'root', [], true);
$cycSources = array_map(fn($i) => $i['source'], $cyc);
sort($cycSources);
check('enumerate cycle guard', $cycSources === ['root/a.pdf', 'root/loop/b.txt']);

// ===========================================================================
// loadFile / loadDocuments
// ===========================================================================
$rf = fakeReadFile(['root/notes.txt' => 'hello from disk']);
$desc = IngestionLoader::enumerateFiles(fakeListFiles([]), 'local', 'root/notes.txt', [], false)[0];
check('loadFile reads and decodes', IngestionLoader::loadFile($rf, $desc) === 'hello from disk');

$docTree = [
    'root'     => [f('root/a.txt'), f('root/b.csv'), f('root/skip.png'), d('root/sub')],
    'root/sub' => [f('root/sub/c.txt')],
];
$blobs = [
    'root/a.txt'      => 'alpha',
    'root/b.csv'      => "x,y\n1,2",
    'root/sub/c.txt'  => 'gamma',
];
$docs = iterator_to_array(IngestionLoader::loadDocuments(
    fakeListFiles($docTree),
    fakeReadFile($blobs),
    'local',
    'root',
    [],
    true
), false);
$docMap = [];
foreach ($docs as $doc) {
    $docMap[$doc['source']] = $doc['text'];
}
check('loadDocuments yields text+source', $docMap === [
    'root/a.txt' => 'alpha',
    'root/b.csv' => "x,y\n1,2",
    'root/sub/c.txt' => 'gamma',
]);

$pdfBlobs = ['root/r.pdf' => file_get_contents("$FIXTURES/loader-sample.pdf")];
$pdfTree = ['root' => [f('root/r.pdf')]];
$pdfDocs = iterator_to_array(IngestionLoader::loadDocuments(
    fakeListFiles($pdfTree),
    fakeReadFile($pdfBlobs),
    'local',
    'root',
    [],
    true
), false);
check('loadDocuments pdf end-to-end',
    count($pdfDocs) === 1
    && str_contains($pdfDocs[0]['text'], 'Hello PDF world')
    && $pdfDocs[0]['source'] === 'root/r.pdf');

// ===========================================================================
// readRound — one file's text per round (what the Output tab shows)
// ===========================================================================
$rrTree = [
    'root'     => [f('root/a.txt'), f('root/b.csv'), f('root/skip.png'), d('root/sub')],
    'root/sub' => [f('root/sub/c.txt')],
];
$rrBlobs = [
    'root/a.txt'     => 'alpha',
    'root/b.csv'     => "x,y\n1,2",
    'root/sub/c.txt' => 'gamma',
];
$lf = fakeListFiles($rrTree);
$rf = fakeReadFile($rrBlobs);

$r0 = IngestionLoader::readRound($lf, $rf, 'local', 'root', [], true, 0);
check('readRound count = supported files only', $r0['count'] === 3);
check('readRound exposes ordered sources', $r0['sources'] === ['root/a.txt', 'root/b.csv', 'root/sub/c.txt']);
check('readRound round 0 = first file text', $r0['current']['source'] === 'root/a.txt' && $r0['current']['text'] === 'alpha' && $r0['current']['type'] === 'text');

$r2 = IngestionLoader::readRound($lf, $rf, 'local', 'root', [], true, 2);
check('readRound advances to round 2', $r2['cursor'] === 2 && $r2['current']['source'] === 'root/sub/c.txt' && $r2['current']['text'] === 'gamma');

$rEnd = IngestionLoader::readRound($lf, $rf, 'local', 'root', [], true, 3);
check('readRound past the end = exhausted (no current)', $rEnd['count'] === 3 && $rEnd['current'] === null);

// Long text is clipped for the round display.
$rClip = IngestionLoader::readRound(
    fakeListFiles(['r' => [f('r/big.txt')]]),
    fakeReadFile(['r/big.txt' => str_repeat('z', 100)]),
    'local', 'r', [], true, 0, 10
);
check('readRound clips long text', $rClip['current']['clipped'] === true && mb_strlen($rClip['current']['text']) === 10);

// A decode/read failure surfaces on the round, not as a fatal.
$boomRead = function (string $provider, string $fileId) {
    if ($fileId === 'r/bad.txt') {
        throw new \RuntimeException('read blew up');
    }
    return 'ok';
};
$rErr = IngestionLoader::readRound(
    fakeListFiles(['r' => [f('r/bad.txt'), f('r/good.txt')]]),
    $boomRead, 'local', 'r', [], true, 0
);
check('readRound surfaces per-file error', isset($rErr['current']['error']) && $rErr['current']['source'] === 'r/bad.txt');

// ---------------------------------------------------------------------------
echo "\n$checks checks, $failures failures\n";
exit($failures === 0 ? 0 : 1);
