/**
 * Faithful port of src/AgentTeam/Services/StreamContext.php.
 *
 * Holds the SSE callback and provides methods for emitting agent activity events. Each emit writes
 * one plain `data: <json>\n\n` frame (the callback the AgentController wires up) — NOT a named
 * `event:` line. The provider's own chunk/progress frames (named events) interleave with these on
 * the same response stream, exactly as PHP produces them.
 *
 * `timestamp` mirrors PHP microtime(true): float seconds since the epoch (Date.now() / 1000).
 */
export type StreamEventCallback = (event: Record<string, any>) => void;

export class StreamContext {
  private onEvent: StreamEventCallback | null;
  private userId: number;
  private rootExecutionId: number | null = null;

  constructor(onEvent: StreamEventCallback | null = null, userId = 0) {
    this.onEvent = onEvent;
    this.userId = userId;
  }

  /** Set the event callback. */
  setEventCallback(callback: StreamEventCallback): this {
    this.onEvent = callback;
    return this;
  }

  /** Set the root execution ID (the top-level manager execution). */
  setRootExecutionId(executionId: number): this {
    this.rootExecutionId = executionId;
    return this;
  }

  /** Get the root execution ID. */
  getRootExecutionId(): number | null {
    return this.rootExecutionId;
  }

  /** Get user ID. */
  getUserId(): number {
    return this.userId;
  }

  /** Check if streaming is enabled. */
  isStreaming(): boolean {
    return this.onEvent !== null;
  }

  /** Emit an agent_start event. */
  emitAgentStart(
    agentId: number,
    agentName: string,
    agentType: string,
    parentAgentId: number | null = null,
    executionId: number | null = null
  ): void {
    this.emit({
      type: 'agent_start',
      agent_id: agentId,
      agent_name: agentName,
      agent_type: agentType,
      parent_agent_id: parentAgentId,
      execution_id: executionId,
      timestamp: Date.now() / 1000,
    });
  }

  /** Emit an agent_delegate event. */
  emitAgentDelegate(
    fromAgentId: number,
    fromAgentName: string,
    toAgentId: number,
    toAgentName: string,
    task: string
  ): void {
    const chars = [...task];
    this.emit({
      type: 'agent_delegate',
      from_agent_id: fromAgentId,
      from_agent_name: fromAgentName,
      to_agent_id: toAgentId,
      to_agent_name: toAgentName,
      task: chars.slice(0, 200).join('') + (chars.length > 200 ? '...' : ''),
      timestamp: Date.now() / 1000,
    });
  }

  /** Emit an agent_complete event. */
  emitAgentComplete(
    agentId: number,
    agentName: string,
    agentType: string,
    success = true,
    error: string | null = null,
    executionId: number | null = null
  ): void {
    this.emit({
      type: 'agent_complete',
      agent_id: agentId,
      agent_name: agentName,
      agent_type: agentType,
      success,
      error,
      execution_id: executionId,
      timestamp: Date.now() / 1000,
    });
  }

  /** Emit an agent_thinking event (for progress indication). */
  emitAgentThinking(agentId: number, agentName: string, status = 'thinking'): void {
    this.emit({
      type: 'agent_thinking',
      agent_id: agentId,
      agent_name: agentName,
      status,
      timestamp: Date.now() / 1000,
    });
  }

  /** Emit a text chunk (for streaming responses). */
  emitChunk(text: string, agentId: number, agentName: string): void {
    this.emit({
      type: 'chunk',
      text,
      agent_id: agentId,
      agent_name: agentName,
    });
  }

  /** Emit an error event. */
  emitError(error: string, agentId: number | null = null): void {
    this.emit({
      type: 'error',
      error,
      agent_id: agentId,
      timestamp: Date.now() / 1000,
    });
  }

  /** Emit a generic event. */
  emit(data: Record<string, any>): void {
    if (this.onEvent !== null) {
      this.onEvent(data);
    }
  }

  // =======================================================================
  // Workflow-level emit methods (faithful port of GraphWorkflowRunner.php's
  // emitNodeEvent / emitWorkflowEvent helpers). The runner builds the base
  // dict and array_merge()s the per-event extra over it; JS object key
  // assignment reproduces array_merge ordering (existing keys keep their
  // position, new keys are appended). The WorkflowRunLog persistence PHP does
  // before emit is STUBBED (deferred) — only the SSE emit is reproduced.
  // =======================================================================

  /** Mirrors emitNodeEvent(): base node identity fields + merged extra. `node` is a raw DB row. */
  emitNodeEvent(type: string, node: any, extra: Record<string, any> = {}): void {
    const data: Record<string, any> = {
      type,
      node_id: node.id,
      node_type: node.node_type,
      drawflow_id: node.drawflow_node_id ?? null,
      agent_id: node.agent_id ?? null,
      agent_name: extra.agent_name ?? null,
      timestamp: Date.now() / 1000,
    };
    for (const k of Object.keys(extra)) data[k] = extra[k];
    this.emit(data);
  }

  /** Mirrors emitWorkflowEvent(): base workflow identity fields + merged extra. */
  emitWorkflowEvent(type: string, workflowId: any, workflowName: any, extra: Record<string, any> = {}): void {
    const data: Record<string, any> = {
      type,
      workflow_id: workflowId,
      workflow_name: workflowName,
      timestamp: Date.now() / 1000,
    };
    for (const k of Object.keys(extra)) data[k] = extra[k];
    this.emit(data);
  }

  /** workflow_start frame. */
  emitWorkflowStart(workflowId: any, workflowName: any, extra: Record<string, any> = {}): void {
    this.emitWorkflowEvent('workflow_start', workflowId, workflowName, extra);
  }

  /** workflow_complete frame. */
  emitWorkflowComplete(workflowId: any, workflowName: any, extra: Record<string, any> = {}): void {
    this.emitWorkflowEvent('workflow_complete', workflowId, workflowName, extra);
  }

  /** node_start frame. */
  emitNodeStart(node: any, extra: Record<string, any> = {}): void {
    this.emitNodeEvent('node_start', node, extra);
  }

  /** node_log frame (mirrors nodeLog(): extra key order level, phase, message, data). */
  emitNodeLog(node: any, level: string, phase: string, message: string, data: Record<string, any> = {}): void {
    this.emitNodeEvent('node_log', node, { level, phase, message, data });
  }

  /** node_complete frame. */
  emitNodeComplete(node: any, extra: Record<string, any> = {}): void {
    this.emitNodeEvent('node_complete', node, extra);
  }

  /** node_trace frame. */
  emitNodeTrace(node: any, extra: Record<string, any> = {}): void {
    this.emitNodeEvent('node_trace', node, extra);
  }
}
