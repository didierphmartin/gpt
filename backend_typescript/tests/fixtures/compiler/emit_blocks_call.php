<?php
/**
 * The PHP side of tests/CompilerEmitBlocksParity.test.ts: php_compile.php's `call`, with arguments that
 * keep the PHP shapes JSON loses.
 *
 *   php emit_blocks_call.php call       stdin {"class", "method", "args": [...]}
 *        -> {"ok": true, "result": <return value>, "json": <json_encode(result) text>} | {"ok": false, "error", "class"}
 *   php emit_blocks_call.php analyzed <fixture.json>
 *        -> WorkflowGraphAnalyzer::analyze() of the fixture (as ADK/MAF build it)
 *
 * Tagged argument values (anywhere in an argument):
 *   {"$float": 1}            -> (float) 1          {"$obj": {...} | [...]} -> (object) of the decoded array
 *   {"$facts": "<fixture>"}  -> the fixture's facts {"$analyzed": "<fixture>"} -> analyze() of the fixture
 *   {"$closure": <value>}    -> fn() => <value>    (a StartDocumentStore adapter factory)
 *   {"$adapter": {"<path>": "<base64 bytes>"}} -> an object whose readStream(path) opens those bytes
 */
declare(strict_types=1);

require __DIR__ . '/php_compile.php';

function eb_analyzed(string $path): array
{
    $fx = json_decode((string) file_get_contents($path), true);
    $gen = fixture_generator($fx);
    $get = fn(string $p) => (new ReflectionProperty($gen, $p))->getValue($gen);
    $an = new \AgentTeam\Services\WorkflowGraphAnalyzer($get('db'), $get('workflowRepo'), $get('graphRepo'), $get('agentRepo'));
    return $an->analyze((int) $fx['workflow']['id'], isset($fx['user_id']) ? (string) $fx['user_id'] : null);
}

function eb_untag(mixed $v): mixed
{
    if (!is_array($v)) {
        return $v;
    }
    if (count($v) === 1) {
        $k = array_key_first($v);
        switch ($k) {
            case '$float':
                return (float) $v[$k];
            case '$obj':
                return (object) array_map('eb_untag', $v[$k]);
            case '$facts':
                return fixture_facts($v[$k]);
            case '$analyzed':
                return eb_analyzed($v[$k]);
            case '$closure':
                $inner = eb_untag($v[$k]);
                return fn() => $inner;
            case '$adapter':
                $files = $v[$k];
                return new class($files) {
                    public function __construct(private array $files) {}
                    public function readStream(string $p)
                    {
                        if (!isset($this->files[$p])) {
                            throw new \RuntimeException("no such file {$p}");
                        }
                        $s = fopen('php://memory', 'w+');
                        fwrite($s, base64_decode($this->files[$p]));
                        rewind($s);
                        return $s;
                    }
                };
        }
    }
    return array_map('eb_untag', $v);
}

$cmd = $argv[1] ?? '';
try {
    switch ($cmd) {
        case 'call':
            $req = json_decode((string) stream_get_contents(STDIN), true);
            $args = array_map('eb_untag', $req['args'] ?? []);
            $class = (str_contains($req['class'], '\\') ? '' : 'AgentTeam\\Services\\') . $req['class'];
            if (($req['method'] ?? '') === '__construct_read') {
                // new StartDocumentStore(...$args[0])->read($args[1]); bytes come back base64-encoded
                $store = new $class(...$args[0]);
                $bytes = $store->read($args[1]);
                out(['ok' => true, 'result' => $bytes === null ? null : base64_encode($bytes), 'json' => '']);
                break;
            }
            $m = new ReflectionMethod($class, $req['method']);
            $result = $m->invokeArgs(null, $args);
            out(['ok' => true, 'result' => $result,
                'json' => json_encode($result, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRESERVE_ZERO_FRACTION)]);
            break;
        case 'analyzed':
            out(eb_analyzed($argv[2]));
            break;
        default:
            fwrite(STDERR, "usage: emit_blocks_call.php call | analyzed <fixture.json>\n");
            exit(2);
    }
} catch (\Throwable $e) {
    out(['ok' => false, 'error' => $e->getMessage(), 'class' => get_class($e)]);
}
