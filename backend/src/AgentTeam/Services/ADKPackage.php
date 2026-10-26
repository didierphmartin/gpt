<?php

declare(strict_types=1);

namespace AgentTeam\Services;

/** The ADK package's own files: CompiledPackage with ADK's framework packages. */
final class ADKPackage
{
    /** google-adk 2.3.x still supports SequentialAgent/ParallelAgent; litellm carries the non-Gemini providers. */
    public const FRAMEWORK = ['google-adk', 'litellm'];

    /** The compile target, as CompiledPackage reads it. */
    public const TARGET = ['key' => 'adk', 'title' => 'Google ADK', 'framework' => self::FRAMEWORK];

    public static function files(array $analyzed, string $skillsRoot, array $documentFiles = [], string $layout = 'modular'): array
    {
        return CompiledPackage::files($analyzed, $skillsRoot, $documentFiles, self::TARGET, $layout);
    }

    public static function codePath(array $analyzed, string $nid): string
    {
        return CompiledPackage::codePath($analyzed, $nid);
    }
}
