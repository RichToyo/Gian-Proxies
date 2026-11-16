import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KimiConversationState } from '../src/runtime/conversation-state.js';

// Event transitions follow the upstream conversationContract.e2e.test.ts replay reducer.
test('native snapshot and ordered updates reconstruct conversation and replace on reconnect', () => {
  const state = new KimiConversationState('s1', 'main');
  const frame = (event: Record<string, unknown>) => ({ session_id: 's1', agent_id: 'main', ...event });
  assert.equal(state.apply(frame({ type: 'turns', turns: [] })), 'applied');
  assert.equal(state.apply(frame({ type: 'turn.started', turn: { turn_id: 't1', ordinal: 1, steps: [] } })), 'applied');
  assert.equal(state.apply(frame({ type: 'item.started', turn_id: 't1', item: { item_id: 'i1', type: 'assistant_message', text: '' } })), 'applied');
  assert.equal(state.apply(frame({ type: 'item.delta', turn_id: 't1', item_id: 'i1', field: 'text', delta: 'hello' })), 'applied');
  assert.equal(state.apply(frame({ type: 'turn.updated', turn_id: 't1', step: { index: 1 }, retry: { attempt: 1 } })), 'applied');
  assert.deepEqual(state.snapshot(), [{ turn_id: 't1', ordinal: 1, steps: [{ index: 1 }], retry: { attempt: 1 }, items: [{ item_id: 'i1', type: 'assistant_message', text: 'hello' }] }]);
  assert.equal(state.apply(frame({ type: 'turns', turns: [{ turn_id: 't1', ordinal: 1, items: [{ item_id: 'i1', text: 'hello world' }] }] })), 'applied');
  assert.equal((state.snapshot()[0]?.items as Array<Record<string, unknown>>)[0]?.text, 'hello world');
  assert.equal(state.apply(frame({ type: 'turns.removed', turn_ids: ['t1'] })), 'applied');
  assert.deepEqual(state.snapshot(), []);
});

test('missing parents fence the stream until a new snapshot; foreign agents never mutate it', () => {
  const state = new KimiConversationState('s1', 'main');
  const frame = (event: Record<string, unknown>) => ({ session_id: 's1', agent_id: 'main', ...event });
  assert.equal(state.apply(frame({ type: 'turns', turns: [] })), 'applied');
  assert.equal(state.apply({ type: 'turns', session_id: 's1', agent_id: 'child', turns: [{ turn_id: 'foreign', items: [] }] }), 'ignored');
  assert.equal(state.apply(frame({ type: 'item.delta', turn_id: 'unknown', item_id: 'i1', field: 'text', delta: 'x' })), 'resync');
  assert.equal(state.apply(frame({ type: 'turn.started', turn: { turn_id: 't1', ordinal: 1 } })), 'resync');
  assert.equal(state.apply(frame({ type: 'turns', turns: [] })), 'applied');
  assert.deepEqual(state.snapshot(), []);
});
