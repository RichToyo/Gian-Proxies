import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KimiConversationSettlement } from '../src/runtime/conversation-settlement.js';

test('turn terminal waits for native idle, task completion and interaction settlement', () => {
  const state = new KimiConversationSettlement('s1');
  const frame = (value: Record<string, unknown>) => ({ session_id: 's1', agent_id: 'main', ...value });
  state.receive(frame({ type: 'task.list', tasks: [] }));
  state.turnStarted();
  state.receive(frame({ type: 'task', task_id: 'bg', status: 'running', detached: true }));
  state.turnFinished();
  state.receive(frame({ type: 'agent', status: 'idle' }));
  assert.equal(state.canFinish(false), false);
  state.receive(frame({ type: 'task', task_id: 'bg', status: 'ended', outcome: 'completed' }));
  assert.equal(state.canFinish(true), false);
  assert.equal(state.canFinish(false), false);
  state.receive({ type: 'event.session.work_changed', session_id: 's1', payload: { busy: false, main_turn_active: false, pending_interaction: 'none' } });
  assert.equal(state.canFinish(false), true);
});

test('disconnect discards stale completion evidence and requires new native facts', () => {
  const state = new KimiConversationSettlement('s1');
  const frame = (value: Record<string, unknown>) => ({ session_id: 's1', agent_id: 'main', ...value });
  state.receive(frame({ type: 'task.list', tasks: [] }));
  state.receive(frame({ type: 'agent', status: 'idle' }));
  state.turnFinished();
  assert.equal(state.canFinish(false), true);
  state.disconnected();
  assert.equal(state.canFinish(false), false);
  state.receive({ ...frame({ type: 'task.list', tasks: [] }), agent_id: 'other' });
  state.receive(frame({ type: 'agent', status: 'idle' }));
  state.turnFinished();
  assert.equal(state.canFinish(false), false);
  state.receive(frame({ type: 'task.list', tasks: [] }));
  assert.equal(state.canFinish(false), true);
});
