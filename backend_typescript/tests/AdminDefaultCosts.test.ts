import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/fakeDb';
import { AdminController } from '../src/Controllers/AdminController';

/** AdminController::getDefaultCosts (PHP): the default LLM entries name the six providers, no more. */
test('the default costs list the same LLM providers as PHP', () => {
  const costs = (new AdminController() as any).getDefaultCosts();
  assert.deepEqual(costs.llm.map((c: any) => c.provider), ['claude', 'openai', 'gemini', 'grok', 'deepseek', 'kimi']);
});
