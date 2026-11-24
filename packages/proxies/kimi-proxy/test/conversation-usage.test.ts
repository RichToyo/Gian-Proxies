import assert from 'node:assert/strict';
import { test } from 'node:test';
import { conversationUsageEventSource, sumConversationUsage } from '../src/runtime/conversation-usage.js';

test('native per-turn consumption includes cache in input and is not context occupancy', () => {
  assert.deepEqual(sumConversationUsage([{ input_other: 8, input_cache_read: 3, input_cache_creation: 2, output: 4 }]),
    { conversation: { mode: 'delta', inputTokens: 13, outputTokens: 4, cachedInputTokens: 3, totalTokens: 17 } });
  assert.equal(sumConversationUsage([{ context_tokens: 500 }]), null);
  assert.equal(sumConversationUsage([{ input_other: 1, input_cache_read: 2, output: 4 }]), null);
  assert.equal(sumConversationUsage([]), null);
  assert.equal(sumConversationUsage([{ input_other: Number.MAX_SAFE_INTEGER, input_cache_read: 3, input_cache_creation: 0, output: 4 }]), null);
});

test('a Gian turn spanning background continuations reports one summed delta', () => {
  const usage = sumConversationUsage([
    { input_other: 8, input_cache_read: 3, input_cache_creation: 2, output: 4 },
    undefined,
    { input_other: 1, input_cache_read: 10, input_cache_creation: 0, output: 6 },
  ]);
  assert.deepEqual(usage, { conversation: { mode: 'delta', inputTokens: 24, outputTokens: 10, cachedInputTokens: 13, totalTokens: 34 } });
  // Live and replay derive the same identity regardless of turn order.
  assert.deepEqual(conversationUsageEventSource(['t2', 't1'], usage!), conversationUsageEventSource(['t1', 't2'], usage!));
});
