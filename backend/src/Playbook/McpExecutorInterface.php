<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Playbook;

interface McpExecutorInterface
{
    /** @return array{ok:bool,result?:mixed,error?:string} */
    public function call(string $server, string $tool, array $args): array;

    /** @return array<string,array{description:string,input_schema:array}> keyed "server.tool" */
    public function availableTools(): array;
}
