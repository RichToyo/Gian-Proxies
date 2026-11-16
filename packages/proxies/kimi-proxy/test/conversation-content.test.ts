import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KimiConversationContent } from '../src/runtime/conversation-content.js';
import { proxyNotificationSchema } from '@gian/proxy-protocol';

test('native text deltas and terminal item keep one content identity', () => {
  const output: Array<{ method: string; params: Record<string, unknown> }> = [];
  let sequence = 0;
  const content = new KimiConversationContent({ sessionId: 's', nativeSessionId: 'native', streamId: 'stream',
    turnId: 'turn', promptId: 'prompt', nextSequence: () => ++sequence, emit: event => output.push(event) });
  const event = (frame: Record<string, unknown>) => ({ event_created_at: '2026-11-16T12:00:00Z', ...frame });
  content.receive(event({ type: 'item.started', item: { type: 'assistant_message', item_id: 'i1', text: '' } }));
  content.receive(event({ type: 'item.delta', item_id: 'i1', field: 'text', delta: 'Hello ' }));
  content.receive(event({ type: 'item.delta', item_id: 'i1', field: 'text', delta: 'world' }));
  content.receive(event({ type: 'item.ended', item: { type: 'assistant_message', item_id: 'i1', status: 'ended', text: 'Hello world' } }));
  assert.deepEqual(output.map(event => event.method), ['content.delta', 'content.delta', 'content.completed']);
  assert.deepEqual(output.map(event => (event.params.data as Record<string, unknown>).contentId), ['kimi:prompt:i1', 'kimi:prompt:i1', 'kimi:prompt:i1']);
  assert.equal((output[2]!.params.data as Record<string, unknown>).content, 'Hello world');
  assert.deepEqual(output.map(event => event.params.sequence), [1, 2, 3]);
  for (const event of output) proxyNotificationSchema.parse({ jsonrpc: '2.0', ...event });
});

test('out-of-order or divergent native text fails closed', () => {
  const content = new KimiConversationContent({ sessionId: 's', nativeSessionId: 'native', streamId: 'stream',
    turnId: 'turn', promptId: 'prompt', nextSequence: () => 1, emit: () => {} });
  const event = (frame: Record<string, unknown>) => ({ event_created_at: '2026-11-16T12:00:00Z', ...frame });
  assert.throws(() => content.receive(event({ type: 'item.delta', item_id: 'i', field: 'text', delta: 'orphan' })), /no open item/);
  content.receive(event({ type: 'item.started', item: { type: 'reasoning', item_id: 'i', text: 'old' } }));
  assert.throws(() => content.receive(event({ type: 'item.ended', item: { type: 'reasoning', item_id: 'i', status: 'ended', text: 'different' } })), /differs/);
});

test('native terminal content corrections retain their identity and emit a new fact', () => {
  const output: Array<{ method: string; params: Record<string, unknown> }> = [];
  let sequence = 0;
  const content = new KimiConversationContent({ sessionId: 's', nativeSessionId: 'native', streamId: 'stream',
    turnId: 'turn', promptId: 'prompt', nextSequence: () => ++sequence, emit: event => output.push(event) });
  const event = (text: string) => ({ type: 'item.ended', event_created_at: '2026-11-16T12:00:00Z',
    item: { type: 'assistant_message', item_id: 'i', status: 'ended', text } });
  content.receive(event('first')); content.receive(event('first')); content.receive(event('corrected'));
  assert.equal(output.length, 2);
  assert.notEqual(output[0]!.params.eventId, output[1]!.params.eventId);
  assert.equal((output[1]!.params.data as Record<string, unknown>).content, 'corrected');
});

test('reconnect snapshot emits only missing text and rejects divergent history', () => {
  const output: Array<{ method: string; params: Record<string, unknown> }> = [];
  let sequence = 0;
  const content = new KimiConversationContent({ sessionId: 's', nativeSessionId: 'native', streamId: 'stream',
    turnId: 'turn', promptId: 'prompt', nextSequence: () => ++sequence, emit: event => output.push(event) });
  const time = '2026-11-16T12:00:00Z';
  content.receive({ type: 'item.started', event_created_at: time, item: { type: 'assistant_message', item_id: 'i', status: 'running', text: 'hello' } });
  content.hydrate({ type: 'assistant_message', item_id: 'i', status: 'running', text: 'hello world' }, time);
  assert.deepEqual(output.map(event => (event.params.data as Record<string, unknown>).delta), ['hello', ' world']);
  assert.throws(() => content.hydrate({ type: 'assistant_message', item_id: 'i', status: 'running', text: 'other' }, time), /differs/);
});
