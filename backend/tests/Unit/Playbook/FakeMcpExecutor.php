<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit\Playbook;

use Quantis\AIPortfolioAssistant\Playbook\McpExecutorInterface;

final class FakeMcpExecutor implements McpExecutorInterface
{
    /** @var array<int,array{server:string,tool:string,args:array}> */
    public array $calls = [];

    /** @var array<string,mixed> map "server.tool" => canned result */
    public array $canned = [];

    public function call(string $server, string $tool, array $args): array
    {
        $this->calls[] = ['server' => $server, 'tool' => $tool, 'args' => $args];
        $key = "$server.$tool";
        return $this->canned[$key] ?? ['ok' => true, 'result' => ['done' => true]];
    }

    public function availableTools(): array
    {
        return [
            'okta.search_users' => [
                'description' => 'Search Okta users by attribute',
                'input_schema' => [
                    'type' => 'object',
                    'properties' => ['email' => ['type' => 'string']],
                    'required' => ['email'],
                ],
            ],
            'okta.reset_password' => [
                'description' => 'Reset an Okta user password',
                'input_schema' => [
                    'type' => 'object',
                    'properties' => ['user_id' => ['type' => 'string']],
                    'required' => ['user_id'],
                ],
            ],
        ];
    }
}
