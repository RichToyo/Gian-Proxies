import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { proxyNotificationSchema } from '@gian/proxy-protocol';
import { KimiProxyService } from '../src/core/service.js';
import { KimiServerRestClient, type RestRequestOptions } from '../src/runtime/rest-client.js';
import { WsSocket } from '../src/runtime/ws.js';

class FakeSocket extends EventEmitter {
  status: 'open' | 'closed' = 'open';
  snapshotTurns: Array<Record<string, unknown>> = [];
  pendingFrames: Array<Record<string, unknown>> = [];
  agentStatus = 'idle';
  sendText(text: string): void {
    const frame = JSON.parse(text) as Record<string, unknown>;
    if (frame.type === 'subscribe') queueMicrotask(() => {
      this.emit('message', JSON.stringify({ type: 'response', request_id: frame.request_id, code: 0 }));
      for (const pending of this.pendingFrames) this.frame(pending);
      this.frame({ type: 'task.list', tasks: [] });
      this.frame({ type: 'agent', status: this.agentStatus });
      this.frame({ type: 'turns', turns: this.snapshotTurns, has_more: false });
    });
    if (frame.type === 'unsubscribe') queueMicrotask(() => this.emit('message', JSON.stringify({ type: 'response', request_id: frame.request_id, code: 0 })));
  }
  frame(value: Record<string, unknown>): void {
    this.emit('message', JSON.stringify({ session_id: 'native', agent_id: 'main', event_created_at: '2026-11-16T12:00:00Z', ...value }));
  }
  close(): void { this.status = 'closed'; this.emit('close'); }
}

test('2.7 admission orders fast native output after turn.started without sending permissions', async t => {
  const socket = new FakeSocket();
  t.mock.method(WsSocket, 'connect', async () => socket as unknown as WsSocket);
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  let acceptedPrompt = '';
  t.mock.method(KimiServerRestClient.prototype, 'request', async function <T>(method: string, path: string, options: RestRequestOptions = {}): Promise<T> {
    requests.push({ method, path, body: options.json });
    if (path === '/api/v1/sessions' && method === 'POST') return { id: 'native' } as T;
    if (path.endsWith('/prompts') && method === 'POST') {
      const body = options.json as { prompt_id: string };
      acceptedPrompt = body.prompt_id;
      socket.frame({ type: 'turn.started', turn: { turn_id: 'native-turn', turn_number: 1 } });
      socket.frame({ type: 'item.started', turn_id: 'native-turn', item: { type: 'user_message', item_id: 'u', placement: 'opener', prompt_ids: [body.prompt_id] } });
      socket.frame({ type: 'item.started', turn_id: 'native-turn', item: { type: 'assistant_message', item_id: 'i1', status: 'running', text: 'Hi' } });
      socket.frame({ type: 'item.ended', turn_id: 'native-turn', item: { type: 'assistant_message', item_id: 'i1', status: 'ended', text: 'Hi' } });
      socket.frame({ type: 'turn.ended', turn: { turn_id: 'native-turn', turn_number: 1, status: 'ended', outcome: 'completed',
        usage: { input_other: 8, input_cache_read: 3, input_cache_creation: 2, output: 4 } } });
      socket.frame({ type: 'agent', status: 'idle' });
      return { prompt_id: body.prompt_id, status: 'running' } as T;
    }
    if (path.endsWith('/agents/main/turns')) return { has_more: false, turns: [{ turn_id: 'native-turn', ordinal: 1,
      started_at: '2026-11-16T12:00:00Z', status: 'ended', outcome: 'completed',
      usage: { input_other: 8, input_cache_read: 3, input_cache_creation: 2, output: 4 }, items: [
        { type: 'user_message', item_id: 'u', placement: 'opener', prompt_ids: [acceptedPrompt], text: 'hello', attachments: [], skills: [], created_at: '2026-11-16T12:00:00Z' },
        { type: 'assistant_message', item_id: 'i1', status: 'ended', text: 'Hi', created_at: '2026-11-16T12:00:00Z' },
      ] }] } as T;
    if (path.endsWith('/file-history/changes')) return { recorded: false, changes: [] } as T;
    throw new Error(`Unexpected fixture request: ${method} ${path}`);
  });
  const service = new KimiProxyService({ kimiBin: '/fixture', endpoint: { baseUrl: 'http://127.0.0.1:1', token: 'fixture' } });
  const events: Array<{ method: string; params: Record<string, unknown> }> = [];
  service.setEmitSink(event => events.push(event));
  try {
    const { snapshot } = await service.createSession({ sessionId: 's', cwd: '/workspace' });
    events.length = 0;
    await service.startTurn({ sessionId: 's', streamId: snapshot.streamId as string, turnId: 't1', input: [{ type: 'text', text: 'hello' }], config: {} });
    await new Promise(resolve => setTimeout(resolve, 30));
    const turnEvents = events.filter(event => event.method !== 'session.updated');
    assert.deepEqual(turnEvents.map(event => event.method), ['turn.started', 'content.delta', 'content.completed', 'usage.updated', 'turn.completed']);
    const sequences = events.map(event => event.params.sequence as number);
    assert.deepEqual(sequences, [...sequences].sort((a, b) => a - b));
    assert.equal(requests.some(request => request.path.includes('/interactions/')), false);
    assert.equal(service.describeSession('s').state, 'idle');
    const replay = await service.replay({ sessionId: 's', streamId: snapshot.streamId as string });
    assert.equal(replay.events.find(event => event.method === 'content.completed')?.eventId,
      turnEvents.find(event => event.method === 'content.completed')?.params.eventId);
    assert.equal(replay.events.find(event => event.method === 'usage.updated')?.eventId,
      turnEvents.find(event => event.method === 'usage.updated')?.params.eventId);
    for (const event of events) proxyNotificationSchema.parse({ jsonrpc: '2.0', ...event });
  } finally { await service.shutdown(); }
});

test('2.7 sends an approval only after an explicit host response, including WS/HTTP race', async t => {
  const socket = new FakeSocket();
  t.mock.method(WsSocket, 'connect', async () => socket as unknown as WsSocket);
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const interaction = { type: 'interaction', kind: 'approval', interaction_id: 'i1', tool_call_id: 'tool',
    request: { tool_name: 'Bash', action: 'pwd', expires_at: '2026-11-16T12:10:00Z' } };
  t.mock.method(KimiServerRestClient.prototype, 'request', async function <T>(method: string, path: string, options: RestRequestOptions = {}): Promise<T> {
    requests.push({ method, path, body: options.json });
    if (path === '/api/v1/sessions' && method === 'POST') return { id: 'native' } as T;
    if (path.endsWith('/prompts') && method === 'POST') {
      const body = options.json as { prompt_id: string };
      socket.frame({ ...interaction, status: 'pending' });
      socket.frame({ type: 'turn.started', turn: { turn_id: 'native-turn', turn_number: 1 } });
      socket.frame({ type: 'item.started', turn_id: 'native-turn', item: { type: 'user_message', item_id: 'u', placement: 'opener', prompt_ids: [body.prompt_id] } });
      socket.frame({ type: 'item.started', turn_id: 'native-turn', item: { type: 'tool_call', item_id: 'tool', name: 'Bash', status: 'running' } });
      return { prompt_id: body.prompt_id, status: 'running' } as T;
    }
    if (path === '/api/v1/sessions/native/interactions/i1') {
      socket.frame({ ...interaction, status: 'ended', outcome: 'approved' });
      return { outcome: 'approved' } as T;
    }
    throw new Error(`Unexpected fixture request: ${method} ${path}`);
  });
  const service = new KimiProxyService({ kimiBin: '/fixture', endpoint: { baseUrl: 'http://127.0.0.1:1', token: 'fixture' } });
  const events: Array<{ method: string; params: Record<string, unknown> }> = [];
  service.setEmitSink(event => events.push(event));
  try {
    const { snapshot } = await service.createSession({ sessionId: 's', cwd: '/workspace' });
    await service.startTurn({ sessionId: 's', streamId: snapshot.streamId as string, turnId: 't1', input: [{ type: 'text', text: 'hello' }], config: {} });
    assert.equal(requests.some(request => request.path.includes('/interactions/')), false);
    assert.equal(service.describeSession('s').state, 'waiting_interaction');
    await assert.rejects(service.respondInteraction({ sessionId: 's', streamId: snapshot.streamId as string, turnId: 't1', interactionId: 'apr:i1', actionId: 'unexpected', values: {} }), { domainCode: 'INTERACTION_ACTION_NOT_FOUND' });
    await assert.rejects(service.respondInteraction({ sessionId: 's', streamId: snapshot.streamId as string, turnId: 't1', interactionId: 'apr:missing', actionId: 'approved', values: {} }), { domainCode: 'INTERACTION_NOT_FOUND' });
    assert.equal(requests.some(request => request.path.includes('/interactions/')), false);
    await service.respondInteraction({ sessionId: 's', streamId: snapshot.streamId as string, turnId: 't1', interactionId: 'apr:i1', actionId: 'approved', values: {} });
    assert.deepEqual(requests.find(request => request.path.endsWith('/interactions/i1'))?.body, { kind: 'approval', decision: 'approved' });
    const resolved = events.find(event => event.method === 'interaction.resolved');
    assert.deepEqual(resolved?.params.data, { interactionId: 'apr:i1', outcome: 'submitted', actionId: 'approved' });
    for (const event of events) proxyNotificationSchema.parse({ jsonrpc: '2.0', ...event });
  } finally { await service.shutdown(); }
});

test('2.7 skill-only input preserves the selected native skill path', async t => {
  const socket = new FakeSocket();
  t.mock.method(WsSocket, 'connect', async () => socket as unknown as WsSocket);
  let submitted: Record<string, unknown> | undefined;
  t.mock.method(KimiServerRestClient.prototype, 'request', async function <T>(method: string, path: string, options: RestRequestOptions = {}): Promise<T> {
    if (path === '/api/v1/sessions' && method === 'POST') return { id: 'native' } as T;
    if (path.endsWith('/prompts') && method === 'POST') {
      submitted = options.json as Record<string, unknown>;
      return { prompt_id: submitted.prompt_id, status: 'running' } as T;
    }
    throw new Error(`Unexpected fixture request: ${method} ${path}`);
  });
  const service = new KimiProxyService({ kimiBin: '/fixture', endpoint: { baseUrl: 'http://127.0.0.1:1', token: 'fixture' } });
  try {
    const { snapshot } = await service.createSession({ sessionId: 's', cwd: '/workspace' });
    await service.startTurn({ sessionId: 's', streamId: snapshot.streamId as string, turnId: 't1',
      input: [{ type: 'skill', name: 'audit', path: '/workspace/skills/audit' }], config: {} });
    assert.deepEqual(submitted?.content, [{ type: 'text', text: '' }]);
    assert.deepEqual(submitted?.skills, [{ name: 'audit', path: '/workspace/skills/audit' }]);
    assert.deepEqual((submitted?.metadata as Record<string, unknown>)['gian.input.v1'], {
      promptId: submitted?.prompt_id, input: [{ type: 'skill', name: 'audit', path: '/workspace/skills/audit' }],
    });
  } finally { await service.shutdown(); }
});

test('2.7 socket reconnect restores the active turn without resending the prompt', async t => {
  const sockets = [new FakeSocket(), new FakeSocket()];
  let connection = 0, promptId = '', submissions = 0;
  sockets[1]!.agentStatus = 'running';
  t.mock.method(WsSocket, 'connect', async () => sockets[connection++] as unknown as WsSocket);
  t.mock.method(KimiServerRestClient.prototype, 'request', async function <T>(method: string, path: string, options: RestRequestOptions = {}): Promise<T> {
    if (path === '/api/v1/sessions' && method === 'POST') return { id: 'native' } as T;
    if (path.endsWith('/prompts') && method === 'POST') {
      submissions += 1;
      promptId = (options.json as { prompt_id: string }).prompt_id;
      const opener = { type: 'user_message', item_id: 'u', status: 'ended', placement: 'opener', prompt_ids: [promptId] };
      sockets[0]!.frame({ type: 'turn.started', turn: { turn_id: 'native-turn', turn_number: 1 } });
      sockets[0]!.frame({ type: 'item.ended', turn_id: 'native-turn', item: opener });
      sockets[0]!.frame({ type: 'item.started', turn_id: 'native-turn', item: { type: 'assistant_message', item_id: 'i', status: 'running', text: 'hello' } });
      sockets[1]!.snapshotTurns = [{ turn_id: 'native-turn', turn_number: 1, status: 'running',
        items: [opener, { type: 'assistant_message', item_id: 'i', status: 'running', text: 'hello world' }] }];
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
    await service.startTurn({ sessionId: 's', streamId: snapshot.streamId as string, turnId: 't1', input: [{ type: 'text', text: 'hello' }], config: {} });
    sockets[0]!.close();
    assert.equal(service.describeSession('s').state, 'stale');
    await new Promise(resolvePromise => setTimeout(resolvePromise, 650));
    assert.equal(service.describeSession('s').state, 'running');
    sockets[1]!.frame({ type: 'item.ended', turn_id: 'native-turn', item: { type: 'assistant_message', item_id: 'i', status: 'ended', text: 'hello world' } });
    sockets[1]!.frame({ type: 'turn.ended', turn: { turn_id: 'native-turn', turn_number: 1, status: 'ended', outcome: 'completed' } });
    sockets[1]!.frame({ type: 'agent', status: 'idle' });
    await new Promise(resolvePromise => setTimeout(resolvePromise, 30));
    assert.equal(submissions, 1);
    assert.deepEqual(events.filter(event => event.method === 'content.delta').map(event => (event.params.data as Record<string, unknown>).delta), ['hello', ' world']);
    assert.equal(events.filter(event => event.method === 'turn.completed').length, 1);
  } finally { await service.shutdown(); }
});

test('2.7 reconnect during prompt admission keeps ordering and does not resend', async t => {
  const sockets = [new FakeSocket(), new FakeSocket()];
  sockets[1]!.agentStatus = 'running';
  let connection = 0, submissions = 0, finishPost!: (value: unknown) => void, enteredPost!: () => void;
  const entered = new Promise<void>(resolve => { enteredPost = resolve; });
  t.mock.method(WsSocket, 'connect', async () => sockets[connection++] as unknown as WsSocket);
  t.mock.method(KimiServerRestClient.prototype, 'request', async function <T>(method: string, path: string, options: RestRequestOptions = {}): Promise<T> {
    if (path === '/api/v1/sessions' && method === 'POST') return { id: 'native' } as T;
    if (path.endsWith('/prompts') && method === 'POST') {
      submissions += 1;
      const promptId = (options.json as { prompt_id: string }).prompt_id;
      const opener = { type: 'user_message', item_id: 'u', status: 'ended', placement: 'opener', prompt_ids: [promptId] };
      sockets[0]!.frame({ type: 'turn.started', turn: { turn_id: 't1', turn_number: 1 } });
      sockets[0]!.frame({ type: 'item.ended', turn_id: 't1', item: opener });
      sockets[0]!.frame({ type: 'item.started', turn_id: 't1', item: { type: 'assistant_message', item_id: 'i', status: 'running', text: 'hello' } });
      sockets[1]!.snapshotTurns = [{ turn_id: 't1', turn_number: 1, status: 'running', items: [opener,
        { type: 'assistant_message', item_id: 'i', status: 'running', text: 'hello world' }] }];
      enteredPost();
      return await new Promise<T>(resolve => { finishPost = value => resolve(value as T); });
    }
    if (path.endsWith('/file-history/changes')) return { recorded: false, changes: [] } as T;
    throw new Error(`Unexpected fixture request: ${method} ${path}`);
  });
  const service = new KimiProxyService({ kimiBin: '/fixture', endpoint: { baseUrl: 'http://127.0.0.1:1', token: 'fixture' } });
  const events: Array<{ method: string; params: Record<string, unknown> }> = [];
  service.setEmitSink(event => events.push(event));
  try {
    const { snapshot } = await service.createSession({ sessionId: 's', cwd: '/workspace' });
    const start = service.startTurn({ sessionId: 's', streamId: snapshot.streamId as string, turnId: 't1', input: [{ type: 'text', text: 'hello' }], config: {} });
    await entered; sockets[0]!.close();
    await new Promise(resolvePromise => setTimeout(resolvePromise, 650));
    const metadata = sockets[1]!.snapshotTurns[0]!.items as Array<Record<string, unknown>>;
    const promptId = (metadata[0]!.prompt_ids as string[])[0]!;
    finishPost({ prompt_id: promptId, status: 'running' });
    await start;
    assert.equal(service.describeSession('s').state, 'running');
    sockets[1]!.frame({ type: 'item.ended', turn_id: 't1', item: { type: 'assistant_message', item_id: 'i', status: 'ended', text: 'hello world' } });
    sockets[1]!.frame({ type: 'turn.ended', turn: { turn_id: 't1', turn_number: 1, status: 'ended', outcome: 'completed' } });
    sockets[1]!.frame({ type: 'agent', status: 'idle' });
    await new Promise(resolvePromise => setTimeout(resolvePromise, 30));
    assert.equal(submissions, 1);
    assert.deepEqual(events.filter(event => event.method === 'content.delta').map(event => (event.params.data as Record<string, unknown>).delta), ['hello', ' world']);
    const sequences = events.map(event => event.params.sequence as number);
    assert.deepEqual(sequences, [...sequences].sort((a, b) => a - b));
  } finally { await service.shutdown(); }
});

test('2.7 reconnect preserves a pending permission without answering it', async t => {
  const sockets = [new FakeSocket(), new FakeSocket()];
  sockets[1]!.agentStatus = 'running';
  let connection = 0;
  const requests: Array<{ path: string; body: unknown }> = [];
  const permission = { type: 'interaction', status: 'pending', kind: 'approval', interaction_id: 'i1', tool_call_id: 'tool',
    request: { tool_name: 'Bash', action: 'pwd', expires_at: '2026-11-16T12:10:00Z' } };
  sockets[1]!.pendingFrames = [permission];
  t.mock.method(WsSocket, 'connect', async () => sockets[connection++] as unknown as WsSocket);
  t.mock.method(KimiServerRestClient.prototype, 'request', async function <T>(method: string, path: string, options: RestRequestOptions = {}): Promise<T> {
    requests.push({ path, body: options.json });
    if (path === '/api/v1/sessions' && method === 'POST') return { id: 'native' } as T;
    if (path.endsWith('/prompts') && method === 'POST') {
      const promptId = (options.json as { prompt_id: string }).prompt_id;
      const opener = { type: 'user_message', item_id: 'u', status: 'ended', placement: 'opener', prompt_ids: [promptId] };
      const tool = { type: 'tool_call', item_id: 'tool', name: 'Bash', status: 'running', interaction_id: 'i1' };
      sockets[0]!.frame({ type: 'turn.started', turn: { turn_id: 't1', turn_number: 1 } });
      sockets[0]!.frame({ type: 'item.ended', turn_id: 't1', item: opener });
      sockets[0]!.frame({ type: 'item.started', turn_id: 't1', item: tool });
      sockets[0]!.frame(permission);
      sockets[1]!.snapshotTurns = [{ turn_id: 't1', turn_number: 1, status: 'running', items: [opener, tool] }];
      return { prompt_id: promptId, status: 'running' } as T;
    }
    if (path.endsWith('/interactions/i1')) return { outcome: 'rejected' } as T;
    throw new Error(`Unexpected fixture request: ${method} ${path}`);
  });
  const service = new KimiProxyService({ kimiBin: '/fixture', endpoint: { baseUrl: 'http://127.0.0.1:1', token: 'fixture' } });
  const events: Array<{ method: string; params: Record<string, unknown> }> = [];
  service.setEmitSink(event => events.push(event));
  try {
    const { snapshot } = await service.createSession({ sessionId: 's', cwd: '/workspace' });
    await service.startTurn({ sessionId: 's', streamId: snapshot.streamId as string, turnId: 't1', input: [{ type: 'text', text: 'hello' }], config: {} });
    sockets[0]!.close();
    await new Promise(resolvePromise => setTimeout(resolvePromise, 650));
    assert.equal(service.describeSession('s').state, 'waiting_interaction');
    assert.equal(events.filter(event => event.method === 'interaction.requested').length, 1);
    assert.equal(requests.some(request => request.path.includes('/interactions/')), false);
    await service.respondInteraction({ sessionId: 's', streamId: snapshot.streamId as string, turnId: 't1',
      interactionId: 'apr:i1', actionId: 'rejected', values: {} });
    assert.deepEqual(requests.find(request => request.path.endsWith('/interactions/i1'))?.body, { kind: 'approval', decision: 'rejected' });
  } finally { await service.shutdown(); }
});
