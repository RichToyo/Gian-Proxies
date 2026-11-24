/** End-to-end tests of the kimi proxy CLI (proxy kit + adapter + service)
 *  against the fake Kimi Code 2.7 server. */

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createSession, initialize, startHarness, type Harness, type OutgoingLine } from './harness.js';

type Params = { sessionId?: string; turnId?: string; sourceTurnId?: string; data: Record<string, unknown> };
const params = (line: OutgoingLine) => line.payload.params as Params;
const result = <T>(line: OutgoingLine) => (line.payload as { result: T }).result;
const error = (line: OutgoingLine) => (line.payload as { error: { code: number; message: string; data?: { domainCode: string; retryable: boolean; details: Record<string, unknown> } } }).error;

async function terminal(harness: Harness, turnId: string, seen: OutgoingLine[] = []): Promise<OutgoingLine> {
  return harness.waitNotificationFor(line => (line.method === 'turn.completed' || line.method === 'turn.failed')
    && params(line).turnId === turnId, 10_000, seen);
}

const MODELS = { models: [{ model: 'kimi', display_name: 'Kimi', support_efforts: ['low'], default_effort: 'low' }], default_model: 'kimi' };
const TURN_CONFIG = { model: 'kimi', thinking: 'low', approval_mode: 'manual' };

/** Every scenario offers one model so Host-shaped turn config resolves. */
const start = (scenario: Record<string, unknown>, options: Parameters<typeof startHarness>[1] = {}): Harness => startHarness({ ...MODELS, ...scenario }, options);

/** The Host's own flow, so the conformance validator knows the session. */
async function validatedSession(harness: Harness): Promise<string> {
  await initialize(harness);
  await harness.request('catalog.list', {});
  return createSession(harness);
}

async function runTurn(harness: Harness, streamId: string, turnId: string, text = 'hello', sessionId = 's_1') {
  const accepted = await harness.request('turn.start', { sessionId, streamId, turnId, input: [{ type: 'text', text }], config: TURN_CONFIG });
  assert.equal(accepted.kind, 'result', JSON.stringify(accepted.payload));
  const seen: OutgoingLine[] = [];
  const end = await terminal(harness, turnId, seen);
  return { end, seen: [...seen, end] };
}

function requests(harness: Harness, path?: RegExp) {
  return harness.fakeLog().filter(entry => entry.kind === 'request' && (path === undefined || path.test(String(entry.path))));
}

test('initialize declares the Kimi 2.7 capability set, including turn forks', async () => {
  const harness = start({});
  try {
    const init = await initialize(harness);
    const capabilities = init.capabilities as Record<string, number>;
    assert.equal(capabilities['session.fork'], 1);
    assert.equal(capabilities['session.fork.atTurn'], 1);
    assert.equal(capabilities['account.quota.read'], 1);
    const catalog = await harness.request('catalog.list', {});
    const actions = result<{ actions: Array<{ id: string; supported: boolean }> }>(catalog).actions;
    assert.equal(actions.find(action => action.id === 'session.fork.atTurn')?.supported, true);
    const start = harness.fakeLog().find(entry => entry.kind === 'start');
    assert.deepEqual((start?.argv as string[]).slice(0, 5), ['web', '--json', '--no-open', '--port', '0']);
    assert.equal(start?.noAutoUpdate, '1');
  } finally { await harness.close(); }
});

test('a turn streams after its Response and reports one native usage delta with Host conformance', async () => {
  const usage = { input_other: 8, input_cache_read: 3, input_cache_creation: 2, output: 4 };
  const harness = start({ prompts: [{ reply: 'Hello world', usage }] }, { validateProtocol: true });
  try {
    const streamId = await validatedSession(harness);
    assert.deepEqual(requests(harness, /^\/api\/v1\/sessions$/).map(entry => entry.body), [{ cwd: harness.workspace }]);
    assert.equal(requests(harness, /workspaces|messages|children/).length, 0);
    const { end, seen } = await runTurn(harness, streamId, 't_1');
    assert.equal(end.method, 'turn.completed');
    assert.equal(params(end).data.stopReason, 'completed');
    const usages = seen.filter(line => line.method === 'usage.updated' && (params(line).data.conversation !== undefined));
    assert.equal(usages.length, 1);
    assert.deepEqual(params(usages[0]!).data.conversation,
      { mode: 'delta', inputTokens: 13, outputTokens: 4, cachedInputTokens: 3, totalTokens: 17 });
    assert.equal(seen.find(line => line.method === 'content.completed') !== undefined, true);
    const replay = await harness.request('session.replay', { sessionId: 's_1', streamId, cursor: null, limit: 100 });
    const events = result<{ events: Array<{ method: string; eventId: string }> }>(replay).events;
    assert.equal(events.find(event => event.method === 'usage.updated')?.eventId,
      (usages[0]!.payload.params as { eventId: string }).eventId);
    assert.deepEqual(harness.protocolErrors, []);
  } finally { await harness.close(); }
});

test('the Host Agent home becomes KIMI_CODE_HOME for the version check and the server', async () => {
  const agentHome = join(mkdtempSync(join(tmpdir(), 'kimi-agent-home-')), 'home');
  const mapped = start({}, { env: { GIAN_AGENT_HOME: agentHome, KIMI_CODE_HOME: '/tmp/bridge-home-not-used' } });
  try {
    await initialize(mapped);
    await createSession(mapped);
    const homes = mapped.fakeLog().filter(entry => entry.kind === 'version' || entry.kind === 'start').map(entry => entry.kimiCodeHome);
    assert.ok(homes.length >= 2);
    assert.deepEqual([...new Set(homes)], [agentHome]);
  } finally { await mapped.close(); }
});

test('an unsupported Kimi version fails with an actionable message before any server starts', async () => {
  const harness = start({ version: '2.6.3' });
  try {
    await initialize(harness);
    const created = await harness.request('session.create', { sessionId: 's_1', workspace: { cwd: harness.workspace, roots: [harness.workspace] }, config: {} });
    assert.equal(created.kind, 'error');
    assert.match(error(created).message, /Kimi Code 2\.6\.3 is not supported by this Proxy\. Use Kimi Code 2\.7\.1 or 2\.7\.2/);
    assert.equal(mappedStarts(harness), 0);
  } finally { await harness.close(); }
});

function mappedStarts(harness: Harness): number {
  return harness.fakeLog().filter(entry => entry.kind === 'start').length;
}

test('a failed native turn carries Kimi’s own error text and code', async () => {
  const harness = start({ prompts: [
    { outcome: 'failed', endReason: 'error', error: { code: 'provider.rate_limit', message: 'Rate limit reached for model x.', status_code: 429, retryable: true } },
    { outcome: 'failed', endReason: 'error', error: { code: 'provider.auth_error', message: 'Incorrect API key provided.', status_code: 401 } },
  ] }, { validateProtocol: true });
  try {
    const streamId = await validatedSession(harness);
    const first = await runTurn(harness, streamId, 't_1');
    assert.equal(first.end.method, 'turn.failed');
    const failure = params(first.end).data.error as { domainCode: string; message: string; retryable: boolean; details: Record<string, unknown> };
    assert.equal(failure.domainCode, 'RUNTIME_ERROR');
    assert.equal(failure.message, 'Rate limit reached for model x.');
    assert.equal(failure.retryable, true);
    assert.deepEqual(failure.details, { nativeCode: 'provider.rate_limit', statusCode: 429, endReason: 'error' });
    const second = await runTurn(harness, streamId, 't_2');
    const auth = params(second.end).data.error as { domainCode: string; message: string };
    assert.equal(auth.domainCode, 'RUNTIME_AUTH_REQUIRED');
    assert.match(auth.message, /^Incorrect API key provided\. Sign in to Kimi Code .*kimi login.*api_key/);
    assert.deepEqual(harness.protocolErrors, []);
  } finally { await harness.close(); }
});

test('a prompt Kimi rejects reports the native failure instead of a generic one', async () => {
  const harness = start({ prompts: [
    { status: 'failed', error: { code: 'auth.login_required', message: 'Kimi Code is not logged in.' } },
  ] });
  try {
    const streamId = await validatedSession(harness);
    const rejected = await harness.request('turn.start', { sessionId: 's_1', streamId, turnId: 't_1', input: [{ type: 'text', text: 'x' }], config: TURN_CONFIG });
    assert.equal(rejected.kind, 'error');
    assert.equal(error(rejected).data?.domainCode, 'RUNTIME_AUTH_REQUIRED');
    assert.match(error(rejected).message, /^Kimi Code is not logged in\./);
    assert.equal(error(rejected).data?.details.nativeCode, 'auth.login_required');
  } finally { await harness.close(); }
});

test('a queued prompt waits for a foreign notification turn and binds only its own turn', async () => {
  const harness = start({ prompts: [{ queueBehind: 150, reply: 'after the notification' }] }, { validateProtocol: true });
  try {
    const streamId = await validatedSession(harness);
    const { end, seen } = await runTurn(harness, streamId, 't_1');
    assert.equal(end.method, 'turn.completed');
    const text = seen.filter(line => line.method === 'content.completed').map(line => params(line).data.content);
    assert.deepEqual(text, ['after the notification']);
    assert.equal(requests(harness, /:abort$/).length, 0, 'a queued prompt is not withdrawn');
    assert.deepEqual(harness.protocolErrors, []);
  } finally { await harness.close(); }
});

test('interrupting a still-queued prompt ends the turn as interrupted without a native turn', async () => {
  const harness = start({ prompts: [{ queueBehind: 3_000, reply: 'never' }] }, { validateProtocol: true });
  try {
    const streamId = await validatedSession(harness);
    const accepted = await harness.request('turn.start', { sessionId: 's_1', streamId, turnId: 't_1', input: [{ type: 'text', text: 'x' }], config: TURN_CONFIG });
    assert.equal(accepted.kind, 'result');
    await harness.waitNotificationFor(line => line.method === 'turn.started');
    const interrupted = await harness.request('turn.interrupt', { sessionId: 's_1', streamId, turnId: 't_1' });
    assert.equal(interrupted.kind, 'result', JSON.stringify(interrupted.payload));
    const end = await terminal(harness, 't_1');
    assert.equal(end.method, 'turn.completed');
    assert.equal(params(end).data.stopReason, 'interrupted');
    assert.deepEqual(harness.protocolErrors, []);
  } finally { await harness.close(); }
});

test('approval, native retry and notice round-trip with no open activity at the terminal', async () => {
  const harness = start({ prompts: [{ approval: true, retry: 'Service unavailable.', notice: { level: 'warning', title: 'Context nearly full' }, reply: 'done' }] },
    { validateProtocol: true });
  try {
    const streamId = await validatedSession(harness);
    await harness.request('turn.start', { sessionId: 's_1', streamId, turnId: 't_1', input: [{ type: 'text', text: 'x' }], config: TURN_CONFIG });
    const seen: OutgoingLine[] = [];
    const requested = await harness.waitNotificationFor(line => line.method === 'interaction.requested', 10_000, seen);
    const interactionId = params(requested).data.interactionId as string;
    const answered = await harness.request('interaction.respond', { sessionId: 's_1', streamId, turnId: 't_1', interactionId,
      responseId: 'r1', actionId: 'approved', values: {} });
    assert.equal(answered.kind, 'result', JSON.stringify(answered.payload));
    const end = await terminal(harness, 't_1', seen);
    assert.equal(end.method, 'turn.completed');
    const retries = seen.filter(line => line.method === 'activity.updated' && params(line).data.kind === 'kimi:retry').map(line => params(line).data.status);
    assert.deepEqual(retries, ['running', 'succeeded']);
    assert.ok(seen.some(line => line.method === 'activity.updated' && params(line).data.kind === 'kimi:notice'));
    assert.deepEqual(requests(harness, /\/interactions\//).map(entry => entry.body), [{ kind: 'approval', decision: 'approved' }]);
    assert.deepEqual(harness.protocolErrors, []);
  } finally { await harness.close(); }
});

test('forks use :fork: head, turn boundary by native turn number, and child Side Chats', async () => {
  const harness = start({ prompts: [{ reply: 'one' }, { reply: 'two' }] });
  try {
    const streamId = await validatedSession(harness);
    const first = await runTurn(harness, streamId, 't_1');
    const firstSource = params(first.end).sourceTurnId!;
    await runTurn(harness, streamId, 't_2');

    const head = await harness.request('session.fork', { sourceSessionId: 's_1', sourceStreamId: streamId, sessionId: 's_head', anchor: { type: 'head' } });
    assert.equal(head.kind, 'result', JSON.stringify(head.payload));
    const atTurn = await harness.request('session.fork', { sourceSessionId: 's_1', sourceStreamId: streamId, sessionId: 's_turn',
      anchor: { type: 'turn', turnId: 't_1', sourceTurnId: firstSource } });
    assert.equal(atTurn.kind, 'result', JSON.stringify(atTurn.payload));
    assert.deepEqual(result<{ origin: Record<string, unknown> }>(atTurn).origin, { kind: 'fork', sessionId: 's_1', turnId: 't_1', sourceTurnId: firstSource });
    const unknown = await harness.request('session.fork', { sourceSessionId: 's_1', sourceStreamId: streamId, sessionId: 's_bad',
      anchor: { type: 'turn', turnId: 't_x', sourceTurnId: 'gian-unknown' } });
    assert.equal(error(unknown).data?.domainCode, 'FORK_BOUNDARY_UNAVAILABLE');
    const sidechat = await harness.request('sidechat.create', { parentSessionId: 's_1', parentStreamId: streamId, sidechatId: 'sc_1' });
    assert.equal(sidechat.kind, 'result', JSON.stringify(sidechat.payload));

    const forks = requests(harness, /:fork$/).map(entry => entry.body as Record<string, unknown>);
    assert.deepEqual(forks[0], {});
    assert.deepEqual(forks[1], { turn_index: 0 });
    assert.equal((forks.at(-1)!.metadata as Record<string, unknown>).child_session_kind, 'child');
    assert.equal(requests(harness, /children/).length, 0);

    const listed = await harness.request('session.native.list', {});
    const ids = result<{ sessions: Array<{ id: string }> }>(listed).sessions.map(session => session.id);
    assert.equal(ids.length, 0, 'attached sessions and Side Chat children are not offered for attach');
  } finally { await harness.close(); }
});

test('a historical turn forks from native history after reattach', async () => {
  const time = '2026-11-20T10:00:00.000Z';
  const turn = (number: number, prompt: string) => ({ turn_id: `old_${number}`, ordinal: number, turn_number: number, kind: 'agent', status: 'ended',
    outcome: 'completed', started_at: time, ended_at: time, steps: [], items: [
      { type: 'user_message', item_id: `u${number}`, status: 'ended', created_at: time, prompt_ids: [prompt], placement: 'opener',
        origin: { kind: 'user' }, text: prompt, attachments: [], skills: [] },
      { type: 'assistant_message', item_id: `a${number}`, status: 'ended', outcome: 'completed', created_at: time, text: `reply ${number}` },
    ] });
  const harness = start({ sessions: [{ id: 'native_old', cwd: '/tmp', turns: [turn(0, 'p0'), turn(1, 'p1'), turn(2, 'p2')] }],
    prompts: [{ reply: 'new' }] });
  try {
    await initialize(harness);
    const created = await harness.request('session.create', { sessionId: 's_1', workspace: { cwd: harness.workspace, roots: [harness.workspace] },
      config: {}, nativeSession: { id: 'native_old', history: 'replay' } });
    const streamId = result<{ session: { streamId: string } }>(created).session.streamId;
    await runTurn(harness, streamId, 't_new');
    const forked = await harness.request('session.fork', { sourceSessionId: 's_1', sourceStreamId: streamId, sessionId: 's_f',
      anchor: { type: 'turn', turnId: 'host-turn-p1', sourceTurnId: 'p1' } });
    assert.equal(forked.kind, 'result', JSON.stringify(forked.payload));
    assert.deepEqual(requests(harness, /:fork$/).map(entry => entry.body), [{ turn_index: 1 }]);
  } finally { await harness.close(); }
});

test('sessions run in their own lanes: one slow request does not hold another session', async () => {
  const harness = start({ prompts: [{ postDelayMs: 800, reply: 'slow' }] });
  try {
    await initialize(harness);
    const streamA = await createSession(harness, 's_a');
    await createSession(harness, 's_b');
    const slow = harness.request('turn.start', { sessionId: 's_a', streamId: streamA, turnId: 't_a', input: [{ type: 'text', text: 'x' }], config: TURN_CONFIG });
    await new Promise(resolve => setTimeout(resolve, 100));
    const started = Date.now();
    const quick = await harness.request('session.get', { sessionId: 's_b' });
    assert.equal(quick.kind, 'result');
    assert.ok(Date.now() - started < 500, 'session B answered while session A was still submitting');
    assert.equal((await slow).kind, 'result');
  } finally { await harness.close(); }
});

test('server exit marks sessions stale and the next request restarts the server', async () => {
  const harness = start({ behavior: { exitAfterMs: 600 } });
  try {
    await initialize(harness);
    await createSession(harness);
    const down = await harness.waitNotificationFor(line => line.method === 'runtime.error', 5_000);
    assert.equal((params(down).data as { retryable: boolean }).retryable, true);
    const stale = await harness.request('session.get', { sessionId: 's_1' });
    assert.equal(result<{ session: { state: string } }>(stale).session.state, 'stale');
    await createSession(harness, 's_2');
    assert.equal(harness.fakeLog().filter(entry => entry.kind === 'start').length, 2);
  } finally { await harness.close(); }
});
