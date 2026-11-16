import assert from 'node:assert/strict';
import { test } from 'node:test';
import { proxyNotificationSchema } from '@gian/proxy-protocol';
import { KimiConversationTasks } from '../src/runtime/conversation-tasks.js';

test('background tasks project only after their parent tool is owned', () => {
  const events: Array<{ method: string; params: Record<string, unknown> }> = [];
  let sequence = 0;
  const tasks = new KimiConversationTasks({ sessionId: 's', nativeSessionId: 'native', streamId: 'stream', turnId: 't', promptId: 'p',
    nextSequence: () => ++sequence, emit: event => events.push(event) });
  const frame = { type: 'task', session_id: 'native', agent_id: 'main', event_created_at: '2026-11-16T12:00:00Z',
    task_id: 'task1', kind: 'subagent', status: 'running', parent_tool_call_id: 'tool1', child_agent_id: 'child' };
  tasks.receive(frame);
  assert.equal(events.length, 0);
  tasks.associateTool('tool1');
  tasks.receive({ ...frame, status: 'ended', outcome: 'completed' });
  assert.deepEqual(events.map(event => (event.params.data as Record<string, unknown>).status), ['running', 'succeeded']);
  for (const event of events) proxyNotificationSchema.parse({ jsonrpc: '2.0', ...event });
});
