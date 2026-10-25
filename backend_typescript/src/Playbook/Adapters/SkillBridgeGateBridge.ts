import { SkillToolBridge } from '../../AgentTeam/SkillToolBridge';
import { GateBridge } from '../GateManager';

/**
 * Wires the immediate-mode human gates onto the workflow client-tool bridge: emit a 'gate_request'
 * event carrying a fresh tool_call_id, then wait on SkillToolBridge until the browser posts a decision
 * to /api/v1/workflows/tool-result. Mirrors backend/src/Playbook/Adapters/SkillBridgeGateBridge.php.
 */
export class SkillBridgeGateBridge implements GateBridge {
  constructor(private readonly emit: (event: Record<string, any>) => void) {}

  async ask(runId: number, kind: string, payload: Record<string, any>, timeoutMs: number): Promise<Record<string, any> | null> {
    const toolCallId = SkillToolBridge.generateToolCallId();
    this.emit({ type: 'gate_request', tool_call_id: toolCallId, kind, payload, run_id: runId });
    return SkillToolBridge.awaitResult(toolCallId, timeoutMs);
  }
}
