<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit\Services;

use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Services\Edition;

class EditionTest extends TestCase
{
    public function test_only_corporate_refuses_local_sign_in(): void
    {
        $this->assertNull(Edition::refuseLocalSignIn([]));
        $this->assertNull(Edition::refuseLocalSignIn(['edition' => '']));
        $this->assertNull(Edition::refuseLocalSignIn(['edition' => 'individual']));
        $refused = Edition::refuseLocalSignIn(['edition' => 'corporate']);
        $this->assertSame(403, $refused['status_code']);
        $this->assertFalse($refused['success']);
    }

    public function test_is_corporate_is_exact(): void
    {
        $this->assertTrue(Edition::isCorporate(['edition' => 'corporate']));
        $this->assertFalse(Edition::isCorporate(['edition' => 'Corporate']));
        $this->assertFalse(Edition::isCorporate([]));
    }
}
