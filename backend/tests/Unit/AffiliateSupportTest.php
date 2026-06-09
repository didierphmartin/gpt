<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Services\AffiliateSupport;

class AffiliateSupportTest extends TestCase
{
    public function testGeneratedKeyIsUrlSafeAndCorrectLength(): void
    {
        $key = AffiliateSupport::generateKey();
        $this->assertSame(16, strlen($key));
        $this->assertMatchesRegularExpression('/^[A-Za-z0-9]+$/', $key);
    }

    public function testKeysAreUnique(): void
    {
        $a = AffiliateSupport::generateKey();
        $b = AffiliateSupport::generateKey();
        $this->assertNotSame($a, $b);
    }

    public function testBuildLinkAppendsRefWithQuestionMark(): void
    {
        $this->assertSame(
            'https://shop.example.com/buy?ref=ABC123',
            AffiliateSupport::buildLink('https://shop.example.com/buy', 'ABC123')
        );
    }

    public function testBuildLinkUsesAmpersandWhenQueryExists(): void
    {
        $this->assertSame(
            'https://shop.example.com/buy?plan=pro&ref=ABC123',
            AffiliateSupport::buildLink('https://shop.example.com/buy?plan=pro', 'ABC123')
        );
    }

    public function testBuildLinkTrimsTrailingWhitespace(): void
    {
        $this->assertSame(
            'https://shop.example.com/buy?ref=K',
            AffiliateSupport::buildLink('  https://shop.example.com/buy  ', 'K')
        );
    }
}
