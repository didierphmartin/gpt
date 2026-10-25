/**
 * The two MCP calls the automations API makes, behind an interface so tests use a fake. Both answer the callRaw shape:
 * {ok: true, result: raw MCP result} or {ok: false, error: reason}. Mirrors backend/src/Automation/AutomationMcp.php.
 */
export type CallRawAnswer = { ok: boolean; result?: any; error?: string };

export interface AutomationMcp {
  /** describe_item {key} on the owner's server called serverName. */
  describe(userId: number, serverName: string, key: string): Promise<CallRawAnswer>;

  /** install_app on the deploy URL with the server's stored headers (header lines, never returned to a caller). */
  install(url: string, headerLines: string[], args: Record<string, any>, timeoutSeconds: number): Promise<CallRawAnswer>;
}
