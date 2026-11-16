import assert from 'node:assert/strict';
import { test } from 'node:test';
import { proxyNotificationSchema } from '@gian/proxy-protocol';
import { KimiConversationTurn } from '../src/runtime/conversation-turn.js';

test('native turn binds its prompt, holds approval for the user, and waits for owned work', async () => {
  const events: Array<{ method: string; params: Record<string, unknown> }> = [];
  let sequence = 0, finalized = 0;
  const turn = new KimiConversationTurn({ sessionId: 's', nativeSessionId: 'native', streamId: 'stream',
    turnId: 'turn', promptId: 'prompt', nextSequence: () => ++sequence, emit: event => events.push(event),
    onFinalized: () => { finalized += 1; } });
  const f = (value: Record<string, unknown>) => ({ session_id: 'native', agent_id: 'main', event_created_at: '2026-11-16T12:00:00Z', ...value });
  turn.receive(f({ type: 'task.list', tasks: [] }));
  turn.receive(f({ type: 'interaction', status: 'pending', kind: 'approval', interaction_id: 'i1', tool_call_id: 'tool1',
    request: { tool_name: 'Bash', action: 'pwd', expires_at: '2026-11-16T12:10:00Z' } }));
  turn.receive(f({ type: 'turn.started', turn: { turn_id: 'native-turn', ordinal: 1 } }));
  turn.receive(f({ type: 'item.started', turn_id: 'native-turn', item: { type: 'user_message', item_id: 'user', placement: 'opener', prompt_ids: ['prompt'] } }));
  turn.receive(f({ type: 'item.started', turn_id: 'native-turn', item: { type: 'tool_call', item_id: 'tool1', name: 'Bash', status: 'running' } }));
  assert.deepEqual(events.map(event => event.method), ['interaction.requested', 'activity.updated']);
  turn.receive(f({ type: 'todo', items: [{ title: 'Inspect', status: 'in_progress' }] }));
  turn.receive(f({ type: 'usage', context_tokens: 12, max_context_tokens: 100 }));
  assert.deepEqual(events.slice(-2).map(event => event.method), ['plan.updated', 'usage.updated']);
  assert.deepEqual(turn.response('apr:i1', 'approved', {}), { path: '/api/v1/sessions/native/interactions/i1', json: { kind: 'approval', decision: 'approved' } });
  assert.equal(events.some(event => event.method === 'interaction.resolved'), false);
  turn.receive(f({ type: 'task', task_id: 'background', kind: 'subagent', status: 'running', parent_tool_call_id: 'tool1' }));
  turn.receive(f({ type: 'turn.ended', turn: { turn_id: 'native-turn', status: 'ended', outcome: 'completed' } }));
  turn.receive(f({ type: 'agent', status: 'idle' }));
  assert.equal(finalized, 0);
  assert.equal(turn.acknowledge('apr:i1', 'approved', '2026-11-16T12:00:01Z'), true);
  assert.equal(finalized, 0);
  turn.receive(f({ type: 'task', task_id: 'background', kind: 'subagent', status: 'ended', outcome: 'completed', parent_tool_call_id: 'tool1' }));
  turn.receive({ type: 'event.session.work_changed', session_id: 'native', payload: { busy: false, main_turn_active: false, pending_interaction: 'none' } });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(finalized, 1);
  assert.equal(events.at(-1)?.method, 'turn.completed');
  for (const event of events) proxyNotificationSchema.parse({ jsonrpc: '2.0', ...event });
});

test('external cancellation is not presented as an accepted local interrupt', async () => {
  const events: Array<{ method: string; params: Record<string, unknown> }> = [];
  const turn = new KimiConversationTurn({ sessionId: 's', nativeSessionId: 'native', streamId: 'stream', turnId: 'turn', promptId: 'p',
    nextSequence: () => 1, emit: event => events.push(event), onFinalized: () => {} });
  const f = (value: Record<string, unknown>) => ({ session_id: 'native', agent_id: 'main', event_created_at: '2026-11-16T12:00:00Z', ...value });
  turn.receive(f({ type: 'task.list', tasks: [] }));
  turn.receive(f({ type: 'turn.started', turn: { turn_id: 't1' } }));
  turn.receive(f({ type: 'item.started', turn_id: 't1', item: { type: 'user_message', item_id: 'u', placement: 'opener', prompt_ids: ['p'] } }));
  turn.receive(f({ type: 'turn.ended', turn: { turn_id: 't1', status: 'ended', outcome: 'interrupted' } }));
  turn.receive(f({ type: 'agent', status: 'idle' }));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((events.at(-1)?.params.data as Record<string, unknown>).stopReason, 'cancelled');
});

test('native terminal racing an accepted interrupt waits for the HTTP result', async () => {
  const events: Array<{ method: string; params: Record<string, unknown> }> = [];
  let finalized = 0;
  const turn = new KimiConversationTurn({ sessionId: 's', nativeSessionId: 'native', streamId: 'stream', turnId: 'turn', promptId: 'p',
    nextSequence: () => 1, emit: event => events.push(event), onFinalized: () => { finalized += 1; } });
  const f = (value: Record<string, unknown>) => ({ session_id: 'native', agent_id: 'main', event_created_at: '2026-11-16T12:00:00Z', ...value });
  turn.receive(f({ type: 'task.list', tasks: [] }));
  turn.receive(f({ type: 'turn.started', turn: { turn_id: 't1' } }));
  turn.receive(f({ type: 'item.started', turn_id: 't1', item: { type: 'user_message', item_id: 'u', placement: 'opener', prompt_ids: ['p'] } }));
  turn.beginInterrupt();
  turn.receive(f({ type: 'turn.ended', turn: { turn_id: 't1', status: 'ended', outcome: 'interrupted' } }));
  turn.receive(f({ type: 'agent', status: 'idle' }));
  assert.equal(finalized, 0);
  turn.finishInterrupt(true);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(finalized, 1);
  assert.equal((events.at(-1)?.params.data as Record<string, unknown>).stopReason, 'interrupted');
});

test('new background work during file-history lookup prevents premature completion', async () => {
  const events: Array<{ method: string; params: Record<string, unknown> }> = [];
  let completeDiff!: (value: { diff: string; truncated: boolean; files: Array<{ path: string; status: string }> }) => void;
  const diff = new Promise<{ diff: string; truncated: boolean; files: Array<{ path: string; status: string }> }>(resolve => { completeDiff = resolve; });
  let finalized = 0;
  const turn = new KimiConversationTurn({ sessionId: 's', nativeSessionId: 'native', streamId: 'stream', turnId: 'turn', promptId: 'p',
    nextSequence: () => 1, emit: event => events.push(event), onFinalized: () => { finalized += 1; }, fetchDiff: async () => diff });
  const f = (value: Record<string, unknown>) => ({ session_id: 'native', agent_id: 'main', event_created_at: '2026-11-16T12:00:00Z', ...value });
  turn.receive(f({ type: 'task.list', tasks: [] }));
  turn.receive(f({ type: 'turn.started', turn: { turn_id: 't1', turn_number: 7 } }));
  turn.receive(f({ type: 'item.started', turn_id: 't1', item: { type: 'user_message', item_id: 'u', placement: 'opener', prompt_ids: ['p'] } }));
  turn.receive(f({ type: 'turn.ended', turn: { turn_id: 't1', turn_number: 7, status: 'ended', outcome: 'completed' } }));
  turn.receive(f({ type: 'agent', status: 'idle' }));
  await new Promise(resolve => setTimeout(resolve, 20));
  turn.receive(f({ type: 'task', task_id: 'late', kind: 'other', status: 'running' }));
  completeDiff({ diff: 'patch', truncated: false, files: [{ path: 'a', status: 'modified' }] });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(finalized, 0);
  turn.receive(f({ type: 'task', task_id: 'late', kind: 'other', status: 'ended', outcome: 'completed' }));
  turn.receive({ type: 'event.session.work_changed', session_id: 'native', payload: { busy: false, main_turn_active: false, pending_interaction: 'none' } });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(finalized, 1);
  assert.deepEqual(events.map(event => event.method), ['diff.updated', 'turn.completed']);
  for (const event of events) proxyNotificationSchema.parse({ jsonrpc: '2.0', ...event });
});

test('a fenced runtime emits one failure and never a successful terminal', async () => {
  const events: Array<{ method: string; params: Record<string, unknown> }> = [];
  let finalized = 0, sequence = 0;
  const turn = new KimiConversationTurn({ sessionId: 's', nativeSessionId: 'native', streamId: 'stream', turnId: 'turn', promptId: 'p',
    nextSequence: () => ++sequence, emit: event => events.push(event), onFinalized: () => { finalized += 1; } });
  turn.fail('Native work could not be contained.', true);
  turn.fail('Another failure.', true);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(events.map(event => event.method), ['turn.failed']);
  assert.equal(finalized, 1);
  proxyNotificationSchema.parse({ jsonrpc: '2.0', ...events[0] });
});

test('native resolution racing the HTTP response preserves the explicit user action', () => {
  const events: Array<{ method: string; params: Record<string, unknown> }> = [];
  let sequence = 0;
  const turn = new KimiConversationTurn({ sessionId: 's', nativeSessionId: 'native', streamId: 'stream', turnId: 'turn', promptId: 'p',
    nextSequence: () => ++sequence, emit: event => events.push(event), onFinalized: () => {} });
  const f = (value: Record<string, unknown>) => ({ session_id: 'native', agent_id: 'main', event_created_at: '2026-11-16T12:00:00Z', ...value });
  turn.receive(f({ type: 'turn.started', turn: { turn_id: 't1' } }));
  turn.receive(f({ type: 'item.started', turn_id: 't1', item: { type: 'user_message', item_id: 'u', placement: 'opener', prompt_ids: ['p'] } }));
  turn.receive(f({ type: 'item.started', turn_id: 't1', item: { type: 'tool_call', item_id: 'tool', name: 'Bash', status: 'running' } }));
  const interaction = { type: 'interaction', kind: 'approval', interaction_id: 'i1', tool_call_id: 'tool',
    request: { tool_name: 'Bash', action: 'pwd', expires_at: '2026-11-16T12:10:00Z' } };
  turn.receive(f({ ...interaction, status: 'pending' }));
  turn.response('apr:i1', 'approved', {});
  turn.receive(f({ ...interaction, status: 'ended', outcome: 'approved' }));
  assert.equal(events.some(event => event.method === 'interaction.resolved'), false);
  turn.acknowledge('apr:i1', 'approved', '2026-11-16T12:00:01Z');
  const resolved = events.find(event => event.method === 'interaction.resolved');
  assert.deepEqual(resolved?.params.data, { interactionId: 'apr:i1', outcome: 'submitted', actionId: 'approved' });
  proxyNotificationSchema.parse({ jsonrpc: '2.0', ...resolved });
});

test('owned background notification and continuation remain on the admitted turn', async () => {
  const events: Array<{ method: string; params: Record<string, unknown> }> = [];
  let sequence = 0, finalized = 0;
  const turn = new KimiConversationTurn({ sessionId: 's', nativeSessionId: 'native', streamId: 'stream', turnId: 'gian-turn', promptId: 'p',
    nextSequence: () => ++sequence, emit: event => events.push(event), onFinalized: () => { finalized += 1; } });
  const f = (value: Record<string, unknown>) => ({ session_id: 'native', agent_id: 'main', event_created_at: '2026-11-16T12:00:00Z', ...value });
  const work = (busy: boolean) => ({ type: 'event.session.work_changed', session_id: 'native', payload: { busy, main_turn_active: busy, pending_interaction: 'none' } });
  turn.receive(f({ type: 'task.list', tasks: [] }));
  turn.receive(f({ type: 'turn.started', turn: { turn_id: 'primary', turn_number: 0 } }));
  turn.receive(f({ type: 'item.ended', turn_id: 'primary', item: { type: 'user_message', item_id: 'u', placement: 'opener', prompt_ids: ['p'] } }));
  turn.receive(f({ type: 'item.started', turn_id: 'primary', item: { type: 'tool_call', item_id: 'tool', name: 'Agent', status: 'running' } }));
  turn.receive(f({ type: 'task', task_id: 'bg', kind: 'subagent', status: 'running', parent_tool_call_id: 'tool' }));
  turn.receive(f({ type: 'turn.ended', turn: { turn_id: 'primary', turn_number: 0, status: 'ended', outcome: 'completed' } }));
  turn.receive(f({ type: 'agent', status: 'idle' }));
  turn.receive(f({ type: 'task', task_id: 'bg', kind: 'subagent', status: 'ended', outcome: 'completed', parent_tool_call_id: 'tool' }));
  turn.receive(work(true));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(finalized, 0);
  turn.receive(f({ type: 'turn.started', turn: { turn_id: 'continuation', turn_number: 1 } }));
  turn.receive(f({ type: 'item.ended', turn_id: 'continuation', item: { type: 'notification', item_id: 'notice', status: 'ended', outcome: 'completed',
    title: 'Background completed', body: 'Done', severity: 'info', task_id: 'bg', source: { kind: 'background_task', id: 'bg' } } }));
  turn.receive(f({ type: 'item.started', turn_id: 'continuation', item: { type: 'assistant_message', item_id: 'answer', status: 'running', text: 'Noted' } }));
  turn.receive(f({ type: 'item.ended', turn_id: 'continuation', item: { type: 'assistant_message', item_id: 'answer', status: 'ended', text: 'Noted' } }));
  turn.receive(f({ type: 'turn.ended', turn: { turn_id: 'continuation', turn_number: 1, status: 'ended', outcome: 'completed' } }));
  turn.receive(f({ type: 'agent', status: 'idle' }));
  turn.receive(work(false));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(finalized, 1);
  assert.equal(events.filter(event => event.method === 'turn.completed').length, 1);
  assert.ok(events.some(event => event.method === 'content.completed' && (event.params.data as Record<string, unknown>).content === 'Noted'));
  for (const event of events) proxyNotificationSchema.parse({ jsonrpc: '2.0', ...event });
});

test('reconnect snapshot resumes a running turn without resending its prompt', async () => {
  const events: Array<{ method: string; params: Record<string, unknown> }> = [];
  let sequence = 0, resynced = 0, finalized = 0;
  const turn = new KimiConversationTurn({ sessionId: 's', nativeSessionId: 'native', streamId: 'stream', turnId: 'gian-turn', promptId: 'p',
    nextSequence: () => ++sequence, emit: event => events.push(event), onFinalized: () => { finalized += 1; }, onResynced: () => { resynced += 1; } });
  const f = (value: Record<string, unknown>) => ({ session_id: 'native', agent_id: 'main', event_created_at: '2026-11-16T12:00:00Z', ...value });
  const opener = { type: 'user_message', item_id: 'u', status: 'ended', placement: 'opener', prompt_ids: ['p'] };
  turn.receive(f({ type: 'task.list', tasks: [] }));
  turn.receive(f({ type: 'turn.started', turn: { turn_id: 't1', turn_number: 1 } }));
  turn.receive(f({ type: 'item.ended', turn_id: 't1', item: opener }));
  turn.receive(f({ type: 'item.started', turn_id: 't1', item: { type: 'assistant_message', item_id: 'i', status: 'running', text: 'hello' } }));
  turn.disconnected();
  turn.receive(f({ type: 'task.list', tasks: [] }));
  turn.receive(f({ type: 'agent', status: 'running' }));
  turn.receive(f({ type: 'turns', has_more: false, turns: [{ turn_id: 't1', turn_number: 1, status: 'running',
    items: [opener, { type: 'assistant_message', item_id: 'i', status: 'running', text: 'hello world' }] }] }));
  assert.equal(resynced, 1);
  turn.receive(f({ type: 'item.ended', turn_id: 't1', item: { type: 'assistant_message', item_id: 'i', status: 'ended', text: 'hello world' } }));
  turn.receive(f({ type: 'turn.ended', turn: { turn_id: 't1', turn_number: 1, status: 'ended', outcome: 'completed' } }));
  turn.receive(f({ type: 'agent', status: 'idle' }));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(finalized, 1);
  assert.deepEqual(events.filter(event => event.method === 'content.delta').map(event => (event.params.data as Record<string, unknown>).delta), ['hello', ' world']);
});

test('reconnect snapshot restores an owned background continuation', async () => {
  const events: Array<{ method: string; params: Record<string, unknown> }> = [];
  let sequence = 0, resynced = 0, finalized = 0;
  const turn = new KimiConversationTurn({ sessionId: 's', nativeSessionId: 'native', streamId: 'stream', turnId: 'gian-turn', promptId: 'p',
    nextSequence: () => ++sequence, emit: event => events.push(event), onFinalized: () => { finalized += 1; }, onResynced: () => { resynced += 1; } });
  const f = (value: Record<string, unknown>) => ({ session_id: 'native', agent_id: 'main', event_created_at: '2026-11-16T12:00:00Z', ...value });
  const opener = { type: 'user_message', item_id: 'u', status: 'ended', placement: 'opener', prompt_ids: ['p'] };
  const tool = { type: 'tool_call', item_id: 'tool', name: 'Agent', status: 'ended', outcome: 'completed', task_id: 'bg' };
  const notice = { type: 'notification', item_id: 'n', status: 'ended', outcome: 'completed', title: 'Done', body: 'Finished',
    severity: 'info', task_id: 'bg', source: { kind: 'background_task', id: 'bg' } };
  turn.receive(f({ type: 'task.list', tasks: [] }));
  turn.receive(f({ type: 'turn.started', turn: { turn_id: 'primary', turn_number: 0 } }));
  turn.receive(f({ type: 'item.ended', turn_id: 'primary', item: opener }));
  turn.receive(f({ type: 'item.ended', turn_id: 'primary', item: tool }));
  turn.receive(f({ type: 'turn.ended', turn: { turn_id: 'primary', turn_number: 0, status: 'ended', outcome: 'completed' } }));
  turn.receive(f({ type: 'turn.started', turn: { turn_id: 'continuation', turn_number: 1 } }));
  turn.receive(f({ type: 'item.ended', turn_id: 'continuation', item: notice }));
  turn.receive(f({ type: 'item.started', turn_id: 'continuation', item: { type: 'assistant_message', item_id: 'i', status: 'running', text: 'Note' } }));
  turn.disconnected();
  turn.receive(f({ type: 'task.list', tasks: [] }));
  turn.receive(f({ type: 'agent', status: 'running' }));
  turn.receive(f({ type: 'turns', has_more: false, turns: [
    { turn_id: 'primary', turn_number: 0, status: 'ended', outcome: 'completed', items: [opener, tool] },
    { turn_id: 'continuation', turn_number: 1, status: 'running', items: [notice, { type: 'assistant_message', item_id: 'i', status: 'running', text: 'Noted' }] },
  ] }));
  assert.equal(resynced, 1);
  turn.receive(f({ type: 'item.ended', turn_id: 'continuation', item: { type: 'assistant_message', item_id: 'i', status: 'ended', text: 'Noted' } }));
  turn.receive(f({ type: 'turn.ended', turn: { turn_id: 'continuation', turn_number: 1, status: 'ended', outcome: 'completed' } }));
  turn.receive(f({ type: 'agent', status: 'idle' }));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(finalized, 1);
  assert.deepEqual(events.filter(event => event.method === 'content.delta').map(event => (event.params.data as Record<string, unknown>).delta), ['Note', 'd']);
});
