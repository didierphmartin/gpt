<?php

declare(strict_types=1);

/**
 * Harness test for AgentTeam\Services\IngestionSplitter — the interpreter's
 * splitter node. Verifies PARITY with the Python vendor
 * (langchain_runner/ingestion_splitter.recursive_split), which is itself
 * parity-tested against langchain. So PHP == Python == langchain.
 *
 * Run with:  php backend/scripts/test-ingestion-splitter.php
 */

require __DIR__ . '/../vendor/autoload.php';

use AgentTeam\Services\IngestionSplitter;

$failures = 0;
$checks = 0;
function check(string $label, bool $cond): void
{
    global $failures, $checks;
    $checks++;
    echo ($cond ? "  PASS  " : "  FAIL  ") . $label . "\n";
    if (!$cond) {
        $failures++;
    }
}

$SAMPLES = [
    "Hello world. This is a test.\n\nA second paragraph with more words in it, "
        . "long enough to force splitting across several chunks when the size is small.",
    "abcdefghij klmnopqrst uvwxyz0123 4567890123\n4567890123 4567890123",
    "Line one\nLine two\nLine three\n\nNew block here with a fairly long run of "
        . "text that keeps going and going so that the splitter has real work to do "
        . "and must merge and overlap pieces.",
    "no separators here just one very long token aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
];
$CASES = [[50, 0], [50, 10], [100, 20], [20, 5]];

// --- Parity against the pure-Python vendor (no langchain needed to run it) ---
$runnerDir = realpath(__DIR__ . '/../../langchain_runner');
$py = trim((string) @shell_exec('command -v python3'));
$expected = null;
if ($py !== '' && $runnerDir !== false) {
    $payload = json_encode(['samples' => $SAMPLES, 'cases' => $CASES]);
    $script = 'import sys, json; sys.path.insert(0, ' . var_export($runnerDir, true) . '); '
        . 'from ingestion_splitter import recursive_split; '
        . 'd = json.load(sys.stdin); out = {}; '
        . "\nfor si, t in enumerate(d['samples']):\n"
        . "    for cs, ov in d['cases']:\n"
        . "        out['%d:%d:%d' % (si, cs, ov)] = recursive_split(t, cs, ov)\n"
        . 'print(json.dumps(out))';
    $cmd = escapeshellarg($py) . ' -c ' . escapeshellarg($script);
    $proc = proc_open($cmd, [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
    if (is_resource($proc)) {
        fwrite($pipes[0], (string) $payload);
        fclose($pipes[0]);
        $stdout = stream_get_contents($pipes[1]);
        fclose($pipes[1]);
        fclose($pipes[2]);
        proc_close($proc);
        $expected = json_decode((string) $stdout, true);
    }
}

if (!is_array($expected)) {
    echo "  SKIP  python parity (python3 / vendor unavailable) — running invariants only\n";
} else {
    foreach ($SAMPLES as $si => $t) {
        foreach ($CASES as [$cs, $ov]) {
            $got = IngestionSplitter::recursiveSplit($t, $cs, $ov);
            $exp = $expected["$si:$cs:$ov"] ?? null;
            check("parity sample $si cs=$cs ov=$ov", $got === $exp);
        }
    }
}

// --- overlap > chunk_size must raise (matches langchain / the Python vendor) ---
$threw = false;
try {
    IngestionSplitter::recursiveSplit("some text here", 20, 30);
} catch (\InvalidArgumentException $e) {
    $threw = true;
}
check('overlap > chunkSize throws', $threw);
// overlap == chunk_size does NOT raise (parity preserved)
$ok = true;
try {
    IngestionSplitter::recursiveSplit("some text here", 20, 20);
} catch (\Throwable $e) {
    $ok = false;
}
check('overlap == chunkSize does not throw', $ok);

// --- invariants ---
$chunks = IngestionSplitter::recursiveSplit($SAMPLES[0], 50, 10);
check('produces multiple chunks', count($chunks) > 1);
check('no empty chunks', count(array_filter($chunks, fn($c) => trim($c) === '')) === 0);
check('short text -> single chunk', IngestionSplitter::recursiveSplit("tiny", 1000, 100) === ['tiny']);
check('empty text -> no chunks', IngestionSplitter::recursiveSplit("", 100, 10) === []);

echo "\n$checks checks, $failures failures\n";
exit($failures === 0 ? 0 : 1);
