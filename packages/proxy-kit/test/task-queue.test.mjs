import assert from 'node:assert/strict';
import test from 'node:test';

import { createTaskQueue } from '../dist/index.js';

test('session tasks run strictly one at a time: the next starts only after the previous settles', async () => {
  const queue = createTaskQueue('test');
  const started = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  queue.enqueueSession(async () => { started.push('first'); await firstGate; });
  queue.enqueueSession(async () => { started.push('second'); });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ['first'],
    'the second session task must not start while the first is still in flight');
  releaseFirst();
  await queue.drain();
  assert.deepEqual(started, ['first', 'second'], 'the second session task must start once the first settles');
  assert.equal(queue.pendingCount(), 0);
});

test('pipelined tasks never wait on the session queue', async () => {
  const queue = createTaskQueue('test');
  const started = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  queue.enqueueSession(async () => { started.push('session'); await gate; });
  queue.enqueuePipelined(async () => { started.push('scan'); });
  assert.deepEqual(started, ['scan'], 'a pipelined task must not wait for the session queue');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ['scan', 'session'], 'the session task must start once the lock settles');
  release();
  await queue.drain();
});

test('a rejecting task never triggers process unhandledRejection, is dropped from in-flight, and does not poison the queue', async () => {
  const unhandled = [];
  const onUnhandled = (reason) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    const queue = createTaskQueue('test');
    queue.enqueueSession(async () => { throw new Error('writer exploded'); });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, [], 'the rejecting task must not surface as an unhandled rejection');
    assert.equal(queue.pendingCount(), 0, 'the rejecting task must be removed from the in-flight set');
    let ran = false;
    queue.enqueueSession(async () => { ran = true; });
    await queue.drain();
    assert.equal(ran, true, 'a later task must still run after a rejected one');
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }
});

test('drain settles only after every tracked task (including pipelined ones) has settled', async () => {
  const queue = createTaskQueue('test');
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  queue.enqueuePipelined(() => gate);
  let drained = false;
  const drain = queue.drain().then(() => { drained = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(drained, false, 'drain must wait for in-flight pipelined work');
  release();
  await drain;
  assert.equal(queue.pendingCount(), 0);
});

test('distinct session lanes run concurrently while one lane stays serialized', async () => {
  const queue = createTaskQueue('test');
  const started = [];
  let releaseA;
  const gateA = new Promise((resolve) => { releaseA = resolve; });
  queue.enqueueSession(async () => { started.push('a1'); await gateA; }, 'a');
  queue.enqueueSession(async () => { started.push('a2'); }, 'a');
  queue.enqueueSession(async () => { started.push('b1'); }, 'b');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ['a1', 'b1'], 'lane b must not wait for lane a');
  releaseA();
  await queue.drain();
  assert.deepEqual(started, ['a1', 'b1', 'a2']);
});

test('a barrier waits for in-flight work and holds back everything enqueued after it', async () => {
  const queue = createTaskQueue('test');
  const order = [];
  let releaseEarly;
  const early = new Promise((resolve) => { releaseEarly = resolve; });
  queue.enqueuePipelined(async () => { await early; order.push('early'); });
  let releaseBarrier;
  const barrierGate = new Promise((resolve) => { releaseBarrier = resolve; });
  queue.enqueueBarrier(async () => { order.push('barrier:start'); await barrierGate; order.push('barrier:end'); });
  queue.enqueueSession(async () => { order.push('session'); }, 's');
  queue.enqueuePipelined(async () => { order.push('pipelined'); });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, [], 'the barrier must wait for earlier in-flight work');
  releaseEarly();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['early', 'barrier:start'], 'later work must wait for the barrier');
  releaseBarrier();
  await queue.drain();
  // Both held-back tasks start only after the barrier; a session task and a
  // pipelined task have no order between themselves.
  assert.deepEqual(order.slice(0, 3), ['early', 'barrier:start', 'barrier:end']);
  assert.deepEqual([...order.slice(3)].sort(), ['pipelined', 'session']);
});
