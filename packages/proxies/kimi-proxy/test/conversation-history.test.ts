import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchConversationHistory } from '../src/runtime/conversation-history.js';

// The 2.6.2 routes/conversation.ts contract specifies oldest-first pages and
// before_ordinal, with a maximum page size of 200 and a 1 MiB page budget.
test('history follows native cursors and returns all turns chronologically', async () => {
  const calls: Array<{ path: string; query: Record<string, number> }> = [];
  const turns = await fetchConversationHistory(async (path, query) => {
    calls.push({ path, query });
    return calls.length === 1
      ? { turns: [{ turn_id: 't3', ordinal: 3, items: [] }, { turn_id: 't4', ordinal: 4, items: [] }], has_more: true }
      : { turns: [{ turn_id: 't1', ordinal: 1, items: [] }, { turn_id: 't2', ordinal: 2, items: [] }], has_more: false };
  }, 'session/1');
  assert.deepEqual(turns.map(turn => turn.turn_id), ['t1', 't2', 't3', 't4']);
  assert.deepEqual(calls, [
    { path: '/api/v1/sessions/session%2F1/agents/main/turns', query: { page_size: 200 } },
    { path: '/api/v1/sessions/session%2F1/agents/main/turns', query: { page_size: 200, before_ordinal: 3 } },
  ]);
});

test('history rejects non-advancing or overlapping pages', async () => {
  await assert.rejects(fetchConversationHistory(async () => ({ turns: [], has_more: true }), 's'), /cannot advance/);
  let count = 0;
  await assert.rejects(fetchConversationHistory(async () => {
    count += 1;
    return { turns: [{ turn_id: 't1', ordinal: 1, items: [] }], has_more: count === 1 };
  }, 's'), /order or identity/);
});
