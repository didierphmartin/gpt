import { LLMProviderResolver } from '../../Services/LLMProviderResolver';
import { ProviderFactory } from '../../Providers/ProviderFactory';
import { LLMProvider } from '../../Contracts/LLMProvider';
import { SkillToolBridge } from '../../AgentTeam/SkillToolBridge';
import { LlmResponse } from '../PlaybookInterpreter';

/** Builds the provider for one round (test seam). */
export type ProviderMaker = (provider: string, model: string | null, settings: any) => Promise<LLMProvider>;

/**
 * One LLM round of the interpreter, on the node's provider/model/settings: the interpreter's messages
 * and tool definitions in, {text, tool_calls} out. Mirrors backend/src/Playbook/Adapters/WorkflowLlmClient.php.
 *
 * PHP runs the round through AgentRunner's parallel executor (one request with the tool definitions,
 * tool calls parsed, never executed). Here the provider is resolved as AgentRunner resolves it and
 * every tool is declared as a client-side tool, so the provider hands the model's tool calls back
 * instead of running them — the same one request, one answer. A failed call throws (an error text
 * returned instead would read to the interpreter as a benign final answer).
 */
export class WorkflowLlmClient {
  constructor(
    private readonly nodeConfig: Record<string, any>,
    private readonly makeProvider: ProviderMaker = defaultProvider,
  ) {}

  async invoke(messages: any[], toolDefs: any[]): Promise<LlmResponse> {
    // || not ??: the node modal's "(default)" option submits an EMPTY STRING.
    const providerKey = String(this.nodeConfig.agent_provider || '') || String(this.nodeConfig.provider || '') || 'openai';
    let response: any;
    try {
      const provider = await this.makeProvider(providerKey, this.nodeConfig.model ?? null, this.nodeConfig.settings ?? []);
      const tools = WorkflowLlmClient.flattenToolDefs(toolDefs);
      const first = messages[0];
      const hasSystem = first && first.role === 'system';
      response = await provider.chat({
        message: '',
        system_prompt: hasSystem ? String(first.content ?? '') : '',
        conversation_history: hasSystem ? messages.slice(1) : messages,
        client_tools: tools,
        client_tool_names: tools.map((t) => t.name),
      });
    } catch (e: any) {
      throw new Error('LLM call failed: ' + (e?.message ?? 'no response'));
    }
    return {
      text: response?.text ?? null,
      tool_calls: WorkflowLlmClient.normalizeToolCalls(response?.pending_client_tool_call ? (response.pending_tool_calls ?? []) : []),
    };
  }

  /** The interpreter's {type:'function', function:{name, description, parameters}} defs -> the flat {name, description, input_schema} shape. */
  static flattenToolDefs(toolDefs: any[]): Array<{ name: string; description: string; input_schema: any }> {
    return toolDefs.map((def) => {
      if (def && typeof def.function === 'object' && def.function !== null && !Array.isArray(def.function)) {
        return {
          name: def.function.name ?? '',
          description: def.function.description ?? '',
          input_schema: def.function.parameters ?? { type: 'object', properties: [] },
        };
      }
      return def; // already flat
    });
  }

  /** Provider tool-call shapes -> the interpreter's {id, name, arguments: object}. */
  static normalizeToolCalls(toolCalls: any[]): Array<{ id: string; name: string; arguments: Record<string, any> }> {
    return toolCalls.map((tc) => {
      const name = tc?.function?.name ?? tc?.name ?? '';
      const raw = tc?.function?.arguments ?? tc?.input ?? tc?.arguments ?? {};
      let args: any = raw;
      if (typeof raw === 'string') {
        try {
          args = JSON.parse(raw) ?? {};
        } catch {
          args = {};
        }
      }
      if (args === null || typeof args !== 'object') args = {};
      return { id: tc?.id ?? SkillToolBridge.generateToolCallId(), name, arguments: args };
    });
  }
}

async function defaultProvider(providerKey: string, model: string | null, settings: any): Promise<LLMProvider> {
  const base = await LLMProviderResolver.getProviderConfig(providerKey);
  if (!base) throw new Error(`No API key for provider '${providerKey}'`);
  const cfg: any = { ...base };
  if (model) cfg.model = model;
  if (settings && typeof settings === 'object' && !Array.isArray(settings)) {
    if (settings.temperature !== undefined && settings.temperature !== null) cfg.temperature = parseFloat(String(settings.temperature));
    if (settings.max_tokens !== undefined && settings.max_tokens !== null) cfg.max_tokens = parseInt(String(settings.max_tokens), 10);
  }
  return ProviderFactory.create(cfg);
}
