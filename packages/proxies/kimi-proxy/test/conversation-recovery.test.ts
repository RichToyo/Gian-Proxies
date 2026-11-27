import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { proxyNotificationSchema } from '@gian/proxy-protocol';
import { KimiProxyService } from '../src/core/service.js';
import { KimiConversationBinding } from '../src/runtime/conversation-binding.js';
import { KimiServerRestClient, type RestRequestOptions } from '../src/runtime/rest-client.js';
import { WsSocket } from '../src/runtime/ws.js';

// Regressions found by the real Kimi Code 2.7.2 smoke run: a Host re-attach
// of a session whose turn it abandoned, and a steer that Kimi runs as the
// next native turn.

class FakeSocket extends EventEmitter {
  status: 'open' | 'closed' = 'open';
  sendText(text: string): void {
    const frame = JSON.parse(text) as Record<string, unknown>;
    if (frame.type === 'subscribe') queueMicrotask(() => {
      this.emit('message', JSON.stringify({ type: 'response', request_id: frame.request_id, code: 0 }));
      this.frame({ type: 'task.list', tasks: [] });
      this.frame({ type: 'agent', status: 'idle' });
      this.frame({ type: 'turns', turns: [], has_more: false });
    });
    if (frame.type === 'unsubscribe') queueMicrotask(() => this.emit('message', JSON.stringify({ type: 'response', request_id: frame.request_id, code: 0 })));
  }
  frame(value: Record<string, unknown>): void {
    this.emit('message', JSON.stringify({ session_id: 'native', agent_id: 'main', event_created_at: '2026-11-25T08:00:00Z', ...value }));
  }
  close(): void { this.status = 'closed'; this.emit('close'); }
}

const settle = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));

function completeTurn(socket: FakeSocket, nativeTurn: string, promptId: string, text: string): void {
  socket.frame({ type: 'turn.started', turn: { turn_id: nativeTurn } });
  socket.frame({ type: 'item.started', turn_id: nativeTurn, item: { type: 'user_message', item_id: promptId, placement: 'opener', prompt_ids: [promptId] } });
  socket.frame({ type: 'item.started', turn_id: nativeTurn, item: { type: 'assistant_message', item_id: `${nativeTurn}:1`, status: 'running', text } });
  socket.frame({ type: 'item.ended', turn_id: nativeTurn, item: { type: 'assistant_message', item_id: `${nativeTurn}:1`, status: 'ended', text } });
  socket.frame({ type: 'turn.ended', turn: { turn_id: nativeTurn, status: 'ended', outcome: 'completed' } });
  socket.frame({ type: 'agent', status: 'idle' });
}

test('a Host re-attach stops the turn it abandoned instead of refusing, and the session continues', async t => {
  const socket = new FakeSocket();
  t.mock.method(WsSocket, 'connect', async () => socket as unknown as WsSocket);
  const aborted: string[] = [];
  let running = false;
  let prompts = 0;
  t.mock.method(KimiServerRestClient.prototype, 'request', async function <T>(method: string, path: string, options: RestRequestOptions = {}): Promise<T> {
    if (path === '/api/v1/sessions' && method === 'POST') return { id: 'native' } as T;
    if (path === '/api/v1/sessions/native' && method === 'GET') return { id: 'native', activity: running ? 'turn' : 'idle' } as T;
    if (path.endsWith('/prompts') && method === 'POST') {
      const promptId = (options.json as { prompt_id: string }).prompt_id;
      prompts += 1;
      if (prompts === 1) {
        // A turn that never ends by itself (e.g. waiting for a question nobody answers).
        running = true;
        socket.frame({ type: 'turn.started', turn: { turn_id: 'stuck' } });
        socket.frame({ type: 'item.started', turn_id: 'stuck', item: { type: 'user_message', item_id: promptId, placement: 'opener', prompt_ids: [promptId] } });
      } else {
        queueMicrotask(() => completeTurn(socket, 'next', promptId, 'continued'));
      }
      return { prompt_id: promptId, status: 'running' } as T;
    }
    if (path.endsWith(':abort') && method === 'POST') {
      aborted.push(path);
      running = false;
      socket.frame({ type: 'turn.ended', turn: { turn_id: 'stuck', status: 'ended', outcome: 'interrupted' } });
      return { aborted: true } as T;
    }
    if (path.endsWith('/file-history/changes')) return { recorded: false, changes: [] } as T;
    throw new Error(`Unexpected fixture request: ${method} ${path}`);
  });
  const service = new KimiProxyService({ kimiBin: '/fixture', endpoint: { baseUrl: 'http://127.0.0.1:1', token: 'fixture' } });
  const events: Array<{ method: string; params: Record<string, unknown> }> = [];
  service.setEmitSink(event => events.push(event));
  try {
    const { snapshot } = await service.createSession({ sessionId: 's', cwd: '/workspace' });
    await service.startTurn({ sessionId: 's', streamId: snapshot.streamId as string, turnId: 't1', input: [{ type: 'text', text: 'ask me' }], config: {} });
    await settle();
    // The Host's recovery: it stops following t1 and brings the session up again.
    const before = events.length;
    const again = await service.createSession({ sessionId: 's', cwd: '/workspace', nativeSessionId: 'native' });
    assert.notEqual(again.snapshot.streamId, snapshot.streamId);
    assert.equal(aborted.length, 1, 'the abandoned native prompt was aborted');
    // The Host validates every later event against the new stream and faults
    // the session on an old-stream event: nothing is sent on the old stream.
    // Stopping the abandoned turn (its fence, its session state) sends nothing
    // at all: the Host knows only the stream this re-attach returns, and an
    // event on it before that would carry the old stream's sequence.
    assert.deepEqual(events.slice(before).map(event => event.method), [], 'nothing is sent while the abandoned turn is stopped');
    await service.startTurn({ sessionId: 's', streamId: again.snapshot.streamId as string, turnId: 't2', input: [{ type: 'text', text: 'go on' }], config: {} });
    await settle();
    const later = events.slice(before);
    assert.ok(later.some(event => event.method === 'turn.completed' && event.params.turnId === 't2'));
    assert.ok(later.every(event => event.params.streamId === again.snapshot.streamId), 'everything after the re-attach is on the new stream');
    assert.deepEqual(later.map(event => event.params.sequence), later.map((_, index) => index + 1), 'the new stream runs 1, 2, 3, … without a gap');
    for (const event of events) proxyNotificationSchema.parse({ jsonrpc: '2.0', ...event });
  } finally { await service.shutdown(); }
});

test('a re-attach still refuses while Kimi runs work that is not this session\'s turn', async t => {
  const socket = new FakeSocket();
  t.mock.method(WsSocket, 'connect', async () => socket as unknown as WsSocket);
  t.mock.method(KimiServerRestClient.prototype, 'request', async function <T>(method: string, path: string): Promise<T> {
    if (path === '/api/v1/sessions' && method === 'POST') return { id: 'native' } as T;
    if (path === '/api/v1/sessions/native' && method === 'GET') return { id: 'native', activity: 'background' } as T;
    throw new Error(`Unexpected fixture request: ${method} ${path}`);
  });
  const service = new KimiProxyService({ kimiBin: '/fixture', endpoint: { baseUrl: 'http://127.0.0.1:1', token: 'fixture' }, rebindIdleWaitMs: 300 });
  try {
    await service.createSession({ sessionId: 's', cwd: '/workspace' });
    await assert.rejects(service.createSession({ sessionId: 's', cwd: '/workspace', nativeSessionId: 'native' }),
      (error: Error & { domainCode?: string }) => error.domainCode === 'SESSION_BUSY');
  } finally { await service.shutdown(); }
});

test('a steer Kimi runs as the next native turn stays in the same Gian turn', async t => {
  const socket = new FakeSocket();
  t.mock.method(WsSocket, 'connect', async () => socket as unknown as WsSocket);
  let mainPrompt = '';
  t.mock.method(KimiServerRestClient.prototype, 'request', async function <T>(method: string, path: string, options: RestRequestOptions = {}): Promise<T> {
    if (path === '/api/v1/sessions' && method === 'POST') return { id: 'native' } as T;
    if (path.endsWith('/prompts') && method === 'POST') {
      const promptId = (options.json as { prompt_id: string }).prompt_id;
      if (!mainPrompt) {
        mainPrompt = promptId;
        socket.frame({ type: 'turn.started', turn: { turn_id: 'first' } });
        socket.frame({ type: 'item.started', turn_id: 'first', item: { type: 'user_message', item_id: promptId, placement: 'opener', prompt_ids: [promptId] } });
        return { prompt_id: promptId, status: 'running' } as T;
      }
      return { prompt_id: promptId, status: 'queued' } as T;
    }
    if (path.endsWith('/prompts:steer') && method === 'POST') {
      const [steerId] = (options.json as { prompt_ids: string[] }).prompt_ids;
      queueMicrotask(() => {
        // Kimi ends the running turn at its step boundary without an answer…
        socket.frame({ type: 'turn.ended', turn: { turn_id: 'first', status: 'ended', outcome: 'completed' } });
        socket.frame({ type: 'agent', status: 'idle' });
        // …and runs the steer as the next native turn.
        completeTurn(socket, 'second', steerId!, 'FIRST SECOND');
      });
      return { steered: true } as T;
    }
    if (path.endsWith('/file-history/changes')) return { recorded: false, changes: [] } as T;
    throw new Error(`Unexpected fixture request: ${method} ${path}`);
  });
  const service = new KimiProxyService({ kimiBin: '/fixture', endpoint: { baseUrl: 'http://127.0.0.1:1', token: 'fixture' } });
  const events: Array<{ method: string; params: Record<string, unknown> }> = [];
  service.setEmitSink(event => events.push(event));
  try {
    const { snapshot } = await service.createSession({ sessionId: 's', cwd: '/workspace' });
    const stream = snapshot.streamId as string;
    await service.startTurn({ sessionId: 's', streamId: stream, turnId: 't1', input: [{ type: 'text', text: 'say FIRST' }], config: {} });
    await settle();
    await service.steerTurn({ sessionId: 's', streamId: stream, turnId: 't1', input: [{ type: 'text', text: 'and SECOND' }] });
    await settle(60);
    const text = events.filter(event => event.method === 'content.delta' && event.params.turnId === 't1')
      .map(event => String((event.params.data as { delta?: string }).delta ?? '')).join('');
    assert.equal(text, 'FIRST SECOND', 'the steered reply belongs to the Gian turn');
    assert.equal(events.filter(event => event.method === 'turn.completed' && event.params.turnId === 't1').length, 1);
    assert.equal(service.describeSession('s').state, 'idle');
  } finally { await service.shutdown(); }
});

test('the binding claims a native turn opened by a registered steer and still excludes unknown prompts', () => {
  const delivered: Record<string, unknown>[] = [];
  const binding = new KimiConversationBinding('s1', 'p1', frame => delivered.push(frame));
  const f = (value: Record<string, unknown>) => ({ session_id: 's1', agent_id: 'main', ...value });
  binding.receive(f({ type: 'turn.started', turn: { turn_id: 'first' } }));
  binding.receive(f({ type: 'item.started', turn_id: 'first', item: { type: 'user_message', placement: 'opener', prompt_ids: ['p1'] } }));
  binding.addSteerPrompt('steer1');
  binding.receive(f({ type: 'turn.started', turn: { turn_id: 'second' } }));
  binding.receive(f({ type: 'item.started', turn_id: 'second', item: { type: 'user_message', placement: 'opener', prompt_ids: ['steer1'] } }));
  binding.receive(f({ type: 'item.delta', turn_id: 'second', item_id: 'x', field: 'text', delta: 'hi' }));
  binding.receive(f({ type: 'turn.started', turn: { turn_id: 'foreign' } }));
  binding.receive(f({ type: 'item.started', turn_id: 'foreign', item: { type: 'user_message', placement: 'opener', prompt_ids: ['someone-else'] } }));
  binding.receive(f({ type: 'item.delta', turn_id: 'foreign', item_id: 'y', field: 'text', delta: 'not ours' }));
  assert.deepEqual(delivered.map(frame => frame.turn_id ?? (frame.turn as { turn_id?: string })?.turn_id),
    ['first', 'first', 'second', 'second', 'second']);
});

test('a state that repeats inside a turn is sent under a new event ID, never a repeated one', async t => {
  const socket = new FakeSocket();
  t.mock.method(WsSocket, 'connect', async () => socket as unknown as WsSocket);
  t.mock.method(KimiServerRestClient.prototype, 'request', async function <T>(method: string, path: string, options: RestRequestOptions = {}): Promise<T> {
    if (path === '/api/v1/sessions' && method === 'POST') return { id: 'native' } as T;
    if (path.endsWith('/prompts') && method === 'POST') {
      const promptId = (options.json as { prompt_id: string }).prompt_id;
      queueMicrotask(() => {
        socket.frame({ type: 'turn.started', turn: { turn_id: 'native-turn' } });
        socket.frame({ type: 'item.started', turn_id: 'native-turn', item: { type: 'user_message', item_id: promptId, placement: 'opener', prompt_ids: [promptId] } });
        // Kimi retries the same attempt of two different model requests.
        for (let step = 1; step <= 2; step += 1) {
          socket.frame({ type: 'turn.updated', turn_id: 'native-turn', retry: { next_attempt: 2, max_attempts: 10, delay_ms: 1000, error: { message: 'fetch failed' } } });
          socket.frame({ type: 'turn.updated', turn_id: 'native-turn', step: { index: step, outcome: 'completed' } });
        }
        socket.frame({ type: 'item.started', turn_id: 'native-turn', item: { type: 'assistant_message', item_id: 'm:1', status: 'running', text: 'done' } });
        socket.frame({ type: 'item.ended', turn_id: 'native-turn', item: { type: 'assistant_message', item_id: 'm:1', status: 'ended', text: 'done' } });
        socket.frame({ type: 'turn.ended', turn: { turn_id: 'native-turn', status: 'ended', outcome: 'completed' } });
        socket.frame({ type: 'agent', status: 'idle' });
      });
      return { prompt_id: promptId, status: 'running' } as T;
    }
    if (path.endsWith('/file-history/changes')) return { recorded: false, changes: [] } as T;
    throw new Error(`Unexpected fixture request: ${method} ${path}`);
  });
  const service = new KimiProxyService({ kimiBin: '/fixture', endpoint: { baseUrl: 'http://127.0.0.1:1', token: 'fixture' } });
  const events: Array<{ method: string; params: Record<string, unknown> }> = [];
  service.setEmitSink(event => events.push(event));
  try {
    const { snapshot } = await service.createSession({ sessionId: 's', cwd: '/workspace' });
    await service.startTurn({ sessionId: 's', streamId: snapshot.streamId as string, turnId: 't1', input: [{ type: 'text', text: 'go' }], config: {} });
    await settle(60);
    const stream = events.filter(event => event.params.streamId === snapshot.streamId);
    const retries = stream.filter(event => String((event.params.data as { activityId?: string }).activityId ?? '').startsWith('retry:'));
    assert.equal(retries.length, 4, 'two retry episodes, each opened and closed');
    const ids = stream.map(event => event.params.eventId);
    assert.equal(new Set(ids).size, ids.length, 'no event ID repeats on the stream');
    const sequences = stream.map(event => event.params.sequence as number);
    assert.deepEqual(sequences, sequences.map((_, index) => sequences[0]! + index), 'sequences are contiguous');
    assert.ok(stream.some(event => event.method === 'turn.completed'));
  } finally { await service.shutdown(); }
});
