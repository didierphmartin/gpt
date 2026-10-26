<?php

declare(strict_types=1);

namespace AgentTeam\Services;

/**
 * The pip requirement of each package a compiled program imports, written once: requirements.txt, the
 * `pip install` line of a script's TO RUN docstring and the README all print what these functions return,
 * so they cannot disagree. Each target says WHICH packages it needs (LangGraphPackage, CompiledPackage);
 * this says how each is installed.
 */
final class PythonRequirements
{
    /**
     * The version bounds a package is installed with: the floors (and caps) the generated code is written
     * against, as the local runner's langchain_runner/requirements.txt pins them. A package not listed here
     * (a skill's dependency, a document converter) is installed as named.
     */
    private const SPECS = [
        'a2a-sdk[http-server]' => 'a2a-sdk[http-server]>=1.1,<2',
        'agent-framework' => 'agent-framework>=1.10,<2',
        'fastapi' => 'fastapi>=0.115.0',
        'google-adk' => 'google-adk>=2.3,<3',
        'httpx' => 'httpx>=0.27.0',
        'langchain' => 'langchain>=0.3.0',
        'langchain-anthropic' => 'langchain-anthropic>=0.3.0',
        'langchain-core' => 'langchain-core>=0.3.0',
        'langchain-google-genai' => 'langchain-google-genai>=2.0.0',
        'langchain-openai' => 'langchain-openai>=0.2.0',
        'langgraph' => 'langgraph>=0.2.50',
        'mcp' => 'mcp<2',   // nooa 0.0.8 targets the mcp 1.x SDK API (mcp 2.0 changed the client yield shape)
        'pydantic' => 'pydantic>=2.8.0',
        'python-dotenv' => 'python-dotenv>=1.0.0',
        'uvicorn' => 'uvicorn>=0.30.0',
    ];

    /** The document converter's lazy imports, by attachment extension. */
    private const DOCUMENT_REQUIREMENTS = ['pdf' => 'pypdf', 'docx' => 'mammoth', 'pptx' => 'python-pptx', 'xlsx' => 'openpyxl'];

    /**
     * The converter packages the Start's documents need, by their extension.
     *
     * @return list<string>
     */
    public static function documentNames(array $startDocuments): array
    {
        $out = [];
        foreach ($startDocuments as $doc) {
            $ext = strtolower(pathinfo((string) (is_array($doc) ? ($doc['path'] ?? $doc['name'] ?? '') : ''), PATHINFO_EXTENSION));
            if (isset(self::DOCUMENT_REQUIREMENTS[$ext])) {
                $out[] = self::DOCUMENT_REQUIREMENTS[$ext];
            }
        }
        return $out;
    }

    /**
     * The requirement lines of $names: each with its version bounds, one per package, sorted by name.
     *
     * @param list<string> $names
     * @return list<string>
     */
    public static function lines(array $names): array
    {
        $names = array_values(array_unique(array_map('strval', $names)));
        sort($names, SORT_STRING);
        return array_values(array_unique(array_map(fn(string $n) => self::SPECS[$n] ?? $n, $names)));
    }

    /** requirements.txt: lines(), one per line. */
    public static function txt(array $names): string
    {
        return implode("\n", self::lines($names)) . "\n";
    }

    /** One `pip install` command for $names; a requirement with a character the shell reads is double-quoted. */
    public static function pipInstall(array $names): string
    {
        $args = array_map(fn(string $r) => preg_match('/^[A-Za-z0-9._-]+$/', $r) ? $r : '"' . $r . '"', self::lines($names));
        return 'pip install ' . implode(' ', $args);
    }
}
