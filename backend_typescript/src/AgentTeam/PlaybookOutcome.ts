/**
 * Playbook node exit rule, shared by all engines: a run whose final status is 'resolved' takes the
 * 'done' exit; any other status takes 'failed'. Mirrors backend/src/AgentTeam/Services/PlaybookOutcome.php.
 */
export const PlaybookOutcome = {
  exit(status: string): 'done' | 'failed' {
    return status === 'resolved' ? 'done' : 'failed';
  },

  /** Null when done; otherwise 'gate:<kind>' when a gate stopped the run, else 'status:<status>'. */
  reason(status: string, gate: string | null): string | null {
    if (status === 'resolved') return null;
    return gate !== null ? 'gate:' + gate : 'status:' + status;
  },

  /** 'error:<message>' with whitespace runs collapsed to one space (a reason is one line). */
  errorReason(e: unknown): string {
    const msg = e instanceof Error ? e.message : String(e);
    return 'error:' + msg.replace(/\s+/gu, ' ').trim();
  },

  /**
   * The node's exit and output text: done iff reason is null; failed text starts with the reason line.
   * The job line (from-input nodes), when given, ends the text on both outcomes.
   */
  nodeResult(reason: string | null, transcript: string, jobLine: string | null): { exit: 'done' | 'failed'; text: string } {
    let text = reason === null ? transcript : PlaybookOutcome.failureText(reason, transcript);
    if (jobLine !== null) text += '\n\n' + jobLine;
    return { exit: reason === null ? 'done' : 'failed', text };
  },

  /** Node output on the 'failed' exit: one reason line, a blank line, then the transcript. */
  failureText(reason: string, transcript: string): string {
    return `Playbook failed: ${reason}\n\n${transcript}`;
  },
};
