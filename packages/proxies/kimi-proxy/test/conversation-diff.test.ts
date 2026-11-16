import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchConversationDiff } from '../src/runtime/conversation-diff.js';

test('2.6.2 file history uses native turn_number and start/end phases', async () => {
  const calls: Array<{ path: string; query: Record<string, string | number> }> = [];
  const result = await fetchConversationDiff(async (path, query) => {
    calls.push({ path, query });
    if (path.endsWith('/changes')) return { recorded: true, changes: [{ path: 'a.txt', status: 'modified' }] };
    return { content: { content: query.phase === 'start' ? 'before\n' : 'after\n' } };
  }, 's/1', 4);
  assert.deepEqual(calls.map(call => call.query), [
    { turn_number: 4 }, { turn_number: 4, path: 'a.txt', phase: 'start' }, { turn_number: 4, path: 'a.txt', phase: 'end' },
  ]);
  assert.ok(calls.every(call => call.path.startsWith('/api/v1/sessions/s%2F1/file-history/')));
  assert.equal(result?.truncated, false);
  assert.match(result?.diff ?? '', /before/);
  assert.match(result?.diff ?? '', /after/);
});

test('unrecorded checkpoint is unknown and missing content is truncated', async () => {
  assert.equal(await fetchConversationDiff(async () => ({ recorded: false, changes: [] }), 's', 0), null);
  const result = await fetchConversationDiff(async path => path.endsWith('/changes')
    ? { recorded: true, changes: [{ path: 'a', status: 'modified' }] } : { content: null }, 's', 1);
  assert.equal(result?.truncated, true);
  assert.equal(result?.diff, '');
});
