import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectConversationUsage } from '../src/runtime/conversation-usage.js';

test('native per-turn consumption includes cache in input and is not context occupancy', () => {
  assert.deepEqual(projectConversationUsage({ input_other: 8, input_cache_read: 3, input_cache_creation: 2, output: 4 }),
    { conversation: { mode: 'delta', inputTokens: 13, outputTokens: 4, cachedInputTokens: 3, totalTokens: 17 } });
  assert.equal(projectConversationUsage({ context_tokens: 500 }), null);
  assert.equal(projectConversationUsage({ input_other: 1, input_cache_read: 2, output: 4 }), null);
  assert.equal(projectConversationUsage({ input_other: Number.MAX_SAFE_INTEGER, input_cache_read: 3, input_cache_creation: 0, output: 4 }), null);
});
