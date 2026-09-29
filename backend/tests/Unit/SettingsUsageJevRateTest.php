<?php
declare(strict_types=1);

use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Controllers\SettingsController;
use Quantis\AIPortfolioAssistant\Services\PricingResolver;

/** /settings/usage reports the Jev rate from its system_llm_settings row. */
final class SettingsUsageJevRateTest extends TestCase
{
    private function pdo(?string $in, ?string $out, bool $withRow = true): PDO
    {
        $pdo = new PDO('sqlite::memory:');
        $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $pdo->exec('CREATE TABLE system_llm_settings (provider_key TEXT, price_input_per_1m REAL NULL, price_output_per_1m REAL NULL)');
        if ($withRow) {
            $stmt = $pdo->prepare('INSERT INTO system_llm_settings VALUES (?, ?, ?)');
            $stmt->execute(['jev', $in, $out]);
        }
        return $pdo;
    }

    public function testPricedRowGivesNumbers(): void
    {
        $rate = SettingsController::rateOf(new PricingResolver($this->pdo('0.042', '0')), 'jev');
        $this->assertSame(['input' => 0.042, 'output' => 0.0], $rate);
    }

    public function testNullPricesGiveNull(): void
    {
        $this->assertNull(SettingsController::rateOf(new PricingResolver($this->pdo(null, null)), 'jev'));
    }

    public function testMissingRowGivesNull(): void
    {
        $this->assertNull(SettingsController::rateOf(new PricingResolver($this->pdo(null, null, false)), 'jev'));
    }

    public function testQueryErrorGivesNull(): void
    {
        $this->assertNull(SettingsController::rateOf(new PricingResolver(new PDO('sqlite::memory:')), 'jev'));
    }

    public function testQuotaTokensUsedLeavesJevOut(): void
    {
        $balances = [
            ['provider' => 'claude', 'total_tokens' => '1200'],
            ['provider' => 'jev', 'total_tokens' => '90000'],
            ['provider' => 'kimi', 'total_tokens' => 300],
        ];
        $this->assertSame(1500, SettingsController::quotaTokensUsed($balances));
        $this->assertSame(0, SettingsController::quotaTokensUsed([['provider' => 'jev', 'total_tokens' => 5]]));
        $this->assertSame(0, SettingsController::quotaTokensUsed([]));
    }
}
