<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Services;

use AgentTeam\Services\JevRouter;
use AgentTeam\Services\OpenAIDecisionRouter;

/**
 * Decision-model protocols this code can speak. A decision provider row
 * (system_llm_settings, api_format 'router') names one of these in its
 * `protocol` column; the admin may add any number of rows per protocol.
 * Adding a vendor = one DecisionRouter class + one entry here (and its twins
 * in the TS/Python backends and the LangGraph runtime).
 */
final class DecisionProtocols
{
    public const TYPESAFE = 'typesafe';
    public const OPENAI = 'openai';

    /**
     * @return array<string, array{label: string, url: string, model: string, console_url: string,
     *                             legacy_env: ?array{key: string, url: string}, adapter: class-string}>
     */
    public static function all(): array
    {
        return [
            self::TYPESAFE => [
                'label' => 'TypeSafe (Jev)',
                'url' => JevRouter::URL,
                'model' => JevRouter::MODEL,
                'console_url' => 'https://console.typesafe.ai/',
                // Env names compiled scripts read before per-row names existed.
                'legacy_env' => ['key' => 'TYPESAFE_API_KEY', 'url' => 'TYPESAFE_BASE_URL'],
                'adapter' => JevRouter::class,
            ],
            self::OPENAI => [
                'label' => 'OpenAI Decisions (GPT-6 Luna)',
                'url' => OpenAIDecisionRouter::URL,
                'model' => OpenAIDecisionRouter::MODEL,
                'console_url' => 'https://platform.openai.com/api-keys',
                // None: OPENAI_API_KEY is the LLM key, and the runner .env sync
                // drops legacy names -- it would delete the chat key.
                'legacy_env' => null,
                'adapter' => OpenAIDecisionRouter::class,
            ],
        ];
    }

    public static function get(?string $id): ?array
    {
        return self::all()[(string) $id] ?? null;
    }

    /** GET /admin/decision-protocols: what the admin can pick, without class names. */
    public static function catalog(): array
    {
        $out = [];
        foreach (self::all() as $id => $p) {
            $out[] = ['id' => $id, 'label' => $p['label'], 'url' => $p['url'],
                      'model' => $p['model'], 'console_url' => $p['console_url']];
        }
        return $out;
    }
}
