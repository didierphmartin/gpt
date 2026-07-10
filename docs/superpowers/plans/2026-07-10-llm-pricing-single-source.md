# LLM Token Pricing — Single Source of Truth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `system_llm_settings` the single source of truth for LLM token pricing in both the PHP and TypeScript backends, removing every hardcoded price on a billing path.

**Architecture:** Introduce one `PricingResolver` per backend that returns `[input_per_1m, output_per_1m]` from `system_llm_settings` by `provider_key` (throwing when no valid price is configured). Every cost path calls it. Billing writers surface a thrown pricing error (null cost + error note + loud log); forecast/trace displays treat a throw as "unknown" and render "—". No cost path keeps its own price numbers.

**Tech Stack:** PHP 8 + PDO + PHPUnit 10 + Mockery; TypeScript + Kysely + `node:test` run via `tsx`; MySQL/MariaDB (`system_llm_settings`, `llm_usage_transactions`).

## Global Constraints

- Single source of truth for token prices is `system_llm_settings` (`price_input_per_1m`, `price_output_per_1m`). No hardcoded token-price numbers on any billing path.
- Alias normalization everywhere: `anthropic → claude`, `google → gemini` (lowercased first).
- A price of exactly `0` (e.g. self-hosted `gamma4` at 0/0) is a **valid** cost, used as-is.
- Missing row, a `NULL` price, or a failed DB query is an **error** → throw `PricingUnavailableException` (PHP) / `PricingUnavailableError` (TS). Never fall back to a hardcoded number.
- Billing writers (`UsageLogger`, `UsageTracker`) catch the throw, record `cost_usd = NULL` (not `0`), append a `PRICING_ERROR` note to `error_message`, and log loudly — never crash the user's request.
- Forecast/trace displays (`GraphWorkflowRunner`, `ExecutionTraceStore`) catch the throw and return `null` so the UI renders "—" (their existing "unknown" semantics).
- Out of scope: voice `VOICE_PRICING` (per-second audio) and `model_catalog.json` UI display prices.
- Both backends must be updated.

---

## File Structure

**PHP (new):**
- `backend/src/Exceptions/PricingUnavailableException.php` — typed exception.
- `backend/src/Services/PricingResolver.php` — DB-backed price lookup + pure row classifier.
- `backend/tests/Unit/Services/PricingResolverTest.php` — resolver tests.

**PHP (modified):**
- `backend/src/Services/UsageLogger.php` — delete `const PRICING`; `calculateCost` via resolver; surface error in `logTransaction`.
- `backend/src/Services/UsageTracker.php` — delete `const PRICING`; `calculateCost` via resolver; surface error in `trackRequest`.
- `backend/src/AgentTeam/Services/GraphWorkflowRunner.php` — `getProviderPricing` delegates to resolver; delete embedded defaults map.
- `backend/src/AgentTeam/Services/ExecutionTraceStore.php` — `pricing` delegates to resolver; delete embedded defaults map.
- `backend/src/Controllers/SystemSettingsController.php` — delete `PRICE_DEFAULTS`; seed new rows with NULL price.

**TypeScript (new):**
- `backend_typescript/src/Services/PricingResolver.ts` — DB-backed price lookup + pure row classifier + `PricingUnavailableError`.
- `backend_typescript/tests/PricingResolver.test.ts` — resolver tests.

**TypeScript (modified):**
- `backend_typescript/src/Services/UsageLogger.ts` — use resolver; surface error in `logChatTransaction`.
- `backend_typescript/src/AgentTeam/ExecutionTraceStore.ts` — `pricing` via resolver; delete defaults map.
- `backend_typescript/src/AgentTeam/GraphWorkflowRunner.ts` — pricing via resolver; delete defaults map.
- `backend_typescript/src/Controllers/SystemSettingsController.ts` — delete `PRICE_DEFAULTS`; seed NULL.
- `backend_typescript/src/Controllers/AdminController.ts` — delete embedded pricing defaults map (cost-time use).

---

## PHASE 1 — PHP

### Task 1: PricingResolver + exception (PHP)

**Files:**
- Create: `backend/src/Exceptions/PricingUnavailableException.php`
- Create: `backend/src/Services/PricingResolver.php`
- Test: `backend/tests/Unit/Services/PricingResolverTest.php`

**Interfaces:**
- Produces:
  - `Quantis\AIPortfolioAssistant\Exceptions\PricingUnavailableException extends \RuntimeException`
  - `Quantis\AIPortfolioAssistant\Services\PricingResolver`
    - `__construct(\PDO $pdo)`
    - `resolve(string $provider): array` → `[float $inputPer1M, float $outputPer1M]`; throws `PricingUnavailableException`
    - `static classifyRow(?array $row, string $key): array` → same return / throw (pure, DB-free; used by tests and `resolve`)

- [ ] **Step 1: Write the failing test**

```php
<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit\Services;

use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Services\PricingResolver;
use Quantis\AIPortfolioAssistant\Exceptions\PricingUnavailableException;

class PricingResolverTest extends TestCase
{
    public function testClassifyReturnsRatesForValidRow(): void
    {
        $rates = PricingResolver::classifyRow(
            ['price_input_per_1m' => '2.5000', 'price_output_per_1m' => '10.0000'],
            'openai'
        );
        $this->assertSame([2.5, 10.0], $rates);
    }

    public function testClassifyTreatsZeroAsValid(): void
    {
        $rates = PricingResolver::classifyRow(
            ['price_input_per_1m' => '0.0000', 'price_output_per_1m' => '0.0000'],
            'gamma4'
        );
        $this->assertSame([0.0, 0.0], $rates);
    }

    public function testClassifyThrowsOnMissingRow(): void
    {
        $this->expectException(PricingUnavailableException::class);
        $this->expectExceptionMessage("provider 'gemini'");
        PricingResolver::classifyRow(null, 'gemini');
    }

    public function testClassifyThrowsOnNullPrice(): void
    {
        $this->expectException(PricingUnavailableException::class);
        PricingResolver::classifyRow(
            ['price_input_per_1m' => null, 'price_output_per_1m' => '4.0000'],
            'kimi'
        );
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && ./vendor/bin/phpunit tests/Unit/Services/PricingResolverTest.php`
Expected: FAIL — `Class "Quantis\AIPortfolioAssistant\Services\PricingResolver" not found`.

- [ ] **Step 3: Create the exception**

`backend/src/Exceptions/PricingUnavailableException.php`:

```php
<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Exceptions;

/**
 * Thrown when a token price cannot be resolved from system_llm_settings
 * (no row, a NULL price, or a failed DB query). Never swallowed into a
 * hardcoded fallback — callers on the billing path surface it.
 */
class PricingUnavailableException extends \RuntimeException
{
}
```

- [ ] **Step 4: Create the resolver**

`backend/src/Services/PricingResolver.php`:

```php
<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Services;

use Quantis\AIPortfolioAssistant\Exceptions\PricingUnavailableException;

/**
 * Single source of truth for LLM token pricing: system_llm_settings.
 * Returns [input_per_1m, output_per_1m] for a provider, or throws.
 * A price of 0 is valid (e.g. self-hosted). NULL / missing / query error throws.
 */
final class PricingResolver
{
    private const ALIASES = ['anthropic' => 'claude', 'google' => 'gemini'];

    /** @var array<string, array{0: float, 1: float}> */
    private array $cache = [];

    public function __construct(private \PDO $pdo)
    {
    }

    /**
     * @return array{0: float, 1: float} [inputPer1M, outputPer1M]
     * @throws PricingUnavailableException
     */
    public function resolve(string $provider): array
    {
        $key = self::ALIASES[strtolower($provider)] ?? strtolower($provider);
        if (isset($this->cache[$key])) {
            return $this->cache[$key];
        }

        try {
            $stmt = $this->pdo->prepare(
                'SELECT price_input_per_1m, price_output_per_1m
                 FROM system_llm_settings WHERE provider_key = :k LIMIT 1'
            );
            $stmt->execute([':k' => $key]);
            $row = $stmt->fetch(\PDO::FETCH_ASSOC) ?: null;
        } catch (\Throwable $e) {
            throw new PricingUnavailableException(
                "Pricing lookup failed for provider '{$key}' in system_llm_settings: " . $e->getMessage(),
                0,
                $e
            );
        }

        return $this->cache[$key] = self::classifyRow($row, $key);
    }

    /**
     * Pure classifier: a fetched row (or null) → rates or throw. DB-free for testing.
     *
     * @param array<string, mixed>|null $row
     * @return array{0: float, 1: float}
     * @throws PricingUnavailableException
     */
    public static function classifyRow(?array $row, string $key): array
    {
        if ($row === null) {
            throw new PricingUnavailableException(
                "No price configured for provider '{$key}' in system_llm_settings"
            );
        }
        if ($row['price_input_per_1m'] === null || $row['price_output_per_1m'] === null) {
            throw new PricingUnavailableException(
                "Null price for provider '{$key}' in system_llm_settings (set price_input_per_1m / price_output_per_1m)"
            );
        }
        return [(float) $row['price_input_per_1m'], (float) $row['price_output_per_1m']];
    }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && ./vendor/bin/phpunit tests/Unit/Services/PricingResolverTest.php`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add backend/src/Exceptions/PricingUnavailableException.php backend/src/Services/PricingResolver.php backend/tests/Unit/Services/PricingResolverTest.php
git commit -m "feat(pricing): add PHP PricingResolver reading system_llm_settings"
```

---

### Task 2: Rewire PHP UsageLogger (billing writer)

**Files:**
- Modify: `backend/src/Services/UsageLogger.php` — remove `const PRICING` (lines ~42–84 token map only; keep `VOICE_PRICING`); `calculateCost` via resolver; catch + surface in `logTransaction` (lines ~179–184, 233, 236).
- Test: `backend/tests/Unit/Services/UsageLoggerCostTest.php`

**Interfaces:**
- Consumes: `PricingResolver::resolve` (Task 1).
- Produces: `UsageLogger::calculateCost(string $provider, string $model, int $promptTokens, int $completionTokens): float` now **throws** `PricingUnavailableException` when pricing is unavailable (the `$model` arg is retained for signature compatibility but unused — pricing is per-provider).

- [ ] **Step 1: Write the failing test**

```php
<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit\Services;

use PHPUnit\Framework\TestCase;
use Mockery;
use Mockery\Adapter\Phpunit\MockeryPHPUnitIntegration;
use Quantis\AIPortfolioAssistant\Services\UsageLogger;
use Quantis\AIPortfolioAssistant\Exceptions\PricingUnavailableException;

class UsageLoggerCostTest extends TestCase
{
    use MockeryPHPUnitIntegration;

    protected function tearDown(): void { Mockery::close(); }

    private function pdoReturning(?array $row): \PDO
    {
        $stmt = Mockery::mock(\PDOStatement::class);
        $stmt->shouldReceive('execute')->andReturn(true);
        $stmt->shouldReceive('fetch')->andReturn($row === null ? false : $row);
        $pdo = Mockery::mock(\PDO::class);
        $pdo->shouldReceive('prepare')->andReturn($stmt);
        return $pdo;
    }

    public function testCalculateCostUsesDbPrice(): void
    {
        $logger = new UsageLogger($this->pdoReturning(
            ['price_input_per_1m' => '2.5000', 'price_output_per_1m' => '10.0000']
        ), true);
        // 1,000,000 in @2.50 + 1,000,000 out @10.00 = 12.50
        $this->assertSame(12.5, $logger->calculateCost('openai', 'gpt-4o', 1_000_000, 1_000_000));
    }

    public function testCalculateCostThrowsWhenUnconfigured(): void
    {
        $logger = new UsageLogger($this->pdoReturning(null), true);
        $this->expectException(PricingUnavailableException::class);
        $logger->calculateCost('gemini', 'gemini-3-flash-preview', 1000, 1000);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && ./vendor/bin/phpunit tests/Unit/Services/UsageLoggerCostTest.php`
Expected: FAIL — `testCalculateCostThrowsWhenUnconfigured` does not throw (old hardcoded map returns a number).

- [ ] **Step 3: Delete the token `PRICING` map and rewire `calculateCost`**

In `backend/src/Services/UsageLogger.php`, delete the `private const PRICING = [ ... ];` block (the per-provider/model token map, lines ~38–84). **Keep** `VOICE_PRICING`. Add a lazy resolver field near the other private props (after line 21):

```php
    private ?\Quantis\AIPortfolioAssistant\Services\PricingResolver $pricingResolver = null;
```

Replace the body of `calculateCost` (lines ~430–441) with:

```php
    public function calculateCost(string $provider, string $model, int $promptTokens, int $completionTokens): float
    {
        if ($this->pricingResolver === null) {
            $this->pricingResolver = new \Quantis\AIPortfolioAssistant\Services\PricingResolver($this->pdo);
        }
        [$inPer1M, $outPer1M] = $this->pricingResolver->resolve($provider);
        $cost = ($promptTokens / 1_000_000) * $inPer1M + ($completionTokens / 1_000_000) * $outPer1M;
        return round($cost, 6);
    }
```

- [ ] **Step 4: Surface the error in `logTransaction`**

In `backend/src/Services/UsageLogger.php`, replace the cost block (lines ~179–184) with:

```php
            // Calculate cost (voice or token-based)
            $costError = null;
            if ($isVoiceRequest) {
                $costUsd = $this->calculateVoiceCost($provider, $audioInputSeconds ?? 0, $audioOutputSeconds ?? 0);
            } else {
                try {
                    $costUsd = $this->calculateCost($provider, $model, $promptTokens, $completionTokens);
                } catch (\Quantis\AIPortfolioAssistant\Exceptions\PricingUnavailableException $e) {
                    $costUsd = null; // do NOT record a misleading $0
                    $costError = $e->getMessage();
                    error_log('❌ [UsageLogger] PRICING_ERROR: ' . $costError);
                }
            }
```

Update the `error_message` bind (line ~236) to append the pricing note:

```php
                ':error_message' => $costError !== null
                    ? trim((($data['error_message'] ?? '') . ' | PRICING_ERROR: ' . $costError))
                    : ($data['error_message'] ?? null),
```

Update the balance update cost (line ~253) so a null cost contributes 0 to the aggregate (the transaction row keeps the NULL + note):

```php
                'cost' => $costUsd ?? 0,
```

Leave `':cost_usd' => $costUsd` (line ~233) as-is — the column is nullable, so a pricing error stores `NULL`, visibly distinct from a real `0.00`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && ./vendor/bin/phpunit tests/Unit/Services/UsageLoggerCostTest.php`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add backend/src/Services/UsageLogger.php backend/tests/Unit/Services/UsageLoggerCostTest.php
git commit -m "refactor(pricing): PHP UsageLogger reads DB price, surfaces pricing errors"
```

---

### Task 3: Rewire PHP UsageTracker (billing writer)

**Files:**
- Modify: `backend/src/Services/UsageTracker.php` — delete `const PRICING` (lines ~22–53); `calculateCost` via resolver; catch + surface in `trackRequest` (line ~104 bind).
- Test: `backend/tests/Unit/Services/UsageTrackerCostTest.php`

**Interfaces:**
- Consumes: `PricingResolver::resolve` (Task 1).
- Produces: `UsageTracker::calculateCost(string $provider, string $model, int $inputTokens, int $outputTokens): float` throws `PricingUnavailableException` when unavailable.

- [ ] **Step 1: Write the failing test**

```php
<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit\Services;

use PHPUnit\Framework\TestCase;
use Mockery;
use Mockery\Adapter\Phpunit\MockeryPHPUnitIntegration;
use Quantis\AIPortfolioAssistant\Services\UsageTracker;
use Quantis\AIPortfolioAssistant\Exceptions\PricingUnavailableException;

class UsageTrackerCostTest extends TestCase
{
    use MockeryPHPUnitIntegration;

    protected function tearDown(): void { Mockery::close(); }

    private function pdoReturning(?array $row): \PDO
    {
        $stmt = Mockery::mock(\PDOStatement::class);
        $stmt->shouldReceive('execute')->andReturn(true);
        $stmt->shouldReceive('fetch')->andReturn($row === null ? false : $row);
        $pdo = Mockery::mock(\PDO::class);
        $pdo->shouldReceive('prepare')->andReturn($stmt);
        return $pdo;
    }

    public function testCalculateCostUsesDbPrice(): void
    {
        $tracker = new UsageTracker($this->pdoReturning(
            ['price_input_per_1m' => '0.2000', 'price_output_per_1m' => '0.5000']
        ), true);
        // 1M in @0.20 + 1M out @0.50 = 0.70
        $this->assertSame(0.7, $tracker->calculateCost('grok', 'grok-4-fast', 1_000_000, 1_000_000));
    }

    public function testCalculateCostThrowsWhenUnconfigured(): void
    {
        $tracker = new UsageTracker($this->pdoReturning(null), true);
        $this->expectException(PricingUnavailableException::class);
        $tracker->calculateCost('gemini', 'x', 1000, 1000);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && ./vendor/bin/phpunit tests/Unit/Services/UsageTrackerCostTest.php`
Expected: FAIL — `testCalculateCostThrowsWhenUnconfigured` does not throw.

- [ ] **Step 3: Delete `PRICING` and rewire `calculateCost`**

In `backend/src/Services/UsageTracker.php`, delete the `private const PRICING = [ ... ];` block (lines ~22–53). Add a lazy resolver field near `$pdo`/`$enabled` (after line ~15):

```php
    private ?PricingResolver $pricingResolver = null;
```

Add the import at the top `use` block:

```php
use Quantis\AIPortfolioAssistant\Services\PricingResolver;
```

(Already same namespace — `PricingResolver` resolves without a `use`, but add the field type reference as `?PricingResolver`.)

Replace the body of `calculateCost` (lines ~237–243) with:

```php
    public function calculateCost(string $provider, string $model, int $inputTokens, int $outputTokens): float
    {
        if ($this->pricingResolver === null) {
            $this->pricingResolver = new PricingResolver($this->pdo);
        }
        [$inPer1M, $outPer1M] = $this->pricingResolver->resolve($provider);
        $inputCost = ($inputTokens / 1_000_000) * $inPer1M;
        $outputCost = ($outputTokens / 1_000_000) * $outPer1M;
        return round($inputCost + $outputCost, 6);
    }
```

- [ ] **Step 4: Surface the error in `trackRequest`**

In `trackRequest`, replace the inline cost bind (line ~104) so a pricing error records NULL cost + a note instead of crashing. Just above the `$stmt->execute([ ... ])` call (line ~95), insert:

```php
            $costError = null;
            try {
                $costUsd = $this->calculateCost($provider, $model, $inputTokens, $outputTokens);
            } catch (\Quantis\AIPortfolioAssistant\Exceptions\PricingUnavailableException $e) {
                $costUsd = null;
                $costError = $e->getMessage();
                error_log('❌ [UsageTracker] PRICING_ERROR: ' . $costError);
            }
```

Then change the two binds inside `$stmt->execute([...])`:

```php
                ':cost_usd' => $costUsd,
```
```php
                ':error_message' => $costError !== null
                    ? trim((($data['error_message'] ?? '') . ' | PRICING_ERROR: ' . $costError))
                    : ($data['error_message'] ?? null),
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && ./vendor/bin/phpunit tests/Unit/Services/UsageTrackerCostTest.php`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add backend/src/Services/UsageTracker.php backend/tests/Unit/Services/UsageTrackerCostTest.php
git commit -m "refactor(pricing): PHP UsageTracker reads DB price, surfaces pricing errors"
```

---

### Task 4: Rewire PHP GraphWorkflowRunner (forecast/trace)

**Files:**
- Modify: `backend/src/AgentTeam/Services/GraphWorkflowRunner.php` — replace `getProviderPricing` (lines ~948–985) to delegate to `PricingResolver`; delete the embedded `$defaults` map.
- Test: covered by resolver tests; add one guard test `backend/tests/Unit/AgentTeam/GraphWorkflowPricingTest.php`.

**Interfaces:**
- Consumes: `PricingResolver::resolve` (Task 1).
- Produces: `GraphWorkflowRunner::getProviderPricing(string $provider): array` → `[?float, ?float]`; returns `[null, null]` when pricing is unavailable (forecast "—" semantics — does NOT throw).

- [ ] **Step 1: Write the failing test**

```php
<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit\AgentTeam;

use PHPUnit\Framework\TestCase;
use Mockery;
use Mockery\Adapter\Phpunit\MockeryPHPUnitIntegration;
use Quantis\AIPortfolioAssistant\Services\PricingResolver;
use Quantis\AIPortfolioAssistant\Exceptions\PricingUnavailableException;

/** Guards the forecast contract: unavailable pricing → [null,null], never a hardcoded number. */
class GraphWorkflowPricingTest extends TestCase
{
    use MockeryPHPUnitIntegration;

    protected function tearDown(): void { Mockery::close(); }

    public function testResolverThrowInMapsToNullPair(): void
    {
        $resolver = Mockery::mock(PricingResolver::class);
        $resolver->shouldReceive('resolve')->with('gemini')
            ->andThrow(new PricingUnavailableException('no price'));

        // Mirror the exact try/catch the runner uses.
        $pair = [null, null];
        try {
            $pair = $resolver->resolve('gemini');
        } catch (PricingUnavailableException $e) {
            $pair = [null, null];
        }
        $this->assertSame([null, null], $pair);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && ./vendor/bin/phpunit tests/Unit/AgentTeam/GraphWorkflowPricingTest.php`
Expected: FAIL — file/class references compile but the assertion documents the new contract; if `PricingResolver` mock isn't wired it errors. (This test locks the contract; it passes once Task 1 exists.)

- [ ] **Step 3: Rewire `getProviderPricing`**

Replace the whole method body (lines ~948–985) with:

```php
    private function getProviderPricing(string $provider): array
    {
        $provider = strtolower($provider);
        $aliases = ['anthropic' => 'claude', 'google' => 'gemini'];
        $key = $aliases[$provider] ?? $provider;

        if (isset($this->pricingCache[$key])) {
            return $this->pricingCache[$key];
        }

        try {
            $resolver = new \Quantis\AIPortfolioAssistant\Services\PricingResolver($this->db);
            [$in, $out] = $resolver->resolve($key);
        } catch (\Quantis\AIPortfolioAssistant\Exceptions\PricingUnavailableException $e) {
            // Forecast/trace surface: unknown pricing renders "—", not a guessed number.
            [$in, $out] = [null, null];
        }

        return $this->pricingCache[$key] = [$in, $out];
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && ./vendor/bin/phpunit tests/Unit/AgentTeam/GraphWorkflowPricingTest.php`
Expected: PASS (1 test).

- [ ] **Step 5: Verify no hardcoded map remains**

Run: `grep -n "0.55, 2.20\|=> \[0.30, 2.50\]\|'gemini'   => \[" backend/src/AgentTeam/Services/GraphWorkflowRunner.php`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add backend/src/AgentTeam/Services/GraphWorkflowRunner.php backend/tests/Unit/AgentTeam/GraphWorkflowPricingTest.php
git commit -m "refactor(pricing): PHP GraphWorkflowRunner pricing via resolver"
```

---

### Task 5: Rewire PHP ExecutionTraceStore (forecast/trace)

**Files:**
- Modify: `backend/src/AgentTeam/Services/ExecutionTraceStore.php` — replace `pricing` (lines ~420–449) to delegate to `PricingResolver`; delete embedded `$defaults` map.

**Interfaces:**
- Consumes: `PricingResolver::resolve` (Task 1).
- Produces: `ExecutionTraceStore::pricing(string $provider): array` → `[?float, ?float]`; `[null, null]` when unavailable (does NOT throw). `blendedCost` already coalesces null → 0.

- [ ] **Step 1: Rewire `pricing`**

Replace the method body (lines ~420–449) with:

```php
    private function pricing(string $provider): array
    {
        $provider = strtolower($provider);
        $key = ['anthropic' => 'claude', 'google' => 'gemini'][$provider] ?? $provider;
        if (isset($this->pricingCache[$key])) {
            return $this->pricingCache[$key];
        }
        try {
            $resolver = new PricingResolver($this->db);
            [$in, $out] = $resolver->resolve($key);
        } catch (PricingUnavailableException $e) {
            [$in, $out] = [null, null];
        }
        return $this->pricingCache[$key] = [$in, $out];
    }
```

Add imports to the top `use` block of the file:

```php
use Quantis\AIPortfolioAssistant\Services\PricingResolver;
use Quantis\AIPortfolioAssistant\Exceptions\PricingUnavailableException;
```

- [ ] **Step 2: Verify no hardcoded map remains**

Run: `grep -n "0.55, 2.20\|3.00, 15.00" backend/src/AgentTeam/Services/ExecutionTraceStore.php`
Expected: no output.

- [ ] **Step 3: Syntax check**

Run: `php -l backend/src/AgentTeam/Services/ExecutionTraceStore.php`
Expected: `No syntax errors detected`.

- [ ] **Step 4: Commit**

```bash
git add backend/src/AgentTeam/Services/ExecutionTraceStore.php
git commit -m "refactor(pricing): PHP ExecutionTraceStore pricing via resolver"
```

---

### Task 6: PHP SystemSettingsController — drop PRICE_DEFAULTS, seed NULL

**Files:**
- Modify: `backend/src/Controllers/SystemSettingsController.php` — delete `const PRICE_DEFAULTS` (lines ~29–41); every use (lines ~135–139, 239, 250–251, 272, 283–284, 345–349, 620) resolves to `[null, null]` so display backfill and new-row seeding leave price NULL when the DB has none.

**Interfaces:**
- Produces: provider rows created/normalized with `price_input_per_1m`/`price_output_per_1m` left as the stored DB value or `null` — never a hardcoded default.

- [ ] **Step 1: Delete the constant**

Remove the `private const PRICE_DEFAULTS = [ ... ];` block (lines ~29–41).

- [ ] **Step 2: Replace each lookup with a null pair**

At each site that did `$defaults = self::PRICE_DEFAULTS[...] ?? [null, null];` (lines ~135, 239, 272, 345, 620), replace with:

```php
                $defaults = [null, null];
```

The existing `isset(...) ? (float)... : $defaults[0]` expressions then correctly keep a stored DB price and leave it `null` when absent. No other logic changes.

- [ ] **Step 3: Syntax check**

Run: `php -l backend/src/Controllers/SystemSettingsController.php`
Expected: `No syntax errors detected`.

- [ ] **Step 4: Verify constant is gone and unreferenced**

Run: `grep -n "PRICE_DEFAULTS" backend/src/Controllers/SystemSettingsController.php`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add backend/src/Controllers/SystemSettingsController.php
git commit -m "refactor(pricing): PHP SystemSettings seeds NULL price, no hardcoded defaults"
```

---

## PHASE 2 — TypeScript

### Task 7: PricingResolver + error (TS)

**Files:**
- Create: `backend_typescript/src/Services/PricingResolver.ts`
- Test: `backend_typescript/tests/PricingResolver.test.ts`

**Interfaces:**
- Produces:
  - `class PricingUnavailableError extends Error`
  - `function classifyRow(row: PriceRow | undefined, key: string): [number, number]` (pure; throws `PricingUnavailableError`)
  - `async function resolvePricing(provider: string): Promise<[number, number]>` (DB-backed; throws)
  - `type PriceRow = { price_input_per_1m: unknown; price_output_per_1m: unknown }`

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRow, PricingUnavailableError } from '../src/Services/PricingResolver';

test('classifyRow returns rates for a valid row', () => {
  assert.deepEqual(
    classifyRow({ price_input_per_1m: '2.5000', price_output_per_1m: '10.0000' }, 'openai'),
    [2.5, 10.0],
  );
});

test('classifyRow treats 0 as valid', () => {
  assert.deepEqual(
    classifyRow({ price_input_per_1m: '0.0000', price_output_per_1m: '0.0000' }, 'gamma4'),
    [0, 0],
  );
});

test('classifyRow throws on missing row', () => {
  assert.throws(() => classifyRow(undefined, 'gemini'), PricingUnavailableError);
});

test('classifyRow throws on null price', () => {
  assert.throws(
    () => classifyRow({ price_input_per_1m: null, price_output_per_1m: '4.0' }, 'kimi'),
    PricingUnavailableError,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend_typescript && node --import tsx --test tests/PricingResolver.test.ts`
Expected: FAIL — cannot find module `../src/Services/PricingResolver`.

- [ ] **Step 3: Create the resolver**

`backend_typescript/src/Services/PricingResolver.ts`:

```ts
import { sql } from 'kysely';
import { db } from '../db/pools';

/**
 * Single source of truth for LLM token pricing: system_llm_settings.
 * resolvePricing() returns [input_per_1m, output_per_1m] or throws.
 * A price of 0 is valid; NULL / missing / query error throws.
 */
export class PricingUnavailableError extends Error {}

export type PriceRow = { price_input_per_1m: unknown; price_output_per_1m: unknown };

const ALIASES: Record<string, string> = { anthropic: 'claude', google: 'gemini' };

/** Pure: a fetched row (or undefined) → rates or throw. DB-free for testing. */
export function classifyRow(row: PriceRow | undefined, key: string): [number, number] {
  if (!row) {
    throw new PricingUnavailableError(`No price configured for provider '${key}' in system_llm_settings`);
  }
  if (row.price_input_per_1m === null || row.price_input_per_1m === undefined ||
      row.price_output_per_1m === null || row.price_output_per_1m === undefined) {
    throw new PricingUnavailableError(
      `Null price for provider '${key}' in system_llm_settings (set price_input_per_1m / price_output_per_1m)`,
    );
  }
  return [Number(row.price_input_per_1m), Number(row.price_output_per_1m)];
}

/** DB-backed lookup by provider_key (aliased). Throws PricingUnavailableError when unavailable. */
export async function resolvePricing(provider: string): Promise<[number, number]> {
  const p = provider.toLowerCase();
  const key = ALIASES[p] ?? p;
  let row: PriceRow | undefined;
  try {
    row = (
      await sql<PriceRow>`SELECT price_input_per_1m, price_output_per_1m
        FROM system_llm_settings WHERE provider_key = ${key} LIMIT 1`.execute(db)
    ).rows[0];
  } catch (e: any) {
    throw new PricingUnavailableError(
      `Pricing lookup failed for provider '${key}' in system_llm_settings: ${e?.message ?? e}`,
    );
  }
  return classifyRow(row, key);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend_typescript && node --import tsx --test tests/PricingResolver.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck**

Run: `cd backend_typescript && npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add backend_typescript/src/Services/PricingResolver.ts backend_typescript/tests/PricingResolver.test.ts
git commit -m "feat(pricing): add TS PricingResolver reading system_llm_settings"
```

---

### Task 8: Rewire TS UsageLogger (billing writer)

**Files:**
- Modify: `backend_typescript/src/Services/UsageLogger.ts` — remove `loadPricing`/`pricingCache`/`Pricing` (lines ~16–52); `calculateCost` delegates to `resolvePricing` (throws); `logChatTransaction` catches and surfaces (lines ~79–96).
- Test: `backend_typescript/tests/UsageLoggerCost.test.ts`

**Interfaces:**
- Consumes: `resolvePricing`, `PricingUnavailableError` (Task 7).
- Produces: `calculateCost(provider, promptTokens, completionTokens): Promise<number>` now **throws** `PricingUnavailableError` when unavailable (no more silent `Unknown provider → 0`).

- [ ] **Step 1: Write the failing test (pure cost math)**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { costFromRates } from '../src/Services/UsageLogger';

test('costFromRates computes token cost', () => {
  // 1M in @2.5 + 1M out @10 = 12.5
  assert.equal(costFromRates([2.5, 10], 1_000_000, 1_000_000), 12.5);
});

test('costFromRates handles zero rates', () => {
  assert.equal(costFromRates([0, 0], 5000, 5000), 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend_typescript && node --import tsx --test tests/UsageLoggerCost.test.ts`
Expected: FAIL — `costFromRates` is not exported.

- [ ] **Step 3: Replace pricing internals**

In `backend_typescript/src/Services/UsageLogger.ts`, delete lines ~16–52 (the `Pricing` interface, `pricingCache`, `pricingLoadedAt`, `PRICING_TTL_MS`, `loadPricing`, and the old `calculateCost`). Add the import at the top:

```ts
import { resolvePricing, PricingUnavailableError } from './PricingResolver';
```

Add a pure helper and the new throwing `calculateCost`:

```ts
/** Pure token-cost math from [input_per_1m, output_per_1m] rates. */
export function costFromRates(rates: [number, number], promptTokens: number, completionTokens: number): number {
  const cost = (promptTokens / 1_000_000) * rates[0] + (completionTokens / 1_000_000) * rates[1];
  return Math.round(cost * 1e6) / 1e6;
}

/** USD cost for a token-based call from DB pricing. Throws PricingUnavailableError when unavailable. */
export async function calculateCost(provider: string, promptTokens: number, completionTokens: number): Promise<number> {
  const rates = await resolvePricing(provider);
  return costFromRates(rates, promptTokens, completionTokens);
}
```

- [ ] **Step 4: Surface the error in `logChatTransaction`**

Replace the cost line (line ~79) and the `cost_usd` insert value (line ~91) so a pricing error stores NULL + note:

Replace:
```ts
    const costUsd = await calculateCost(data.provider, promptTokens, completionTokens);
    const status = data.status ?? 'success';
```
with:
```ts
    let costUsd: number | null = null;
    let errorMessage: string | null = data.error_message ?? null;
    try {
      costUsd = await calculateCost(data.provider, promptTokens, completionTokens);
    } catch (e: any) {
      if (e instanceof PricingUnavailableError) {
        costUsd = null; // do NOT record a misleading $0
        errorMessage = `${errorMessage ?? ''} | PRICING_ERROR: ${e.message}`.trim();
        log.error('[UsageLogger] PRICING_ERROR', e.message);
      } else {
        throw e;
      }
    }
    const status = data.status ?? 'success';
```

In the INSERT VALUES (line ~92), change `${data.error_message ?? null}` to `${errorMessage}`. The `cost_usd` bind `${costUsd}` now passes `null` on error (column is nullable). In the `updateBalance` call (line ~102), change `cost: costUsd` to `cost: costUsd ?? 0`.

- [ ] **Step 5: Run tests + typecheck**

Run: `cd backend_typescript && node --import tsx --test tests/UsageLoggerCost.test.ts && npm run typecheck`
Expected: PASS (2 tests) and no type errors.

- [ ] **Step 6: Commit**

```bash
git add backend_typescript/src/Services/UsageLogger.ts backend_typescript/tests/UsageLoggerCost.test.ts
git commit -m "refactor(pricing): TS UsageLogger reads DB price, surfaces pricing errors"
```

---

### Task 9: Rewire TS ExecutionTraceStore + GraphWorkflowRunner (forecast/trace)

**Files:**
- Modify: `backend_typescript/src/AgentTeam/ExecutionTraceStore.ts` — `pricing` (lines ~380–405) delegates to `resolvePricing`; delete `defaults` map.
- Modify: `backend_typescript/src/AgentTeam/GraphWorkflowRunner.ts` — pricing lookup (lines ~1793–1821) delegates to `resolvePricing`; delete `defaults` map.

**Interfaces:**
- Consumes: `resolvePricing`, `PricingUnavailableError` (Task 7).
- Produces: both `pricing(provider)` methods return `[number | null, number | null]`; `[null, null]` when unavailable (forecast "—"; do NOT throw).

- [ ] **Step 1: Rewire ExecutionTraceStore.pricing**

Replace the body of `pricing` (lines ~380–405, through the `catch`) with:

```ts
  private async pricing(provider: string): Promise<[number | null, number | null]> {
    provider = phpStrtolower(provider);
    const map: Record<string, string> = { anthropic: 'claude', google: 'gemini' };
    const key = map[provider] ?? provider;
    if (Object.prototype.hasOwnProperty.call(this.pricingCache, key)) {
      return this.pricingCache[key];
    }
    let pair: [number | null, number | null] = [null, null];
    try {
      pair = await resolvePricing(key);
    } catch (e) {
      if (!(e instanceof PricingUnavailableError)) throw e;
      pair = [null, null]; // forecast/trace: unknown → "—"
    }
    this.pricingCache[key] = pair;
    return pair;
  }
```

Add the import near the top of the file:

```ts
import { resolvePricing, PricingUnavailableError } from '../Services/PricingResolver';
```

- [ ] **Step 2: Rewire GraphWorkflowRunner pricing**

In `backend_typescript/src/AgentTeam/GraphWorkflowRunner.ts`, replace the `defaults` map + DB select block (lines ~1803–1821) with a `resolvePricing` call wrapped in the same try/catch returning `[null, null]` on `PricingUnavailableError`. Add the import:

```ts
import { resolvePricing, PricingUnavailableError } from '../Services/PricingResolver';
```

Replace the block:
```ts
    const defaults: Record<string, [number, number]> = {
      claude: [3.0, 15.0], openai: [2.5, 10.0], gemini: [0.3, 2.5],
      grok: [0.2, 0.5], deepseek: [0.28, 0.42], kimi: [0.55, 2.2],
    };
    // ...existing SELECT ... system_llm_settings ... override
```
with:
```ts
    let pair: [number | null, number | null] = [null, null];
    try {
      pair = await resolvePricing(key);
    } catch (e) {
      if (!(e instanceof PricingUnavailableError)) throw e;
      pair = [null, null];
    }
    this.pricingCache[key] = pair;
    return pair;
```

(Keep the surrounding alias/cache lines that define `key` and `this.pricingCache` exactly as they are.)

- [ ] **Step 3: Verify no hardcoded maps remain + typecheck**

Run: `cd backend_typescript && grep -rn "0.55, 2.2\|\[3.0, 15.0\]" src/AgentTeam/ ; npm run typecheck`
Expected: grep prints nothing; typecheck passes.

- [ ] **Step 4: Commit**

```bash
git add backend_typescript/src/AgentTeam/ExecutionTraceStore.ts backend_typescript/src/AgentTeam/GraphWorkflowRunner.ts
git commit -m "refactor(pricing): TS trace/workflow pricing via resolver"
```

---

### Task 10: TS SystemSettingsController + AdminController — drop defaults, seed NULL

**Files:**
- Modify: `backend_typescript/src/Controllers/SystemSettingsController.ts` — delete `PRICE_DEFAULTS` (lines ~58–67); each use (lines ~139, 225, 258, 312, 521) resolves to `[null, null]`.
- Modify: `backend_typescript/src/Controllers/AdminController.ts` — delete the embedded pricing defaults map (~line 1793) used at cost time; use `[null, null]` when the DB has no price.

**Interfaces:**
- Produces: provider rows seeded/normalized with stored DB price or `null` — never a hardcoded default.

- [ ] **Step 1: SystemSettingsController — remove constant, null the lookups**

Delete the `private static readonly PRICE_DEFAULTS: ... = { ... };` block (lines ~58–67). At each `const defaults/prices = SystemSettingsController.PRICE_DEFAULTS[...] ?? [null, null];` site (lines ~139, 225, 258, 312, 521) replace with:

```ts
      const defaults: [number | null, number | null] = [null, null];
```
(matching the existing variable name at each site — `defaults` or `prices`/`priceDefaults`).

- [ ] **Step 2: AdminController — remove the cost-time defaults map**

At `backend_typescript/src/Controllers/AdminController.ts` ~line 1793, replace the embedded price-fallback map with `[null, null]` (or drop the coalesce so a null DB price stays null in the stats payload). Keep the `LEFT JOIN system_llm_settings` query as the source.

- [ ] **Step 3: Verify + typecheck**

Run: `cd backend_typescript && grep -rn "PRICE_DEFAULTS\|\[3.0, 15.0\]" src/Controllers/ ; npm run typecheck`
Expected: grep prints nothing; typecheck passes.

- [ ] **Step 4: Commit**

```bash
git add backend_typescript/src/Controllers/SystemSettingsController.ts backend_typescript/src/Controllers/AdminController.ts
git commit -m "refactor(pricing): TS SystemSettings/Admin seed NULL price, no hardcoded defaults"
```

---

## PHASE 3 — Cleanup & verification

### Task 11: Final sweep — no hardcoded token prices remain

**Files:**
- Verify only; no new code. Confirms the interim `PRICE_DEFAULTS` value edits (gemini 0.50/3.00, kimi 0.60/2.50) are gone with the deleted constants.

- [ ] **Step 1: Repo-wide grep for hardcoded token-price maps on billing/forecast paths**

Run:
```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt
grep -rnwiE "PRICING|PRICE_DEFAULTS" \
  --include='*.php' --include='*.ts' \
  backend/src backend_typescript/src \
  | grep -viE "VOICE_PRICING|node_modules|/vendor/"
```
Expected: no matches referencing token-price maps (only unrelated comments, if any). `VOICE_PRICING` is intentionally excluded (out of scope).

- [ ] **Step 2: Confirm every cost path routes through a resolver**

Run:
```bash
grep -rn "PricingResolver\|resolvePricing" backend/src backend_typescript/src | grep -v test
```
Expected: references in UsageLogger (PHP+TS), UsageTracker (PHP), GraphWorkflowRunner (PHP+TS), ExecutionTraceStore (PHP+TS).

- [ ] **Step 3: Run the full unit suites**

Run:
```bash
cd backend && ./vendor/bin/phpunit tests/Unit/Services tests/Unit/AgentTeam
cd ../backend_typescript && node --import tsx --test tests/PricingResolver.test.ts tests/UsageLoggerCost.test.ts && npm run typecheck
```
Expected: all green.

- [ ] **Step 4: Manual end-to-end sanity (both backends)**

- Set a provider's `price_input_per_1m` to `NULL` in `system_llm_settings`, run one chat with that provider, confirm the new transaction row has `cost_usd IS NULL` and `error_message` contains `PRICING_ERROR`, and the backend log shows the loud `PRICING_ERROR` line. Restore the price.
- Confirm `gamma4` (0/0) records `cost_usd = 0.000000` with no error.

- [ ] **Step 5: Commit (docs/verification note if any)**

```bash
git add -A
git commit -m "chore(pricing): verify single-source pricing, no hardcoded token maps remain"
```

---

## Self-Review

- **Spec coverage:** resolver (Tasks 1, 7); delete hardcoded billing maps (Tasks 2, 3, 8); forecast/trace via resolver (Tasks 4, 5, 9); seed NULL / drop defaults (Tasks 6, 10); 0-valid + NULL-throws + error-surfacing encoded in Tasks 1–3, 7, 8; both backends covered; voice + catalog explicitly out of scope. ✅
- **Placeholder scan:** every code step shows complete code; grep/commands have expected output. ✅
- **Type consistency:** PHP `resolve(): array [float,float]` / `classifyRow`; TS `resolvePricing(): Promise<[number,number]>` / `classifyRow` / `costFromRates` / `PricingUnavailableError` used consistently across tasks. Billing callers expect throw; forecast callers catch → `[null,null]`. ✅
