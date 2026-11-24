import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { CordisDshHost, mountBridge, noProviderError } from '../src/cordis-host.js';
import {
  BridgeWriter,
  CONCURRENT_BRIDGE_SCHEDULE,
  bridgeErrorObject,
  runBridgeInput,
} from '../src/jsonrpc.js';
import type { BridgeRequest } from '../src/schema.js';

function harness() {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines: Array<Record<string, unknown>> = [];
  let buffer = '';
  output.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      lines.push(JSON.parse(buffer.slice(0, index)) as Record<string, unknown>);
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf('\n');
    }
  });
  const send = (id: string, method: string, params: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => {
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params, ...extra })}\n`);
  };
  return { input, writer: new BridgeWriter(output), lines, send };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test('a slow request never blocks another session, an interrupt or a process read', async () => {
  const { input, writer, lines, send } = harness();
  const started: string[] = [];
  let releaseSlow: () => void = () => undefined;
  const slow = new Promise<void>(resolve => { releaseSlow = resolve; });
  const loop = runBridgeInput(input, async (request: BridgeRequest) => {
    started.push(request.id);
    if (request.id === 'resume-a' || request.id === 'quota') await slow;
    return { id: request.id };
  }, writer, undefined, CONCURRENT_BRIDGE_SCHEDULE);

  send('init', 'initialize', { protocol: { versions: ['1.0'] } });
  send('quota', 'account.quota.read');
  send('resume-a', 'session.resume', { sessionId: 'a', nativeSessionId: 'n' });
  send('turn-a', 'turn.start', { sessionId: 'a', turnId: 't' });
  send('interrupt-a', 'turn.interrupt', { sessionId: 'a' });
  send('approve-b', 'interaction.respond', { sessionId: 'b', interactionId: 'i' });
  send('turn-b', 'turn.start', { sessionId: 'b', turnId: 't' });
  send('catalog', 'catalog.list');
  await tick(); await tick(); await tick();

  const answered = lines.map(line => line.id);
  assert.equal(answered[0], 'init', 'initialize is a barrier');
  for (const id of ['interrupt-a', 'approve-b', 'turn-b', 'catalog']) assert.ok(answered.includes(id), id);
  assert.ok(!answered.includes('turn-a'), 'same-session requests stay in order behind the slow resume');
  assert.ok(!started.includes('turn-a'));
  releaseSlow();
  input.end();
  await loop;
  const order = lines.map(line => line.id);
  assert.ok(order.indexOf('resume-a') < order.indexOf('turn-a'));
  assert.equal(order.length, 8);
});

test('a request that waited past its deadline is refused without running', async () => {
  const { input, writer, lines, send } = harness();
  const ran: string[] = [];
  let now = 1_000;
  const loop = runBridgeInput(input, async (request: BridgeRequest) => {
    ran.push(request.id);
    if (request.id === 'slow') now = 5_000;
    return {};
  }, writer, undefined, CONCURRENT_BRIDGE_SCHEDULE, () => now);
  send('slow', 'session.events.read', { sessionId: 'a' });
  send('late', 'turn.start', { sessionId: 'a', turnId: 't' }, { deadlineAt: 2_000 });
  send('fresh', 'turn.start', { sessionId: 'b', turnId: 't' }, { deadlineAt: 9_000 });
  input.end();
  await loop;
  assert.deepEqual(ran, ['slow', 'fresh']);
  const late = lines.find(line => line.id === 'late') as { error?: { data?: { domainCode?: string } } };
  assert.equal(late.error?.data?.domainCode, 'RUNTIME_UNAVAILABLE');
});

test('host error prefixes become domain codes; other errors stay anonymous', () => {
  assert.deepEqual(bridgeErrorObject(new Error('SESSION_BUSY: native turn 3 is still open')), {
    code: -32000,
    message: 'SESSION_BUSY: native turn 3 is still open',
    data: { domainCode: 'SESSION_BUSY', retryable: false },
  });
  assert.deepEqual(bridgeErrorObject(new Error('NOT_A_CODE: x')), { code: -32603, message: 'NOT_A_CODE: x' });
  assert.equal(bridgeErrorObject(noProviderError({ DSH_HOME: '/tmp/home' })).data?.domainCode, 'RUNTIME_AUTH_REQUIRED');
  assert.match(noProviderError({ DSH_HOME: '/tmp/home' }).message, /\/tmp\/home\/\.credentials\.yaml/);
});

function fakeCtx(record: { followups: number; disposed: number }) {
  const agent = {
    id: '', status: 'idle', session: { id: '', events: [] }, ctx: {},
    cancel: () => undefined, whenIdle: async () => undefined,
    followup: () => { record.followups += 1; }, steer: () => undefined, inject: () => undefined,
  };
  return {
    agents: { create: async (options: { sessionId: string }) => {
      agent.id = options.sessionId;
      agent.session.id = options.sessionId;
      return { agent, dispose: async () => { record.disposed += 1; } };
    } },
    llm: {
      listProviders: () => [{ id: 'deepseek' }],
      listModels: async () => [{ id: 'flash', provider: 'deepseek' }],
    },
    on: () => () => true,
  };
}

test('an expired turn.start admits no native turn and an expired session.create leaves no session', async () => {
  const record = { followups: 0, disposed: 0 };
  const host = new CordisDshHost(fakeCtx(record) as never, '0.1.11');
  host.attachSink(() => undefined);
  try {
    await assert.rejects(
      host.sessionCreate({ sessionId: 'late', cwd: '/tmp', roots: [], config: {}, deadlineAt: Date.now() - 1 }),
      /session\.create expired/,
    );
    assert.equal(record.disposed, 1);
    await assert.rejects(host.sessionGet({ sessionId: 'late' }), /SESSION_NOT_FOUND/);

    await host.sessionCreate({ sessionId: 's', cwd: '/tmp', roots: [], config: {} });
    await assert.rejects(
      host.turnStart({ sessionId: 's', turnId: 't', input: [{ type: 'text', text: 'hi' }], config: {}, deadlineAt: Date.now() - 1 }),
      /turn\.start expired/,
    );
    assert.equal(record.followups, 0);
    await host.turnStart({ sessionId: 's', turnId: 't', input: [{ type: 'text', text: 'hi' }], config: {}, deadlineAt: Date.now() + 60_000 });
    assert.equal(record.followups, 1);
  } finally {
    await host.dispose();
  }
});

test('stdin EOF makes the mounted bridge leave DSH through appExit', async () => {
  const record = { followups: 0, disposed: 0 };
  const exits: number[] = [];
  const ctx = { ...fakeCtx(record), appExit: (code: number) => { exits.push(code); } };
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  stdout.resume();
  mountBridge({ ctx: ctx as never, stdin: stdin as never, stdout: stdout as never });
  stdin.end();
  for (let i = 0; i < 20 && exits.length === 0; i += 1) await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(exits, [0]);
});

test('the catalog revision follows content and only real changes are announced', async () => {
  const listeners = new Map<string, (...args: unknown[]) => unknown>();
  let models = [{ id: 'flash', provider: 'deepseek' }];
  const emitted: Array<{ method: string; params: Record<string, unknown> }> = [];
  const host = new CordisDshHost({
    agents: { create: async () => { throw new Error('unused'); } },
    llm: {
      listProviders: () => [{ id: 'deepseek' }],
      listModels: async () => models,
    },
    on: (name: string, listener: (...args: unknown[]) => unknown) => {
      listeners.set(name, listener);
      return () => listeners.delete(name);
    },
  } as never, '0.1.11');
  host.attachSink(event => emitted.push(event));
  const settle = () => new Promise(resolveDelay => setTimeout(resolveDelay, 400));
  try {
    const first = String((await host.catalogList()).catalogRevision);
    assert.match(first, /^cordis-[^-]+.*-[0-9a-f]{16}$/);
    assert.equal(String((await host.catalogList()).catalogRevision), first, 'stable for the same content');

    listeners.get('llm/adapters-updated')?.();
    listeners.get('llm/adapters-updated')?.();
    await settle();
    assert.equal(emitted.filter(event => event.method === 'catalog.changed').length, 0, 'no content change, no notice');

    models = [...models, { id: 'pro', provider: 'deepseek' }];
    listeners.get('llm/adapters-updated')?.();
    await settle();
    const changed = emitted.filter(event => event.method === 'catalog.changed');
    assert.equal(changed.length, 1);
    const next = String((await host.catalogList()).catalogRevision);
    assert.notEqual(next, first);
    assert.equal(changed[0]?.params.catalogRevision, next);
  } finally {
    await host.dispose();
  }
});
