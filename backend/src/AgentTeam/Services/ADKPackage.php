<?php

declare(strict_types=1);

namespace AgentTeam\Services;

use RuntimeException;

/**
 * The files that make a compiled ADK package run on its own, in its own folder, as LangGraph's
 * modular package does: requirements.txt, .env.example, README.md, the code-node harness (a copy,
 * code_harness.py), each code node's code (code/), each used skill's folder (skills/) and the
 * Start's documents (start_documents/). workflow.py, common.py and api.py are ADKGenerator's.
 */
final class ADKPackage
{
    /** What every package imports (workflow, common, api). */
    private const BASE_REQUIREMENTS = ['google-adk', 'litellm', 'httpx', 'python-dotenv', 'fastapi', 'uvicorn'];

    /** The document converter's lazy imports, by attachment extension. */
    private const DOCUMENT_REQUIREMENTS = ['pdf' => 'pypdf', 'docx' => 'mammoth', 'pptx' => 'python-pptx', 'xlsx' => 'openpyxl'];

    private const HARNESS = __DIR__ . '/../../../../frontend/assets/py/code_node_harness.py';

    /**
     * @param array $analyzed ADKGenerator's analysis, with 'startDocuments' already pointing at start_documents/
     * @param list<array> $documentFiles the start_documents/ entries (LangGraphPackage::startDocuments()['files'])
     * @return list<array{path:string,code:string,encoding?:string}>
     */
    public static function files(array $analyzed, string $skillsRoot, array $documentFiles = []): array
    {
        $skills = LangGraphPackage::skillFiles(['agentData' => $analyzed['agents'] ?? []], $skillsRoot);
        $out = [
            ['path' => 'requirements.txt', 'code' => self::requirements($analyzed, $skills)],
            ['path' => '.env.example', 'code' => self::envExample($analyzed)],
            ['path' => 'README.md', 'code' => self::readme($analyzed)],
        ];
        if (($analyzed['code'] ?? []) !== []) {
            $harness = file_get_contents(self::HARNESS);
            if ($harness === false) {
                throw new RuntimeException('code node harness not found (frontend/assets/py/code_node_harness.py)');
            }
            $out[] = ['path' => 'code_harness.py', 'code' => $harness];
            foreach ($analyzed['code'] as $nid => $cd) {
                $out[] = LangGraphPackage::codeFile((string) $nid, $cd, self::isTrigger($analyzed, (string) $nid));
            }
        }
        foreach ($skills as $f) {
            $out[] = $f['entry'];
        }
        foreach ($documentFiles as $f) {
            $out[] = $f;
        }
        return $out;
    }

    /** code/<file> of a code node, as files() writes it. */
    public static function codePath(array $analyzed, string $nid): string
    {
        return LangGraphPackage::codeFile($nid, $analyzed['code'][$nid], self::isTrigger($analyzed, $nid))['path'];
    }

    /** The Start option's hidden code node (StartOptionGraph) carries its trigger in its config. */
    private static function isTrigger(array $analyzed, string $nid): bool
    {
        return is_array($analyzed['byId'][$nid]['config']['start_trigger'] ?? null);
    }

    private static function providers(array $analyzed): array
    {
        $p = [];
        foreach (array_merge(array_values($analyzed['agents'] ?? []), array_values($analyzed['playbooks'] ?? [])) as $d) {
            if (($d['provider'] ?? '') !== '') {
                $p[strtolower((string) $d['provider'])] = true;
            }
        }
        return array_keys($p);
    }

    /** requirements.txt: one per line, sorted, unique. */
    private static function requirements(array $analyzed, array $skillFiles): string
    {
        $req = self::BASE_REQUIREMENTS;
        foreach ($skillFiles as $f) {
            if ($f['rel'] === 'SKILL.md') {
                array_push($req, ...LangGraphPackage::skillDependencies($f['bytes']));
            }
        }
        foreach ($analyzed['startDocuments'] ?? [] as $doc) {
            $ext = strtolower(pathinfo((string) (is_array($doc) ? ($doc['path'] ?? $doc['name'] ?? '') : ''), PATHINFO_EXTENSION));
            if (isset(self::DOCUMENT_REQUIREMENTS[$ext])) {
                $req[] = self::DOCUMENT_REQUIREMENTS[$ext];
            }
        }
        $req = array_values(array_unique($req));
        sort($req, SORT_STRING);
        return implode("\n", $req) . "\n";
    }

    /** .env.example: every variable the program reads, commented (an empty KEY= would mask the runner's python/.env). */
    private static function envExample(array $analyzed): string
    {
        $L = [];
        $L[] = '# Environment of the workflow "' . $analyzed['workflow']['name'] . '" -- copy this file to .env and fill it in.';
        $L[] = '# The program reads .env from its own folder first, then from the folder two levels up';
        $L[] = '# (a local runner\'s .env). A variable already set in the environment is never overridden.';
        $L[] = '';
        $keys = [];
        foreach (self::providers($analyzed) as $p) {
            $k = PythonEmitHelpers::providerKeyEnv($p);
            if ($k !== null) {
                $keys[$k][] = $p;
            }
        }
        if ($keys) {
            $L[] = '# API keys of the LLM providers this workflow uses';
            foreach ($keys as $k => $provs) {
                $L[] = '# ' . implode(', ', array_unique($provs));
                $L[] = "# {$k}=";
            }
        } else {
            $L[] = '# No LLM provider is used by a node of this workflow.';
        }
        $L[] = '';
        $decision = [];
        foreach ((array) ($analyzed['decisions'] ?? []) as $d) {
            foreach ($d['decision'] as $c) {
                $decision[(string) $c['key_env']] = (string) $c['url_env'];
            }
        }
        if ($decision) {
            $L[] = '# Decision models the dispatchers may route with (each URL variable is optional: a gateway)';
            foreach ($decision as $key => $url) {
                $L[] = "# {$key}=";
                $L[] = "# {$url}=";
            }
            $L[] = '';
        }
        $slugs = $analyzed['serverSlugs'] ?? [];
        if ($slugs) {
            $L[] = '# MCP servers: the URL compiled in, and the HTTP headers the server needs (never compiled in)';
            foreach ($slugs as $url => $slug) {
                $up = strtoupper((string) $slug);
                $L[] = "MCP_URL_{$up}={$url}";
                $L[] = '# JSON object of HTTP headers, e.g. {"Authorization": "Bearer …"}';
                $L[] = "# MCP_HEADERS_{$up}=";
            }
            $L[] = '';
        }
        $L[] = '# Optional';
        $L[] = '# Where saved outputs go (default: outputs/ in this folder)';
        $L[] = '# SYNERGYAI_OUTPUT_ROOT=./outputs';
        if (LangGraphPackage::skillDirs(['agentData' => $analyzed['agents'] ?? []]) !== []) {
            $L[] = '# Where the skills are read from (default: skills/ in this folder)';
            $L[] = '# SYNERGYAI_SKILLS_DIR=./skills';
        }
        return implode("\n", $L) . "\n";
    }

    /** README.md: what the folder is, install, configure, run, serve. */
    private static function readme(array $analyzed): string
    {
        $name = (string) $analyzed['workflow']['name'];
        $L = [];
        $L[] = "# {$name}";
        $L[] = '';
        $L[] = 'A Google ADK program compiled from the SynergyAI workflow editor. It runs on its own: no database,';
        $L[] = 'no SynergyAI server. Everything it needs is in this folder.';
        $L[] = '';
        $L[] = '## Install';
        $L[] = '';
        $L[] = '```sh';
        $L[] = 'python3 -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt';
        $L[] = 'cp .env.example .env   # then fill in the API keys and MCP headers';
        $L[] = '```';
        $L[] = '';
        $L[] = '## Run';
        $L[] = '';
        $L[] = '```sh';
        $L[] = 'python workflow.py "your prompt"   # one run (no text: the Start node\'s prompt)';
        $L[] = 'python api.py --port 8000          # the run server SynergyAI\'s editor talks to';
        $L[] = '```';
        $L[] = '';
        $L[] = '## Files';
        $L[] = '';
        $L[] = '- `workflow.py` -- the workflow: one ADK agent per node, run in the canvas order.';
        $L[] = '- `api.py`, `common.py` -- the run server.';
        if (($analyzed['code'] ?? []) !== []) {
            $L[] = '- `code/` -- each code node\'s Python, read at every run (edit it here to change the node).';
            $L[] = '- `code_harness.py` -- the code-node contract (inputs, exits, declared MCP servers, timeout), as the editor runs it.';
        }
        if (LangGraphPackage::skillDirs(['agentData' => $analyzed['agents'] ?? []]) !== []) {
            $L[] = '- `skills/` -- the skills the agents run.';
        }
        if (($analyzed['startDocuments'] ?? []) !== []) {
            $L[] = '- `start_documents/` -- the documents attached to the Start node.';
        }
        $L[] = '- `outputs/` -- the saved results, when output storage is on (`SYNERGYAI_OUTPUT_ROOT` overrides).';
        return implode("\n", $L) . "\n";
    }
}
