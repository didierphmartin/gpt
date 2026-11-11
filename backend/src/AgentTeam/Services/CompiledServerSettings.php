<?php

declare(strict_types=1);

namespace AgentTeam\Services;

/**
 * The MCP servers' private settings a compile documents in its README ("MCP server settings"). Only the editor can
 * read them (they sit in the servers' own folders), so it sends them with the compile request; the generators keep
 * them for PackageDocs. A secret's value never travels: clean() blanks it whatever the request says.
 */
trait CompiledServerSettings
{
    /** @var list<array{name:string,nodes:list<string>,fields:list<array{name:string,label:string,required:bool,secret:bool,value:string}>}> */
    private array $serverSettings = [];

    /** The server settings the README documents (clean() shape). */
    public function withServerSettings(array $servers): static
    {
        $this->serverSettings = self::cleanServerSettings($servers);
        return $this;
    }

    /** A request's server_settings in the shape PackageDocs::serverSettings reads; anything malformed is left out. */
    public static function cleanServerSettings(mixed $servers): array
    {
        $out = [];
        foreach (is_array($servers) ? $servers : [] as $srv) {
            if (!is_array($srv) || !is_string($srv['name'] ?? null) || trim($srv['name']) === '') {
                continue;
            }
            $fields = [];
            foreach (is_array($srv['fields'] ?? null) ? $srv['fields'] : [] as $f) {
                if (!is_array($f) || !is_string($f['name'] ?? null) || !preg_match('/^[A-Za-z_][A-Za-z0-9_]*$/', $f['name'])) {
                    continue;
                }
                $secret = !empty($f['secret']);
                $fields[] = ['name' => $f['name'], 'label' => is_string($f['label'] ?? null) ? $f['label'] : '',
                    'required' => !empty($f['required']), 'secret' => $secret,
                    'value' => !$secret && is_scalar($f['value'] ?? null) ? (string) $f['value'] : ''];
            }
            $nodes = array_values(array_filter(is_array($srv['nodes'] ?? null) ? $srv['nodes'] : [], 'is_string'));
            $out[] = ['name' => trim($srv['name']), 'nodes' => $nodes, 'fields' => $fields];
        }
        return $out;
    }
}
