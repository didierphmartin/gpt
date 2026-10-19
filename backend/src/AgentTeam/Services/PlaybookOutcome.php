<?php
declare(strict_types=1);

namespace AgentTeam\Services;

/**
 * Playbook node exit rule, shared by all engines: a run whose final status is
 * 'resolved' takes the 'done' exit; any other status takes 'failed'.
 */
final class PlaybookOutcome
{
    public static function exit(string $status): string
    {
        return $status === 'resolved' ? 'done' : 'failed';
    }

    /** Null when done; otherwise 'gate:<kind>' when a gate stopped the run, else 'status:<status>'. */
    public static function reason(string $status, ?string $gate): ?string
    {
        if ($status === 'resolved') {
            return null;
        }
        return $gate !== null ? 'gate:' . $gate : 'status:' . $status;
    }

    /** Node output on the 'failed' exit: one reason line, a blank line, then the transcript. */
    public static function failureText(string $reason, string $transcript): string
    {
        return "Playbook failed: {$reason}\n\n{$transcript}";
    }
}
