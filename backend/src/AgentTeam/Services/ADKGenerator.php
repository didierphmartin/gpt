<?php

declare(strict_types=1);

namespace AgentTeam\Services;

use PDO;

/**
 * ADKGenerator
 *
 * Generates a standalone Python Google ADK script from a saved workflow.
 * The generated file is fully independent of the PHP backend — it runs
 * directly against the Google ADK runtime using LiteLLM for multi-provider
 * model support.
 *
 * emitAdk() is a pure static method (no DB/I/O) so it can be unit-tested
 * without a database. generate() does the DB lookup via WorkflowGraphAnalyzer
 * and then delegates to emitAdk().
 */
class ADKGenerator
{
    public function __construct(
        private PDO $db,
        private WorkflowRepository $workflowRepo,
        private WorkflowGraphRepository $graphRepo,
        private AgentRepository $agentRepo
    ) {}

    /**
     * Generate a Google ADK Python script for the given workflow.
     *
     * @return array{filename: string, code: string}
     */
    public function generate(int $workflowId, ?string $userId = null): array
    {
        $analyzer = new WorkflowGraphAnalyzer($this->db, $this->workflowRepo, $this->graphRepo, $this->agentRepo);
        $analyzed = $analyzer->analyze($workflowId, $userId);
        $name = preg_replace('/[^a-z0-9_]+/i', '_', $analyzed['workflow']['name']);
        return [
            'filename' => strtolower($name) . '_adk.py',
            'code'     => self::emitAdk($analyzed),
        ];
    }

    /**
     * Pure emit entry-point.  Takes an AnalyzedGraph (from WorkflowGraphAnalyzer)
     * and returns the full Python source as a string.  No DB/I/O.
     *
     * Later tasks append blocks (MCP client, skill runner, tools, model factory,
     * agents, layering/root, __main__) into this method.
     */
    public static function emitAdk(array $analyzed): string
    {
        $lines = [];
        $lines[] = self::headerBlock($analyzed);
        // Later tasks append: mcp client, skill runner, tools, model factory,
        // agents, layering/root, main.
        return implode("\n", $lines) . "\n";
    }

    // -------------------------------------------------------------------------
    // Private emit helpers
    // -------------------------------------------------------------------------

    /**
     * Emit the file header: module docstring + all top-level imports.
     *
     * Uses a nowdoc (<<<'PY') with column-0 content — same convention as
     * PythonEmitHelpers::mcpClientBlock() — so the emitted Python lines carry
     * no stray PHP indentation.
     */
    private static function headerBlock(array $analyzed): string
    {
        $name = $analyzed['workflow']['name'];
        return <<<PY
"""Standalone Google ADK workflow: {$name}
Auto-generated -- backend-independent. Self-contained: MCP + skills run
in this program's own Python environment.

requirements:
    pip install google-adk litellm
"""
import asyncio, json, os, subprocess, sys, urllib.request
from typing import Any

from google.adk.agents import LlmAgent, SequentialAgent, ParallelAgent
from google.adk.models.lite_llm import LiteLlm
from google.adk.tools import FunctionTool
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
PY;
    }
}
