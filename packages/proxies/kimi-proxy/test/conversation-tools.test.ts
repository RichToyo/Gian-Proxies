import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KimiConversationTools } from '../src/runtime/conversation-tools.js';
import { proxyNotificationSchema } from '@gian/proxy-protocol';

test('native tool lifecycle projects updates and associates permission without answering', () => {
  const events: Array<{ method: string; params: Record<string, unknown> }> = [];
  const bindings: Array<[string, string | undefined]> = [];
  let sequence = 0;
  const tools = new KimiConversationTools({ sessionId: 's', nativeSessionId: 'native', streamId: 'stream',
    turnId: 'turn', promptId: 'prompt', nextSequence: () => ++sequence, emit: event => events.push(event),
    associateInteraction: (tool, interaction) => bindings.push([tool, interaction]) });
  const frame = (value: Record<string, unknown>) => ({ event_created_at: '2026-11-16T12:00:00Z', ...value });
  const started = { type: 'tool_call', item_id: 'tool1', name: 'Bash', status: 'running', input: { command: 'pwd' } };
  tools.receive(frame({ type: 'item.started', item: started }));
  tools.receive(frame({ type: 'item.updated', item_id: 'tool1', set: { stage: 'awaiting_approval', interaction_id: 'i1' } }));
  tools.receive(frame({ type: 'item.delta', item_id: 'tool1', field: 'output', delta: '/work' }));
  tools.receive(frame({ type: 'item.delta', item_id: 'tool1', field: 'output', delta: 'space' }));
  tools.receive(frame({ type: 'item.ended', item: { ...started, status: 'ended', outcome: 'completed', output: '/workspace' } }));
  assert.deepEqual(events.map(event => (event.params.data as Record<string, unknown>).status), ['running', 'running', 'running', 'succeeded']);
  for (const event of events) proxyNotificationSchema.parse({ jsonrpc: '2.0', ...event });
  assert.ok(bindings.some(([tool, interaction]) => tool === 'tool1' && interaction === 'i1'));
  assert.throws(() => tools.receive(frame({ type: 'item.updated', item_id: 'missing', set: {} })), /no known item/);
});
