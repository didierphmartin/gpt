<?php
declare(strict_types=1);

namespace AgentTeam\Services;

use PDO;

/**
 * Compiles a workflow DSL into a self-contained Microsoft Agent Framework
 * (Functional API) Python program. Third backend beside ADKGenerator /
 * LangGraphGenerator; reuses WorkflowGraphAnalyzer + PythonEmitHelpers.
 */
class MAFGenerator
{
    public function __construct(
        private PDO $db,
        private WorkflowRepository $workflowRepo,
        private WorkflowGraphRepository $graphRepo,
        private AgentRepository $agentRepo
    ) {}

    public function generate(int $workflowId, ?string $userId = null): array
    {
        $analyzer = new WorkflowGraphAnalyzer($this->db, $this->workflowRepo, $this->graphRepo, $this->agentRepo);
        $analyzed = $analyzer->analyze($workflowId, $userId);
        $name = preg_replace('/[^a-z0-9_]+/i', '_', $analyzed['workflow']['name']);
        return [
            'filename' => strtolower($name) . '_maf.py',
            'code'     => self::emitMaf($analyzed),
        ];
    }

    public static function emitMaf(array $analyzed): string
    {
        $parts = [];
        $parts[] = self::headerBlock($analyzed);
        $parts[] = self::clientFactoryBlock();
        // Task 4 will insert MCP blocks here; Task 2 emits `catalog = {}` for now.
        $parts[] = 'catalog = {}';
        // Task 2 inserts documentConverter, AGENTS, node runner, orchestration, main.
        return implode("\n\n", $parts) . "\n";
    }

    private static function headerBlock(array $analyzed): string
    {
        $name = str_replace(['"""', "\\"], ["'''", "\\\\"], (string) $analyzed['workflow']['name']);
        return <<<PY
        """Standalone Microsoft Agent Framework workflow: {$name}

        Auto-generated from the visual workflow editor. Backend-independent and
        self-contained: it calls the LLM providers, MCP servers, and folder-backed
        skills entirely from this one file.

        TO RUN:
            pip install "agent-framework>=1.10,<2" httpx python-dotenv
            # keys are read from ../.env (ANTHROPIC_API_KEY, OPENAI_API_KEY,
            #   GOOGLE_API_KEY, XAI_API_KEY, KIMI_API_KEY, DEEPSEEK_API_KEY)
            python this_file.py "your prompt here"
        """
        import asyncio
        import json
        import os
        import subprocess
        import sys
        import time
        import traceback
        import urllib.request

        import httpx
        from dotenv import load_dotenv
        from agent_framework import Agent, workflow
        from agent_framework.anthropic import AnthropicClient
        from agent_framework.openai import OpenAIChatCompletionClient

        # MAF does not auto-load .env; load the runner's .env (one dir up from scripts/).
        load_dotenv(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env"))
        PY;
    }

    private static function clientFactoryBlock(): string
    {
        return <<<'PY'
        def _make_client(provider: str, model: str):
            """Build a MAF chat client for the given provider/model. Claude uses the
            native AnthropicClient; everyone else uses OpenAIChatCompletionClient (the
            /chat/completions client) -- OpenAIChatClient targets /responses and 404s
            on OpenAI-compatible endpoints (Gemini/Grok/Kimi/DeepSeek)."""
            p = (provider or "claude").lower()
            if p == "claude":
                return AnthropicClient(model=model, api_key=os.environ.get("ANTHROPIC_API_KEY"))
            if p == "openai":
                return OpenAIChatCompletionClient(model=model, api_key=os.environ.get("OPENAI_API_KEY"))
            if p in ("gemini", "google"):
                return OpenAIChatCompletionClient(model=model, api_key=os.environ.get("GOOGLE_API_KEY"),
                    base_url="https://generativelanguage.googleapis.com/v1beta/openai/")
            if p == "grok":
                return OpenAIChatCompletionClient(model=model, api_key=os.environ.get("XAI_API_KEY"),
                    base_url="https://api.x.ai/v1")
            if p == "kimi":
                return OpenAIChatCompletionClient(model=model, api_key=os.environ.get("KIMI_API_KEY"),
                    base_url="https://api.moonshot.ai/v1")
            if p == "deepseek":
                return OpenAIChatCompletionClient(model=model, api_key=os.environ.get("DEEPSEEK_API_KEY"),
                    base_url="https://api.deepseek.com")
            raise RuntimeError(f"Unknown provider {provider!r} for model {model!r}")
        PY;
    }
}
