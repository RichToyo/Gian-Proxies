import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { KimiConversationRuntime } from '../src/runtime/conversation-runtime.js';
import { KimiServerSupervisor, type KimiServerSupervisorResult } from '../src/runtime/server-supervisor.js';
import { WsSocket } from '../src/runtime/ws.js';

class FakeSocket extends EventEmitter {
  status: 'open' | 'closed' = 'open';
  sent: Array<Record<string, unknown>> = [];
  sendText(text: string): void {
    const frame = JSON.parse(text) as Record<string, unknown>;
    this.sent.push(frame);
    if (frame.type === 'subscribe') queueMicrotask(() => {
      this.emit('message', JSON.stringify({ type: 'response', request_id: frame.request_id, code: 0 }));
      this.emit('message', JSON.stringify({ type: 'turns', session_id: frame.session_id, agent_id: 'main', turns: [], has_more: false }));
    });
    if (frame.type === 'unsubscribe') queueMicrotask(() => this.emit('message', JSON.stringify({ type: 'response', request_id: frame.request_id, code: 0 })));
  }
  close(): void { this.status = 'closed'; this.emit('close'); }
}

class ClosingSocket extends FakeSocket {
  override sendText(text: string): void {
    this.sent.push(JSON.parse(text) as Record<string, unknown>);
    queueMicrotask(() => { if (this.status === 'open') this.close(); });
  }
}

test('socket reconnect resubscribes without fabricated cursors and fences stale callbacks', async t => {
  const supervisor: KimiServerSupervisorResult = {
    endpoint: { baseUrl: 'http://127.0.0.1:1', token: 'fixture' }, pid: 1,
    exit: new Promise(() => {}), stop: async () => {},
  };
  t.mock.method(KimiServerSupervisor.prototype, 'start', async () => supervisor);
  const sockets = [new FakeSocket(), new FakeSocket()];
  let index = 0;
  t.mock.method(WsSocket, 'connect', async () => sockets[index++] as unknown as WsSocket);
  const runtime = new KimiConversationRuntime({ kimiBin: '/fixture/kimi' });
  const frames: Record<string, unknown>[] = [], resyncs: string[] = [];
  runtime.on('conversation-event', frame => frames.push(frame));
  runtime.on('resync', id => resyncs.push(id));
  try {
    await runtime.start(); await runtime.subscribe('s1');
    sockets[0]!.emit('message', JSON.stringify({ type: 'turns', session_id: 's1', agent_id: 'main', turns: [], has_more: false }));
    sockets[0]!.close();
    await delay(650);
    assert.deepEqual(resyncs, ['s1']);
    assert.deepEqual(sockets[1]!.sent[0], { type: 'subscribe', request_id: 'gian-1', session_id: 's1' });
    sockets[0]!.emit('message', JSON.stringify({ type: 'turns', session_id: 's1', agent_id: 'main', turns: ['stale'], has_more: false }));
    sockets[1]!.emit('message', JSON.stringify({ type: 'turns', session_id: 's1', agent_id: 'main', turns: [], has_more: false }));
    assert.equal(frames.length, 4);
  } finally { await runtime.stop(); }
});

test('concurrent starts share one native server process', async t => {
  let finish!: (value: KimiServerSupervisorResult) => void;
  const start = t.mock.method(KimiServerSupervisor.prototype, 'start', () => new Promise(resolve => { finish = resolve; }));
  const runtime = new KimiConversationRuntime({ kimiBin: '/fixture/kimi' });
  const one = runtime.start(), two = runtime.start();
  assert.equal(start.mock.callCount(), 1);
  finish({ endpoint: { baseUrl: 'http://127.0.0.1:1', token: 'fixture' }, pid: 123,
    exit: new Promise(() => {}), stop: async () => {} });
  await Promise.all([one, two]);
  assert.equal(runtime.serverPid, 123);
  await runtime.stop();
});

test('a closed socket retries only subscription before admitting a prompt', async t => {
  const supervisor: KimiServerSupervisorResult = { endpoint: { baseUrl: 'http://127.0.0.1:1', token: 'fixture' },
    pid: 1, exit: new Promise(() => {}), stop: async () => {} };
  t.mock.method(KimiServerSupervisor.prototype, 'start', async () => supervisor);
  const sockets = [new ClosingSocket(), new FakeSocket()];
  let index = 0;
  t.mock.method(WsSocket, 'connect', async () => sockets[index++] as unknown as WsSocket);
  const runtime = new KimiConversationRuntime({ kimiBin: '/fixture/kimi' });
  try {
    await runtime.start(); await runtime.subscribe('s1');
    assert.equal(index, 2);
    assert.deepEqual(sockets[1]!.sent[0], { type: 'subscribe', request_id: 'gian-1', session_id: 's1' });
  } finally { await runtime.stop(); }
});
