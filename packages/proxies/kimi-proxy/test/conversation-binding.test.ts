import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KimiConversationBinding } from '../src/runtime/conversation-binding.js';

test('fast events wait for the native opener and exclude another prompt', () => {
  const delivered: Record<string, unknown>[] = [];
  const binding = new KimiConversationBinding('s1', 'our-prompt', frame => delivered.push(frame));
  const frame = (value: Record<string, unknown>) => ({ session_id: 's1', agent_id: 'main', ...value });
  binding.receive(frame({ type: 'turn.started', turn: { turn_id: 'other', ordinal: 1 } }));
  binding.receive(frame({ type: 'item.started', turn_id: 'other', item: { type: 'user_message', placement: 'opener', prompt_ids: ['other-prompt'] } }));
  binding.receive(frame({ type: 'turn.started', turn: { turn_id: 'ours', ordinal: 2 } }));
  assert.equal(delivered.length, 0);
  binding.receive(frame({ type: 'item.started', turn_id: 'ours', item: { type: 'user_message', placement: 'opener', prompt_ids: ['our-prompt'] } }));
  binding.receive(frame({ type: 'item.delta', turn_id: 'ours', item_id: 'text', field: 'text', delta: 'hello' }));
  binding.receive(frame({ type: 'turn.ended', turn: { turn_id: 'other', ordinal: 1 } }));
  assert.deepEqual(delivered.map(value => value.type), ['turn.started', 'item.started', 'item.delta']);
});

test('a reconnect binds only the matching native snapshot and rejects ambiguous ownership', () => {
  const delivered: Record<string, unknown>[] = [];
  const binding = new KimiConversationBinding('s1', 'p1', frame => delivered.push(frame));
  const turn = (turn_id: string) => ({ turn_id, items: [{ type: 'user_message', placement: 'opener', prompt_ids: ['p1'] }] });
  assert.throws(() => binding.receive({ type: 'turns', session_id: 's1', agent_id: 'main', turns: [turn('t1'), turn('t2')] }), /multiple/);
  binding.receive({ type: 'turns', session_id: 's1', agent_id: 'main', turns: [turn('t1')] });
  binding.receive({ type: 'turn.ended', session_id: 's1', agent_id: 'main', turn: { turn_id: 't1' } });
  assert.deepEqual(delivered.map(value => value.type), ['turns', 'turn.ended']);
});

test('background continuation waits for matching owned native task', () => {
  const delivered: Record<string, unknown>[] = [];
  const owned = new Set<string>();
  const binding = new KimiConversationBinding('s1', 'p1', frame => delivered.push(frame), id => owned.has(id));
  const f = (value: Record<string, unknown>) => ({ session_id: 's1', agent_id: 'main', ...value });
  binding.receive(f({ type: 'turn.started', turn: { turn_id: 'primary' } }));
  binding.receive(f({ type: 'item.ended', turn_id: 'primary', item: { type: 'user_message', placement: 'opener', prompt_ids: ['p1'] } }));
  binding.receive(f({ type: 'turn.started', turn: { turn_id: 'continuation' } }));
  binding.receive(f({ type: 'item.ended', turn_id: 'continuation', item: { type: 'notification', task_id: 'task1', source: { kind: 'background_task', id: 'task1' } } }));
  assert.equal(binding.hasUnbound(), true);
  assert.equal(delivered.length, 2);
  owned.add('task1'); binding.associateTask('task1');
  assert.equal(binding.hasUnbound(), false);
  assert.deepEqual(delivered.map(frame => frame.type), ['turn.started', 'item.ended', 'turn.started', 'item.ended']);
});

test('unidentified concurrent turns are not discarded when the prompt binds', () => {
  const binding = new KimiConversationBinding('s1', 'p1', () => {});
  const f = (value: Record<string, unknown>) => ({ session_id: 's1', agent_id: 'main', ...value });
  binding.receive(f({ type: 'turn.started', turn: { turn_id: 'unknown' } }));
  binding.receive(f({ type: 'turn.started', turn: { turn_id: 'ours' } }));
  binding.receive(f({ type: 'item.ended', turn_id: 'ours', item: { type: 'user_message', placement: 'opener', prompt_ids: ['p1'] } }));
  assert.equal(binding.hasUnbound(), true);
  binding.receive(f({ type: 'item.ended', turn_id: 'unknown', item: { type: 'user_message', placement: 'opener', prompt_ids: ['other'] } }));
  assert.equal(binding.hasUnbound(), false);
});
