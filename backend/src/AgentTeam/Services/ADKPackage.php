<?php

declare(strict_types=1);

namespace AgentTeam\Services;

/** The ADK package's own files: CompiledPackage with ADK's framework packages. */
final class ADKPackage
{
    public const FRAMEWORK = ['google-adk', 'litellm'];

    public static function files(array $analyzed, string $skillsRoot, array $documentFiles = []): array
    {
        return CompiledPackage::files($analyzed, $skillsRoot, $documentFiles, self::FRAMEWORK, 'Google ADK');
    }

    public static function codePath(array $analyzed, string $nid): string
    {
        return CompiledPackage::codePath($analyzed, $nid);
    }
}
