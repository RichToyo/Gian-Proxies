import assert from 'node:assert/strict';
import test from 'node:test';

import { requestSessionKeys, SessionNotificationGate } from '../src/cli/notification-gate.js';

function recorder() {
  const written: string[] = [];
  const gate = new SessionNotificationGate((method, params) => {
    written.push(`${method}:${String(params.sessionId ?? '-')}`);
  });
  return { gate, written };
}

test('a held session queues its notifications until its request is answered; others stream', () => {
  const { gate, written } = recorder();
  const release = gate.hold(['a']);
  gate.emit('turn.started', { sessionId: 'a' });
  gate.emit('content.delta', { sessionId: 'b' });
  gate.emit('catalog.changed', {});
  gate.emit('content.delta', { sessionId: 'a' });
  assert.deepEqual(written, ['content.delta:b', 'catalog.changed:-']);
  release();
  assert.deepEqual(written, ['content.delta:b', 'catalog.changed:-', 'turn.started:a', 'content.delta:a']);
  release();
  gate.emit('turn.completed', { sessionId: 'a' });
  assert.deepEqual(written.at(-1), 'turn.completed:a');
});

test('overlapping requests on one session release only after the last is answered, in order', () => {
  const { gate, written } = recorder();
  const first = gate.hold(['a']);
  const second = gate.hold(['a']);
  gate.emit('one', { sessionId: 'a' });
  first();
  gate.emit('two', { sessionId: 'a' });
  assert.deepEqual(written, []);
  second();
  assert.deepEqual(written, ['one:a', 'two:a']);
});

test('flush writes a Side Chat teardown before its Response while keeping the hold', () => {
  const { gate, written } = recorder();
  const release = gate.hold(['side']);
  gate.emit('turn.completed', { sessionId: 'side' });
  gate.flush(['side']);
  assert.deepEqual(written, ['turn.completed:side']);
  gate.emit('late', { sessionId: 'side' });
  assert.deepEqual(written, ['turn.completed:side']);
  release();
  assert.deepEqual(written, ['turn.completed:side', 'late:side']);
});

test('request session keys cover sessions and Side Chats', () => {
  assert.deepEqual(requestSessionKeys({ sessionId: 's' }), ['s']);
  assert.deepEqual(requestSessionKeys({ sidechatId: 'c', parentSessionId: 'p' }), ['c']);
  assert.deepEqual(requestSessionKeys({ sessionId: '', cwd: '/x' }), []);
});
