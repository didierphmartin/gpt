<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use AgentTeam\Services\DecisionRouter;
use AgentTeam\Services\JevRouter;
use AgentTeam\Services\LangGraphRuntime;
use AgentTeam\Services\OpenAIDecisionRouter;
use GuzzleHttp\Client;
use GuzzleHttp\Exception\ConnectException;
use GuzzleHttp\Handler\MockHandler;
use GuzzleHttp\HandlerStack;
use GuzzleHttp\Middleware;
use GuzzleHttp\Psr7\Request;
use GuzzleHttp\Psr7\Response;
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Services\DecisionProtocols;

/** The OpenAI Decisions adapter: wire format (documented shapes) and the outcome mapping JevRouter has. */
final class OpenAIDecisionRouterTest extends TestCase
{
    private const TARGETS = [
        ['id' => 1, 'name' => 'Billing', 'description' => 'Invoices, payments, refunds.'],
        ['id' => 2, 'name' => 'Sales', 'description' => ''],
    ];

    private array $seen = [];

    /** @param array<int, Response|ConnectException> $queue */
    private function router(array $queue, float $floor = JevRouter::DEFAULT_CONFIDENCE_FLOOR, string $url = '', string $model = ''): OpenAIDecisionRouter
    {
        $this->seen = [];
        $stack = HandlerStack::create(new MockHandler($queue));
        $stack->push(Middleware::history($this->seen));
        return new OpenAIDecisionRouter('test-key', new Client(['handler' => $stack]), $floor, $url, $model);
    }

    private static function answer(string $choice, float $confidence): Response
    {
        return new Response(200, [], json_encode(['model' => 'gpt-6-luna', 'answers' => [[
            'type' => 'choice', 'name' => 'route', 'choice' => $choice, 'confidence' => $confidence,
            'probabilities' => [['value' => $choice, 'probability' => $confidence]],
        ]], 'usage' => ['input_tokens' => 120, 'output_tokens' => 0]]));
    }

    public function testItSendsTheDocumentedRequest(): void
    {
        $this->router([self::answer('Billing', 0.95)])->route('I was charged twice.', self::TARGETS, 'Which team?');
        $req = $this->seen[0]['request'];
        $this->assertSame(OpenAIDecisionRouter::URL, (string) $req->getUri());
        $this->assertSame('Bearer test-key', $req->getHeaderLine('Authorization'));
        $body = json_decode((string) $req->getBody(), true);
        $this->assertSame('gpt-6-luna', $body['model']);
        $this->assertSame('I was charged twice.', $body['input']);
        $q = $body['questions'][0];
        $this->assertSame(['type' => 'choice', 'name' => 'route', 'instructions' => 'Which team?'],
            array_intersect_key($q, array_flip(['type', 'name', 'instructions'])));
        $this->assertSame(['Billing', 'Sales', 'unclear'], array_column($q['choices'], 'value'));
        $this->assertSame('Sales', $q['choices'][1]['description'], 'no description falls back to the name');
    }

    public function testGatewayUrlAndRowModel(): void
    {
        $this->router([self::answer('Billing', 0.95)], 0.6, 'https://gw.corp/decisions', 'gpt-6-luna-2026-10-06')
            ->route('x', self::TARGETS, 'q');
        $this->assertSame('https://gw.corp/decisions', (string) $this->seen[0]['request']->getUri());
        $this->assertSame('gpt-6-luna-2026-10-06', json_decode((string) $this->seen[0]['request']->getBody(), true)['model']);
    }

    public function testOutcomes(): void
    {
        $out = $this->router([self::answer('Billing', 0.93)])->route('x', self::TARGETS, 'q');
        $this->assertSame(['routed', 1, 0.93, 120], [$out['outcome'], $out['target']['id'], $out['confidence'], $out['usage']['input_tokens']]);
        $this->assertSame('unclear', $this->router([self::answer('unclear', 1.0)])->route('hello', self::TARGETS, 'q')['outcome']);
        $low = $this->router([self::answer('Sales', 0.46)])->route('x', self::TARGETS, 'q');
        $this->assertSame(['low_confidence', 2], [$low['outcome'], $low['target']['id']]);
        $this->assertSame('error', $this->router([self::answer('Support', 0.99)])->route('x', self::TARGETS, 'q')['outcome']);
    }

    public function testRefusalIsAnErrorThatKeepsItsUsage(): void
    {
        $out = $this->router([new Response(200, [], json_encode(['answers' => [['type' => 'refusal', 'name' => 'route']],
            'usage' => ['input_tokens' => 9]]))])->route('x', self::TARGETS, 'q');
        $this->assertSame(['error', 'the model refused to answer', 9], [$out['outcome'], $out['reason'], $out['usage']['input_tokens']]);
        $this->assertNotNull($out['ms']);
    }

    public function testFailuresAndBadMenus(): void
    {
        $this->assertSame('unavailable', (new OpenAIDecisionRouter(null))->route('x', self::TARGETS, 'q')['outcome']);
        $net = $this->router([new ConnectException('down', new Request('POST', 'x'))])->route('x', self::TARGETS, 'q');
        $this->assertSame(['error', null], [$net['outcome'], $net['ms']]);
        $this->assertSame('error', $this->router([])->route('x', [self::TARGETS[0], ['id' => 3, 'name' => 'Unclear']], 'q')['outcome']);
        $this->assertSame('error', $this->router([])->route('x', [self::TARGETS[0]], 'q')['outcome']);
        $this->assertSame([], $this->seen, 'a refused menu calls nobody');
    }

    public function testApiErrorsReportTheirOwnMessage(): void
    {
        $msg = 'You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/account/billing to keep going.';
        $body = json_encode(['error' => ['message' => $msg, 'type' => 'insufficient_quota', 'code' => 'insufficient_quota']]);
        $out = $this->router([new Response(429, [], $body)])->route('x', self::TARGETS, 'q');
        $this->assertSame('error', $out['outcome']);
        $this->assertSame("OpenAI HTTP 429 (insufficient_quota): {$msg}", $out['reason'], 'the whole message, not Guzzle\'s truncated dump');
        $this->assertSame('OpenAI HTTP 502', $this->router([new Response(502, [], '<html>')])->route('x', self::TARGETS, 'q')['reason']);
    }

    public function testItIsRegistered(): void
    {
        $p = DecisionProtocols::get('openai');
        $this->assertSame(OpenAIDecisionRouter::class, $p['adapter']);
        $this->assertNull($p['legacy_env'], 'OPENAI_API_KEY is the chat key; the .env sync must never drop it');
        $this->assertTrue(is_subclass_of($p['adapter'], DecisionRouter::class));
        $this->assertSame('OpenAIDecisionRouter', LangGraphRuntime::ADAPTER_CLASSES['openai']);
    }

    /** The emitted Python twin, run against a fake urlopen: same body, same outcomes. */
    public function testThePythonTwinMatches(): void
    {
        $dir = sys_get_temp_dir() . '/oai_dec_' . bin2hex(random_bytes(4));
        mkdir($dir);
        file_put_contents("$dir/block.py", LangGraphRuntime::decisionAdaptersBlock(['openai']));
        file_put_contents("$dir/t.py", <<<'PY'
import io, json, os, sys, time, urllib.request
from dataclasses import dataclass, field
from functools import cached_property
ns = {"dataclass": dataclass, "field": field, "cached_property": cached_property, "json": json, "os": os, "time": time}
exec(open(sys.argv[1]).read(), ns)
assert ns["DECISION_ADAPTERS"] == {"openai": ns["OpenAIDecisionRouter"]}
sent = []
def fake(reply):
    def urlopen(req, timeout=None, context=None):
        sent.append(json.loads(req.data))
        return io.BytesIO(json.dumps(reply).encode())
    urllib.request.urlopen = urlopen
T = [{"id": "1", "name": "Billing", "description": "Refunds."}, {"id": "2", "name": "Sales", "description": ""}]
r = ns["OpenAIDecisionRouter"](key_env="LUNA_API_KEY", url_env="LUNA_BASE_URL")
os.environ.pop("OPENAI_API_KEY", None); os.environ.pop("LUNA_API_KEY", None)
assert r.route("x", T, "q").outcome == "unavailable"
os.environ["OPENAI_API_KEY"] = "chat-key"
assert not r.available(), "the chat key is not a decision key"
os.environ["LUNA_API_KEY"] = "k"
ans = lambda c, p: {"answers": [{"type": "choice", "name": "route", "choice": c, "confidence": p}], "usage": {"input_tokens": 5}}
fake(ans("Billing", 0.93)); d = r.route("I was charged twice.", T, "Which team?")
assert (d.outcome, d.target["id"], d.usage["input_tokens"]) == ("routed", "1", 5), d
b = sent[-1]
assert b["model"] == "gpt-6-luna" and b["input"] == "I was charged twice.", b
assert [c["value"] for c in b["questions"][0]["choices"]] == ["Billing", "Sales", "unclear"], b
fake(ans("unclear", 1.0)); assert r.route("hi", T, "q").outcome == "unclear"
fake(ans("Sales", 0.4)); assert r.route("x", T, "q").outcome == "low_confidence"
fake({"answers": [{"type": "refusal", "name": "route"}]}); assert r.route("x", T, "q").reason == "the model refused to answer"
print("OK")
PY);
        exec('python3 ' . escapeshellarg("$dir/t.py") . ' ' . escapeshellarg("$dir/block.py") . ' 2>&1', $out, $rc);
        array_map('unlink', glob("$dir/*"));
        rmdir($dir);
        $this->assertSame(0, $rc, implode("\n", $out));
        $this->assertSame('OK', end($out));
    }
}
