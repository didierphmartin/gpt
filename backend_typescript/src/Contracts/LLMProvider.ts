import { SSEStream } from '../Services/SseStream';
import { FunctionExecutor } from './FunctionExecutor';
import { ChatOptions, ChatResult, ProviderConfig } from './types';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Base class for LLM providers — mirrors the PHP provider classes (ClaudeProvider, OpenAIProvider,
 * GeminiProvider) which share request-building helpers via a trait. Each concrete provider is
 * constructed with its resolved ProviderConfig and exposes streamChat()/chat().
 */
export abstract class LLMProvider {
  constructor(protected readonly config: ProviderConfig) {}

  protected functionExecutor?: FunctionExecutor;

  /** Mirrors ClaudeProvider::setFunctionExecutor — server-tool executor for the tool loop. */
  setFunctionExecutor(executor: FunctionExecutor): this {
    this.functionExecutor = executor;
    return this;
  }

  abstract streamChat(opts: ChatOptions, sse: SSEStream): Promise<ChatResult>;
  abstract chat(opts: ChatOptions): Promise<ChatResult>;

  /** Shared system-prompt assembly (mirrors ProviderRequestBuilderTrait::buildSystemPrompt). */
  protected buildSystemPrompt(opts: ChatOptions): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    const datePrefix = `Current date: ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} (${WEEKDAYS[d.getDay()]}).`;
    const persona =
      (opts.system_prompt && opts.system_prompt.trim() !== '' ? opts.system_prompt : this.config.system_prompt) ?? '';
    let systemPrompt = datePrefix + '\n\n' + persona.replace(/^\s+/, '');
    // Active Skill (chip-dragged SKILL.md body) — appended after the persona, mirroring PHP.
    if (opts.skill_content && opts.skill_content !== '') {
      systemPrompt = systemPrompt.replace(/\s+$/, '') + '\n\n' + opts.skill_content;
    }
    return systemPrompt;
  }

  /** Flatten a message content value (string or content-block array) to text. */
  protected extractText(content: any): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content.map((b) => (typeof b === 'string' ? b : b?.text ?? b?.content ?? '')).join('\n');
    }
    return '';
  }
}
