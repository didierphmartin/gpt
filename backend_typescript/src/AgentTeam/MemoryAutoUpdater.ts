import { MemoryExtractor } from './MemoryExtractor';
import * as Memory from './UserMemoryRepository';

/** The repository operations the updater uses (overridable in tests). */
export interface MemoryStore {
  getSettings(userId: number): Promise<{ enabled: boolean; model: string }>;
  getBoth(userId: number): Promise<Record<string, string>>;
  setScope(userId: number, scope: string, content: string): Promise<void>;
  logEvent(userId: number, scope: string, source: string, before: string, after: string, rationale: string | null, sessionId: string | null): Promise<void>;
}

/**
 * Mirrors src/AgentTeam/Services/MemoryAutoUpdater.php — the post-turn memory auto-update:
 * skip cheap cases → extract → filter duplicates → merge per scope → compact if over budget →
 * write + audit row. Run after the response is delivered; callers swallow its failures.
 */
export class MemoryAutoUpdater {
  static readonly MIN_USER_MSG_CHARS = 20;
  private readonly extractor: MemoryExtractor;

  constructor(
    private readonly apiKey: string,
    baseUrl = '',
    chatEndpoint = '',
    private readonly store: MemoryStore = Memory,
    extractor?: MemoryExtractor,
  ) {
    this.extractor = extractor ?? new MemoryExtractor(apiKey, baseUrl, chatEndpoint);
  }

  /** One chat turn: what was written, or null when short-circuited. */
  async run(userId: number, sessionId: string, lastUserMsg: string, lastAssistantMsg: string): Promise<{ reason: string; written: string[] } | null> {
    if (userId <= 0 || this.apiKey === '') return null;
    if ([...lastUserMsg.replace(/^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g, '')].length < MemoryAutoUpdater.MIN_USER_MSG_CHARS) return null;

    const settings = await this.store.getSettings(userId);
    if (!settings.enabled) return null;

    const current = await this.store.getBoth(userId);
    const currentMemory = current[Memory.SCOPE_MEMORY] ?? '';
    const currentUser = current[Memory.SCOPE_USER] ?? '';

    const result = await this.extractor.extract(settings.model, currentMemory, currentUser, lastUserMsg, lastAssistantMsg);
    if (result === null) return null;

    const written: string[] = [];
    const memoryAdditions = result.memory_additions.length
      ? await this.extractor.filterDuplicates(settings.model, currentMemory, result.memory_additions) : [];
    const userAdditions = result.user_additions.length
      ? await this.extractor.filterDuplicates(settings.model, currentUser, result.user_additions) : [];

    if (memoryAdditions.length) {
      await this.applyScope(userId, Memory.SCOPE_MEMORY, currentMemory, memoryAdditions, result.reason, sessionId, settings.model, written);
    }
    if (userAdditions.length) {
      await this.applyScope(userId, Memory.SCOPE_USER, currentUser, userAdditions, result.reason, sessionId, settings.model, written);
    }
    return { reason: result.reason, written };
  }

  private async applyScope(
    userId: number, scope: string, current: string, additions: string[], reason: string, sessionId: string, model: string, written: string[],
  ): Promise<void> {
    const budget = Memory.budgetFor(scope);
    const candidate = Memory.buildMerged(current, additions);
    if (candidate === current) return; // all additions dedup'd away

    if ([...candidate].length <= budget) {
      await this.store.setScope(userId, scope, candidate);
      await this.store.logEvent(userId, scope, Memory.SOURCE_AUTO_EXTRACT, current, candidate, reason, sessionId);
      written.push(scope);
      return;
    }

    // Over budget — ask the model to compact, preserving the new additions verbatim.
    const compacted = await this.extractor.compact(model, candidate, budget, additions);
    if (compacted === null || compacted === '') {
      console.error(`[MemoryAutoUpdater] compact returned empty for user=${userId} scope=${scope}; skipping write`);
      return;
    }
    await this.store.setScope(userId, scope, compacted);
    await this.store.logEvent(userId, scope, Memory.SOURCE_COMPACT, current, compacted, reason, sessionId);
    written.push(scope);
  }
}
