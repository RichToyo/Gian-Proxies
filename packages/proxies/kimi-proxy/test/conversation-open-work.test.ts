import assert from 'node:assert/strict';
import { test } from 'node:test';
import { proxyNotificationSchema } from '@gian/proxy-protocol';
import { KimiConversationTurn } from '../src/runtime/conversation-turn.js';

// The Host's conformance rule (HostProtocolValidator.validateLifecycle): a
// turn terminal may not leave an activity that entered running, a running
// step or a content stream open. Violating it quarantines the turn.
function assertNothingOpenAtTerminal(events: Array<{ method: string; params: Record<string, unknown> }>): void {
  const activities = new Map<string, { running: boolean; status: string }>();
  const steps = new Map<string, { running: boolean; status: string }>();
  const content = new Map<string, boolean>();
  for (const event of events) {
    const data = (event.params.data ?? {}) as Record<string, unknown>;
    if (event.method === 'activity.updated') {
      const previous = activities.get(String(data.activityId));
      activities.set(String(data.activityId), { running: previous?.running === true || data.status === 'running', status: String(data.status) });
    } else if (event.method === 'step.updated') {
      const previous = steps.get(String(data.stepId));
      steps.set(String(data.stepId), { running: previous?.running === true || data.status === 'running', status: String(data.status) });
    } else if (event.method === 'content.delta') content.set(String(data.contentId), true);
    else if (event.method === 'content.completed') content.set(String(data.contentId), false);
    else if (event.method === 'turn.completed' || event.method === 'turn.failed') {
      const open = [
        ...[...activities].filter(([, a]) => a.running && !['succeeded', 'failed', 'cancelled'].includes(a.status)).map(([id]) => `activity ${id}`),
        ...[...steps].filter(([, s]) => s.running && !['completed', 'failed'].includes(s.status)).map(([id]) => `step ${id}`),
        ...[...content].filter(([, isOpen]) => isOpen).map(([id]) => `content ${id}`),
      ];
      assert.deepEqual(open, [], `${event.method} left work open`);
    }
  }
}

function harness() {
  const events: Array<{ method: string; params: Record<string, unknown> }> = [];
  let sequence = 0, finalized = 0;
  const turn = new KimiConversationTurn({ sessionId: 's', nativeSessionId: 'native', streamId: 'stream',
    turnId: 'turn', promptId: 'prompt', nextSequence: () => ++sequence, emit: event => events.push(event),
    onFinalized: () => { finalized += 1; } });
  const f = (value: Record<string, unknown>) => ({ session_id: 'native', agent_id: 'main', event_created_at: '2026-11-26T08:42:11Z', ...value });
  return { events, turn, f, finalized: () => finalized };
}

test('a background Bash task whose end was lost across a reconnect is closed before turn.completed', async () => {
  const { events, turn, f, finalized } = harness();
  turn.receive(f({ type: 'task.list', tasks: [] }));
  turn.receive(f({ type: 'turn.started', turn: { turn_id: 'native-turn', ordinal: 1 } }));
  turn.receive(f({ type: 'item.ended', turn_id: 'native-turn', item: { type: 'user_message', item_id: 'prompt', placement: 'opener', prompt_ids: ['prompt'] } }));
  turn.receive(f({ type: 'item.started', turn_id: 'native-turn', item: { type: 'tool_call', item_id: 'call1', name: 'Bash', status: 'running' } }));
  turn.receive(f({ type: 'task', task_id: 'bash-1', kind: 'shell', status: 'running', detached: true,
    description: 'Background sleep', parent_tool_call_id: 'call1', command: 'sleep 25', started_at: '2026-11-26T08:42:11Z' }));
  turn.receive(f({ type: 'item.ended', turn_id: 'native-turn', item: { type: 'tool_call', item_id: 'call1', name: 'Bash', status: 'ended', outcome: 'completed', output: 'Background task started' } }));
  turn.receive(f({ type: 'turn.ended', turn: { turn_id: 'native-turn', status: 'ended', outcome: 'completed' } }));
  turn.receive(f({ type: 'agent', status: 'idle' }));
  // The task's own `task … ended` frame was lost; after the reconnect Kimi
  // lists no running task any more.
  turn.receive(f({ type: 'task.list', tasks: [] }));
  turn.receive({ type: 'session', change: 'updated', session_id: 'native', session: { id: 'native', activity: 'idle', pending_interaction: 'none' } });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(finalized(), 1);
  assert.equal(events.at(-1)?.method, 'turn.completed');
  const task = events.filter(event => event.method === 'activity.updated'
    && String((event.params.data as { activityId?: string }).activityId).includes('bash-1'));
  assert.deepEqual(task.map(event => (event.params.data as { status?: string }).status), ['running', 'succeeded']);
  assertNothingOpenAtTerminal(events);
  for (const event of events) proxyNotificationSchema.parse({ jsonrpc: '2.0', ...event });
});

test('a fenced turn closes its streaming text, running tool and running task before turn.failed', () => {
  const { events, turn, f } = harness();
  turn.receive(f({ type: 'task.list', tasks: [] }));
  turn.receive(f({ type: 'turn.started', turn: { turn_id: 'native-turn', ordinal: 1 } }));
  turn.receive(f({ type: 'item.ended', turn_id: 'native-turn', item: { type: 'user_message', item_id: 'prompt', placement: 'opener', prompt_ids: ['prompt'] } }));
  turn.receive(f({ type: 'item.started', turn_id: 'native-turn', item: { type: 'assistant_message', item_id: 'msg:1', status: 'running', text: '' } }));
  turn.receive(f({ type: 'item.delta', turn_id: 'native-turn', item_id: 'msg:1', field: 'text', delta: 'Working on it' }));
  turn.receive(f({ type: 'item.started', turn_id: 'native-turn', item: { type: 'tool_call', item_id: 'call2', name: 'Bash', status: 'running' } }));
  turn.receive(f({ type: 'task', task_id: 'bash-2', kind: 'shell', status: 'running', description: 'Bash: sleep 60', parent_tool_call_id: 'call2', started_at: '2026-11-26T08:42:11Z' }));
  assert.ok(events.some(event => event.method === 'content.delta'));
  // A fence (feed reconciliation failure, interrupt watchdog, Host re-attach).
  turn.fail('The Kimi conversation feed could not be reconciled safely.', true);
  assert.equal(events.at(-1)?.method, 'turn.failed');
  assertNothingOpenAtTerminal(events);
  const closedTask = events.filter(event => event.method === 'activity.updated'
    && String((event.params.data as { activityId?: string }).activityId).includes('bash-2')).at(-1);
  assert.equal((closedTask?.params.data as { status?: string }).status, 'cancelled');
  assert.equal(((closedTask?.params.data as { presentation?: { data?: { state?: string } } }).presentation?.data?.state), 'interrupted');
  for (const event of events) proxyNotificationSchema.parse({ jsonrpc: '2.0', ...event });
});
