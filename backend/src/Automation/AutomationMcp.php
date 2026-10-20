<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Automation;

/** The two MCP calls the automations API makes, behind an interface so tests use a fake. Both answer the callRaw shape. */
interface AutomationMcp
{
    /** describe_item {key} on the owner's server called $serverName: ['ok'=>true,'result'=>raw MCP result] or ['ok'=>false,'error'=>reason]. */
    public function describe(int $userId, string $serverName, string $key): array;

    /** install_app on the deploy URL with the server's stored headers (header lines, never returned to a caller). */
    public function install(string $url, array $headerLines, array $args, int $timeoutSeconds): array;
}
