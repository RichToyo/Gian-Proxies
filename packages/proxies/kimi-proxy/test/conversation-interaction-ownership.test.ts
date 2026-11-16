import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KimiInteractionOwnership } from '../src/runtime/conversation-interaction-ownership.js';

test('interaction snapshots wait for proven native tool ownership', () => {
  const seen: Record<string, unknown>[] = [];
  const ownership = new KimiInteractionOwnership('s1', frame => seen.push(frame));
  const pending = { type: 'interaction', session_id: 's1', agent_id: 'main', interaction_id: 'i1', kind: 'approval', status: 'pending', tool_call_id: 'tool1' };
  ownership.receive(pending);
  ownership.receive({ ...pending, interaction_id: 'foreign', tool_call_id: 'other' });
  assert.equal(ownership.hasUnbound(), true);
  assert.deepEqual(seen, []);
  ownership.associate('tool1');
  assert.deepEqual(seen, [pending]);
  assert.equal(ownership.hasUnbound(), true);
  ownership.receive({ ...pending, status: 'ended' });
  assert.equal(seen.length, 2);
});

test('item interaction identity binds questions without inventing a tool ID', () => {
  const seen: Record<string, unknown>[] = [];
  const ownership = new KimiInteractionOwnership('s1', frame => seen.push(frame));
  const pending = { type: 'interaction', session_id: 's1', agent_id: 'main', interaction_id: 'q1', kind: 'question', status: 'pending' };
  ownership.receive(pending);
  ownership.associate('native-tool', 'q1');
  assert.deepEqual(seen, [pending]);
  assert.equal(ownership.hasUnbound(), false);
  ownership.receive({ ...pending, session_id: 'other' });
  assert.equal(seen.length, 1);
});
