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

    /** 'error:<message>' with whitespace runs collapsed to one space (a reason is one line). */
    public static function errorReason(\Throwable $e): string
    {
        return 'error:' . trim((string) preg_replace('/\s+/u', ' ', $e->getMessage()));
    }

    /**
     * The node's exit and output text: done iff $reason is null; failed text starts with the reason line.
     * The job line (from-input nodes), when given, ends the text on both outcomes.
     * @return array{exit:string,text:string}
     */
    public static function nodeResult(?string $reason, string $transcript, ?string $jobLine): array
    {
        $text = $reason === null ? $transcript : self::failureText($reason, $transcript);
        if ($jobLine !== null) {
            $text .= "\n\n" . $jobLine;
        }
        return ['exit' => $reason === null ? 'done' : 'failed', 'text' => $text];
    }

    /** Node output on the 'failed' exit: one reason line, a blank line, then the transcript. */
    public static function failureText(string $reason, string $transcript): string
    {
        return "Playbook failed: {$reason}\n\n{$transcript}";
    }
}
