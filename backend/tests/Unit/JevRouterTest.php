<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use AgentTeam\Services\JevRouter;
use GuzzleHttp\Client;
use GuzzleHttp\Handler\MockHandler;
use GuzzleHttp\HandlerStack;
use GuzzleHttp\Psr7\Request;
use GuzzleHttp\Psr7\Response;
use GuzzleHttp\Exception\ConnectException;
use PHPUnit\Framework\TestCase;

/**
 * The router's decisions, against recorded API shapes.
 *
 * Mocked rather than live: the point of these tests is the OUTCOME MAPPING --
 * which responses are allowed to decide a route and which must hand back to the
 * LLM. That logic is what protects a run from being routed on a guess, and it
 * must be checked without a network or a key.
 */
final class JevRouterTest extends TestCase
{
    private const TARGETS = [
        ['id' => 1, 'name' => 'Billing', 'description' => 'Invoices, payments, refunds.'],
        ['id' => 2, 'name' => 'Sales', 'description' => 'Pricing, plans, demos.'],
    ];

    /** @param array<int, Response|ConnectException> $queue */
    private function router(array $queue, float $floor = JevRouter::DEFAULT_CONFIDENCE_FLOOR): JevRouter
    {
        $stack = HandlerStack::create(new MockHandler($queue));
        return new JevRouter('test-key', new Client(['handler' => $stack]), $floor);
    }

    private static function answer(string $choice, float $confidence): Response
    {
        return new Response(200, [], json_encode(['model' => 'jev-1.13.0', 'answers' => ['route' => [
            'type' => 'choice', 'choice' => $choice, 'confidence' => $confidence,
            'probabilities' => [$choice => $confidence],
        ]], 'usage' => ['input_tokens' => 342, 'output_tokens' => 39]]));
    }

    public function testItPostsToAConfiguredGatewayUrl(): void
    {
        $seen = [];
        $stack = HandlerStack::create(new MockHandler([self::answer('Billing', 0.99)]));
        $stack->push(\GuzzleHttp\Middleware::history($seen));
        (new JevRouter('test-key', new Client(['handler' => $stack]), JevRouter::DEFAULT_CONFIDENCE_FLOOR, 'https://gw.corp/jev'))
            ->route('I was charged twice.', self::TARGETS, 'Which team?');
        $this->assertSame('https://gw.corp/jev', (string) $seen[0]['request']->getUri());
    }

    public function testItPostsToTheVendorUrlByDefault(): void
    {
        $seen = [];
        $stack = HandlerStack::create(new MockHandler([self::answer('Billing', 0.99)]));
        $stack->push(\GuzzleHttp\Middleware::history($seen));
        (new JevRouter('test-key', new Client(['handler' => $stack])))->route('I was charged twice.', self::TARGETS, 'Which team?');
        $this->assertSame(JevRouter::URL, (string) $seen[0]['request']->getUri());
    }

    public function testAConfidentChoiceRoutes(): void
    {
        $out = $this->router([self::answer('Billing', 0.99)])->route('I was charged twice.', self::TARGETS, 'Which team?');
        $this->assertSame('routed', $out['outcome']);
        $this->assertSame(1, $out['target']['id']);
        $this->assertSame(0.99, $out['confidence']);
        $this->assertSame(342, $out['usage']['input_tokens']);
    }

    /**
     * The measured failure mode. Without an `unclear` option every input
     * saturates: "hello" came back as a real team at 0.97 confidence. So the
     * escape hatch must be OFFERED on every call, and choosing it must mean
     * "route nowhere" rather than being treated as a branch name.
     */
    public function testUnclearRoutesNowhere(): void
    {
        $out = $this->router([self::answer(JevRouter::UNCLEAR, 1.0)])->route('hello', self::TARGETS, 'Which team?');
        $this->assertSame('unclear', $out['outcome']);
        $this->assertNull($out['target']);
    }

    /**
     * A divided decision keeps the target (useful for logging) but must NOT be
     * acted on: the caller escalates to the LLM, which can weigh it and write
     * the notes the child receives.
     */
    public function testLowConfidenceDoesNotDecide(): void
    {
        $out = $this->router([self::answer('Sales', 0.46)])->route('Upgrade me to annual.', self::TARGETS, 'Which team?');
        $this->assertSame('low_confidence', $out['outcome']);
        $this->assertSame('Sales', $out['target']['name']);
        $this->assertStringContainsString('below floor', $out['reason']);
    }

    public function testTheFloorIsConfigurableNotABelief(): void
    {
        $out = $this->router([self::answer('Sales', 0.46)], 0.4)->route('Upgrade me.', self::TARGETS, 'Which team?');
        $this->assertSame('routed', $out['outcome'], 'a lower floor must let 0.46 through');
    }

    /** No key must be inert, never an exception: the LLM path still works. */
    public function testNoKeyIsUnavailableNotFatal(): void
    {
        $r = new JevRouter('', new Client());
        $this->assertFalse($r->isAvailable());
        $this->assertSame('unavailable', $r->route('x', self::TARGETS, 'q')['outcome']);
    }

    /**
     * The key lives in the LLM settings now (DecisionKeyResolver), not in .env. A
     * null key means "not configured", even when a stale TYPESAFE_API_KEY is
     * still exported: reading it would silently bypass the per-user/global
     * precedence and the admin's decision to leave Jev unset.
     */
    public function testNullKeyIgnoresTheEnvironment(): void
    {
        $prevEnv = $_ENV['TYPESAFE_API_KEY'] ?? null;
        $prevGetenv = getenv('TYPESAFE_API_KEY');
        $_ENV['TYPESAFE_API_KEY'] = 'env-key-must-be-ignored';
        putenv('TYPESAFE_API_KEY=env-key-must-be-ignored');
        try {
            $r = new JevRouter(null, new Client());
            $this->assertFalse($r->isAvailable());
            $this->assertSame('unavailable', $r->route('x', self::TARGETS, 'q')['outcome']);
        } finally {
            if ($prevEnv === null) {
                unset($_ENV['TYPESAFE_API_KEY']);
            } else {
                $_ENV['TYPESAFE_API_KEY'] = $prevEnv;
            }
            putenv($prevGetenv === false ? 'TYPESAFE_API_KEY' : 'TYPESAFE_API_KEY=' . $prevGetenv);
        }
    }

    /** A network failure is the LLM's cue, not the run's end. */
    public function testTransportFailureFallsBack(): void
    {
        $out = $this->router([new ConnectException('timeout', new Request('POST', 'x'))])
            ->route('x', self::TARGETS, 'q');
        $this->assertSame('error', $out['outcome']);
        $this->assertNull($out['target']);
    }

    /**
     * A branch named "unclear" would make the escape hatch's answer ambiguous:
     * there would be no way to tell "I cannot choose" from "I chose that one".
     * Refuse the call instead of routing on a menu we cannot read back.
     */
    public function testABranchNamedUnclearIsRefused(): void
    {
        $targets = [['id' => 1, 'name' => 'unclear', 'description' => 'x'],
                    ['id' => 2, 'name' => 'Sales', 'description' => 'y']];
        $out = $this->router([])->route('x', $targets, 'q');
        $this->assertSame('error', $out['outcome']);
        $this->assertStringContainsString('unusable target name', $out['reason']);
    }

    public function testAMenuOfOneIsRefused(): void
    {
        $out = $this->router([])->route('x', [self::TARGETS[0]], 'q');
        $this->assertSame('error', $out['outcome']);
        $this->assertStringContainsString('at least two', $out['reason']);
    }

    /**
     * Constrained answers are the whole reason for using this: if one ever
     * arrives off-menu, that assumption is broken and the result must not be
     * trusted just because it parsed.
     */
    public function testAnOffMenuAnswerIsAnError(): void
    {
        $out = $this->router([self::answer('Engineering', 0.99)])->route('x', self::TARGETS, 'q');
        $this->assertSame('error', $out['outcome']);
        $this->assertStringContainsString('not on the menu', $out['reason']);
    }

    /**
     * TypeSafe answered, but without a usable choice: still an answered call, so
     * it carries the round-trip time and the usage (both are what gets recorded).
     */
    public function testAnAnswerWithoutAChoiceKeepsItsTimeAndUsage(): void
    {
        $res = new Response(200, [], json_encode(['answers' => [], 'usage' => ['input_tokens' => 342, 'output_tokens' => 0]]));
        $out = $this->router([$res])->route('x', self::TARGETS, 'q');
        $this->assertSame('error', $out['outcome']);
        $this->assertSame('no choice in the response', $out['reason']);
        $this->assertIsInt($out['ms']);
        $this->assertSame(342, $out['usage']['input_tokens']);
    }

    /** A call that was never answered has no round-trip time: nothing to record. */
    public function testRefusedAndFailedCallsHaveNoTime(): void
    {
        $this->assertNull($this->router([])->route('x', [self::TARGETS[0]], 'q')['ms']);
        $this->assertNull($this->router([new ConnectException('timeout', new Request('POST', 'x'))])
            ->route('x', self::TARGETS, 'q')['ms']);
    }

    public function testTheModelComesFromTheRow(): void
    {
        $history = [];
        $stack = HandlerStack::create(new MockHandler([self::answer('Billing', 0.99)]));
        $stack->push(\GuzzleHttp\Middleware::history($history));
        (new JevRouter('k', new Client(['handler' => $stack]), 0.6, '', 'jev-2'))
            ->route('x', self::TARGETS, 'q');
        $body = json_decode((string) $history[0]['request']->getBody(), true);
        $this->assertSame('jev-2', $body['model']);
    }

    public function testAnEmptyModelIsTheVendorDefault(): void
    {
        $history = [];
        $stack = HandlerStack::create(new MockHandler([self::answer('Billing', 0.99)]));
        $stack->push(\GuzzleHttp\Middleware::history($history));
        (new JevRouter('k', new Client(['handler' => $stack])))->route('x', self::TARGETS, 'q');
        $body = json_decode((string) $history[0]['request']->getBody(), true);
        $this->assertSame(JevRouter::MODEL, $body['model']);
    }

    public function testItIsADecisionRouter(): void
    {
        $this->assertInstanceOf(\AgentTeam\Services\DecisionRouter::class, new JevRouter('k'));
    }
}
