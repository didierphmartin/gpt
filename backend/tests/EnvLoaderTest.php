<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests;
use PHPUnit\Framework\TestCase;

final class EnvLoaderTest extends TestCase
{
    public function testLoadsValuesFromEnvFile(): void
    {
        require __DIR__ . '/../config/load_env.php';
        $this->assertNotSame('', $_ENV['DB_HOST'] ?? '', 'DB_HOST should be loaded from backend/.env');
        $this->assertNotSame('', $_ENV['JWT_SECRET'] ?? '', 'JWT_SECRET should be loaded from backend/.env');
    }
}
