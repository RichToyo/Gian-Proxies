import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KimiAdaptiveRuntime, kimiRuntimeMode } from '../src/runtime/adaptive-runtime.js';
import { KimiConversationRuntime } from '../src/runtime/conversation-runtime.js';
import { KimiServerRuntime } from '../src/runtime/kimi-server.js';

test('only reviewed Kimi runtime generations select a wire protocol', () => {
  assert.equal(kimiRuntimeMode('2.3.3'), 'legacy');
  assert.equal(kimiRuntimeMode('2.2.0'), 'legacy');
  assert.equal(kimiRuntimeMode('2.6.2'), 'conversation');
  assert.throws(() => kimiRuntimeMode('2.6.3'), /no reviewed event protocol/);
  assert.throws(() => kimiRuntimeMode('2.3.999'), /no reviewed event protocol/);
  assert.throws(() => kimiRuntimeMode('2.6.2-beta.1'), /no reviewed event protocol/);
});

test('legacy and conversation modes keep their own subscription semantics', async t => {
  const oldStart = t.mock.method(KimiServerRuntime.prototype, 'start', async () => {});
  const oldSubscribe = t.mock.method(KimiServerRuntime.prototype, 'subscribe', async () => {});
  const oldStop = t.mock.method(KimiServerRuntime.prototype, 'stop', async () => {});
  const legacy = new KimiAdaptiveRuntime({ kimiBin: '/fixture', endpoint: { baseUrl: 'http://127.0.0.1:1', token: 'fixture' } });
  await legacy.start();
  await legacy.subscribe('s', { seq: 42 });
  assert.equal(legacy.mode, 'legacy');
  assert.deepEqual(oldSubscribe.mock.calls[0]!.arguments, ['s', { seq: 42 }]);
  await legacy.stop();
  assert.equal(oldStart.mock.callCount(), 1); assert.equal(oldStop.mock.callCount(), 1);

  const newStart = t.mock.method(KimiConversationRuntime.prototype, 'start', async () => {});
  const newSubscribe = t.mock.method(KimiConversationRuntime.prototype, 'subscribe', async () => {});
  const newStop = t.mock.method(KimiConversationRuntime.prototype, 'stop', async () => {});
  const current = new KimiAdaptiveRuntime({ kimiBin: '/fixture', endpoint: { baseUrl: 'http://127.0.0.1:1', token: 'fixture' }, mode: 'conversation' });
  await current.start();
  await current.subscribe('s', { seq: 42 });
  assert.equal(current.mode, 'conversation');
  assert.deepEqual(newSubscribe.mock.calls[0]!.arguments, ['s']);
  await current.stop();
  assert.equal(newStart.mock.callCount(), 1); assert.equal(newStop.mock.callCount(), 1);
});
