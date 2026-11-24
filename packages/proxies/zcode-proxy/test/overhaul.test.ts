/** ZCode 3.18 overhaul regressions: failed turns, usage labels, interrupt
 *  confirmation, scoped provider failures, startup errors, environment,
 *  idle stop, credential cipher answers and kit concurrency. */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { startHarness, type Harness, type OutgoingLine } from './harness.js';
import { answerCredentialCipherRequest, buildAppServerEnvironment } from '../src/inner/transport.js';
import { describeNativeTurnError } from '../src/events.js';

type Params = Record<string, unknown> & { data: Record<string, unknown> };
const paramsOf = (line: OutgoingLine): Params => line.payload.params as Params;

async function initialize(harness: Harness): Promise<void> {
  const response = await harness.request('initialize', {
    protocol: { name: 'gian.proxy', versions: ['2.1'] },
    host: { name: 'Gian', version: '0.0.0-test' },
  });
  assert.equal(response.kind, 'result', JSON.stringify(response.payload));
}

async function createSession(harness: Harness, sessionId = 's_1', cwd = '/tmp/zcode-ws'): Promise<string> {
  const created = await harness.request('session.create', {
    sessionId, workspace: { cwd, roots: [cwd] }, config: {},
  });
  assert.equal(created.kind, 'result', JSON.stringify(created.payload));
  return ((created.payload as { result: { session: { streamId: string } } }).result.session.streamId);
}

async function startTurn(harness: Harness, streamId: string, turnId: string, sessionId = 's_1') {
  return harness.request('turn.start', {
    sessionId, streamId, turnId, input: [{ type: 'text', text: turnId }], config: {},
  });
}

async function sessionState(harness: Harness, sessionId = 's_1'): Promise<string> {
  const snapshot = await harness.request('session.get', { sessionId });
  return ((snapshot.payload as { result: { session: { state: string } } }).result.session.state);
}

const FAILED_TURN = {
  turnId: 'turn_failed_native',
  events: [
    { seq: 1, eventId: 'evt_ts', payload: { kind: 'text_start', assistantMessageId: 'msg_f' } },
    { seq: 2, eventId: 'evt_td', payload: { kind: 'text_delta', assistantMessageId: 'msg_f', delta: 'partial' } },
    {
      seq: 3, eventId: 'evt_call_done', type: 'session.updated',
      payload: { content: 'partial', stopReason: 'error', contextWindow: 200_000,
        usage: { inputTokens: 1_200, outputTokens: 30, cacheReadTokens: 1_000, totalTokens: 1_230 } },
    },
    { channel: 'computer-use', kind: 'turn-failed', eventId: 'evt_turn_failed' },
    {
      seq: 4, eventId: 'evt_turn_failed', type: 'turn.failed', turnId: 'turn_failed_native',
      payload: {
        error: {
          type: 'model_error', code: 'provider_request_failed',
          message: 'Model request failed: upstream overloaded',
          attribution: { providerId: 'openai', modelId: 'gpt-5-mini', statusCode: 529, retryable: true },
        },
        turnPhase: 'model_streaming',
      },
    },
  ],
};

test('a 3.18 turn.failed ends the turn with native text and the session takes the next turn', async () => {
  const harness = startHarness({ scenario: { turn: FAILED_TURN } });
  try {
    await initialize(harness);
    const streamId = await createSession(harness);
    assert.equal((await startTurn(harness, streamId, 't_fail')).kind, 'result');
    const notifications = await harness.waitNotifications(7);
    assert.deepEqual(notifications.map((line) => line.method), [
      'turn.started', 'content.delta', 'content.delta', 'usage.updated',
      'content.completed', 'usage.updated', 'turn.failed',
    ]);
    const failed = paramsOf(notifications.at(-1)!).data.error as Record<string, unknown>;
    assert.equal(failed.domainCode, 'RUNTIME_ERROR');
    assert.match(String(failed.message), /upstream overloaded/);
    assert.equal(failed.retryable, true);
    assert.deepEqual(failed.details, {
      nativeType: 'model_error', nativeCode: 'provider_request_failed', statusCode: 529,
      turnPhase: 'model_streaming', providerId: 'openai', modelId: 'gpt-5-mini',
    });
    // Per-call usage is context occupancy, the turn total one delta.
    assert.deepEqual(paramsOf(notifications[3]!).data, { context: { used: 1_230, window: 200_000 } });
    assert.deepEqual(paramsOf(notifications[5]!).data, { conversation: {
      mode: 'delta', inputTokens: 1_200, outputTokens: 30, cachedInputTokens: 1_000, totalTokens: 1_230,
    } });
    assert.equal(notifications.filter((line) => line.method === 'activity.updated').length, 0,
      'the failure is not a generic succeeded activity');
    assert.equal(await sessionState(harness), 'idle');
    const next = await startTurn(harness, streamId, 't_after_fail');
    assert.equal(next.kind, 'result', `no SESSION_BUSY after a failed turn: ${JSON.stringify(next.payload)}`);
  } finally {
    await harness.close();
  }
});

test('a sign-in failure surfaces as RUNTIME_AUTH_REQUIRED with what to do', async () => {
  const harness = startHarness({ scenario: { turn: { turnId: 'turn_auth', events: [{
    seq: 1, eventId: 'evt_auth_failed', type: 'turn.failed', turnId: 'turn_auth',
    payload: { error: { type: 'model_error', message: 'Incorrect API key provided: sk-proj-abcdefghijklmnop',
      attribution: { statusCode: 401 } }, turnPhase: 'model_request' },
  }] } } });
  try {
    await initialize(harness);
    const streamId = await createSession(harness);
    await startTurn(harness, streamId, 't_auth');
    const failed = await harness.waitNotificationFor((line) => line.method === 'turn.failed');
    const error = paramsOf(failed).data.error as Record<string, unknown>;
    assert.equal(error.domainCode, 'RUNTIME_AUTH_REQUIRED');
    assert.equal(error.retryable, false);
    assert.match(String(error.message), /Incorrect API key/);
    assert.match(String(error.message), /zcode login|provider_config\.json/);
    assert.doesNotMatch(String(error.message), /abcdefghijklmnop/, 'secret-looking values stay redacted');
  } finally {
    await harness.close();
  }
});

test('native error classification keeps codes and recognizes Keychain and Zhipu auth failures', () => {
  const keychain = describeNativeTurnError({ type: 'CREDENTIAL_SECURE_STORAGE_UNAVAILABLE',
    message: 'System credential storage is unavailable.' }, null);
  assert.equal(keychain.domainCode, 'RUNTIME_AUTH_REQUIRED');
  assert.match(keychain.message, /Keychain/);
  const zhipu = describeNativeTurnError({ type: 'model_error', message: 'Token expired', // Zhipu sends this in Chinese; code 1003 decides
    attribution: { providerErrorCode: '1003' } }, 'model_request');
  assert.equal(zhipu.domainCode, 'RUNTIME_AUTH_REQUIRED');
  assert.equal(zhipu.details.providerCode, '1003');
  const quota = describeNativeTurnError({ type: 'model_error', message: 'No resource package',
    attribution: { providerErrorCode: '1113' } }, 'model_request');
  assert.equal(quota.domainCode, 'RUNTIME_ERROR');
  assert.equal(quota.details.providerCode, '1113');
});

const RUNNING_TURN = {
  turnId: 'turn_long',
  events: [
    { seq: 1, eventId: 'evt_long_start', payload: { kind: 'text_start', assistantMessageId: 'msg_l' } },
    { op: 'wait', ms: 4_000 },
    { seq: 2, eventId: 'evt_long_late', payload: { kind: 'text_delta', assistantMessageId: 'msg_l', delta: 'late' } },
  ],
};

test('a confirmed stop without a native terminal ends the turn as interrupted after the deadline', async () => {
  const harness = startHarness({
    scenario: { turn: RUNNING_TURN },
    env: { GIAN_ZCODE_INTERRUPT_DEADLINE_MS: '300' },
  });
  try {
    await initialize(harness);
    const streamId = await createSession(harness);
    await startTurn(harness, streamId, 't_long');
    await harness.waitNotificationFor((line) => line.method === 'turn.started');
    const interrupted = await harness.request('turn.interrupt', { sessionId: 's_1', streamId, turnId: 't_long' });
    assert.equal(interrupted.kind, 'result', JSON.stringify(interrupted.payload));
    const terminal = await harness.waitNotificationFor((line) => line.method === 'turn.completed', 3_000);
    assert.equal(paramsOf(terminal).data.stopReason, 'interrupted');
    assert.equal(await sessionState(harness), 'idle');
    // The native turn's late delta (after 4 s) must not reach the next turn.
    await new Promise((resolve) => setTimeout(resolve, 4_200));
    const late = harness.lines.filter((line) => line.kind === 'notification'
      && JSON.stringify(line.payload).includes('"late"'));
    assert.equal(late.length, 0, 'late native facts of the finished turn are dropped');
  } finally {
    await harness.close();
  }
});

test('a rejected stop fails turn.interrupt and keeps the turn running', async () => {
  const harness = startHarness({ scenario: { turn: RUNNING_TURN, behavior: { stopAcks: ['rejected'] } } });
  try {
    await initialize(harness);
    const streamId = await createSession(harness);
    await startTurn(harness, streamId, 't_long');
    await harness.waitNotificationFor((line) => line.method === 'turn.started');
    const interrupted = await harness.request('turn.interrupt', { sessionId: 's_1', streamId, turnId: 't_long' });
    assert.equal(interrupted.kind, 'error');
    assert.match(JSON.stringify(interrupted.payload), /did not stop the turn \(rejected/);
    assert.equal(await sessionState(harness), 'running');
  } finally {
    await harness.close();
  }
});

test('a stale foreground guard is retried unguarded once', async () => {
  const harness = startHarness({ scenario: {
    turn: { ...RUNNING_TURN, events: [
      { seq: 1, eventId: 'evt_fg', payload: { kind: 'text_start', assistantMessageId: 'msg_l', foregroundExecutionId: 'fg-1' } },
      { op: 'wait', ms: 4_000 },
    ] },
    behavior: { stopAcks: ['noop', 'accepted'] },
  } });
  try {
    await initialize(harness);
    const streamId = await createSession(harness);
    await startTurn(harness, streamId, 't_long');
    await harness.waitNotificationFor((line) => line.method === 'content.delta');
    const interrupted = await harness.request('turn.interrupt', { sessionId: 's_1', streamId, turnId: 't_long' });
    assert.equal(interrupted.kind, 'result');
    const stops = harness.fakeLog().filter((entry) => entry.kind === 'v4-command'
      && (entry.params as { type?: string }).type === 'stop')
      .map((entry) => (entry.params as { payload: Record<string, unknown> }).payload);
    assert.deepEqual(stops, [{ expectedForegroundExecutionId: 'fg-1' }, {}]);
  } finally {
    await harness.close();
  }
});

test('a provider stderr line defers to the typed terminal of the same turn', async () => {
  const harness = startHarness({ scenario: { turn: { turnId: 'turn_pbe', events: [
    { op: 'stderr', text: 'ProviderBusinessError: [1113][fixture][req]' },
    { op: 'wait', ms: 150 },
    { seq: 1, eventId: 'evt_pbe_failed', type: 'turn.failed', turnId: 'turn_pbe',
      payload: { error: { type: 'model_error', message: 'Insufficient balance or no resource package.' }, turnPhase: 'model_request' } },
  ] } } });
  try {
    await initialize(harness);
    const streamId = await createSession(harness);
    await startTurn(harness, streamId, 't_pbe');
    const failed = await harness.waitNotificationFor((line) => line.method === 'turn.failed');
    const error = paramsOf(failed).data.error as { message: string; details: Record<string, unknown> };
    assert.match(error.message, /Insufficient balance/, 'the typed native text wins');
    assert.equal(error.details.providerCode, '1113', 'the stderr hint only adds the provider code');
    await new Promise((resolve) => setTimeout(resolve, 3_300));
    assert.equal(harness.lines.filter((line) => line.method === 'turn.failed' || line.method === 'turn.completed').length, 0,
      'exactly one terminal');
  } finally {
    await harness.close();
  }
});

test('a Runtime that cannot start fails initialize with its own stderr', async () => {
  const harness = startHarness({ scenario: { behavior: { exitOnStart: {
    code: 3, stderr: 'Error: ENOENT zcode-builtin.json missing (fixture)',
  } } } });
  try {
    const response = await harness.request('initialize', {
      protocol: { name: 'gian.proxy', versions: ['2.1'] },
      host: { name: 'Gian', version: '0.0.0-test' },
    });
    assert.equal(response.kind, 'error');
    const error = (response.payload as { error: { message: string; data: { domainCode: string } } }).error;
    assert.equal(error.data.domainCode, 'RUNTIME_UNAVAILABLE');
    assert.match(error.message, /exited \(code 3/);
    assert.match(error.message, /zcode-builtin\.json missing \(fixture\)/);
  } finally {
    await harness.close();
  }
});

test('the app-server inherits the user environment minus Gian internals and keeps the HOME contract', async () => {
  const harness = startHarness({ scenario: {}, env: {
    SHELL: '/bin/zsh', HTTPS_PROXY: 'http://127.0.0.1:6152', NO_PROXY: 'localhost',
    GIAN_AGENT_HOME: '/must/not/leak', NODE_OPTIONS: '--inspect', ZCODE_TEST_PASSTHROUGH: 'yes',
  } });
  try {
    await initialize(harness);
    const start = harness.fakeLog().find((entry) => entry.kind === 'start');
    const env = start?.env as Record<string, string | null>;
    assert.equal(env.HOME, harness.dir);
    assert.equal(env.SHELL, '/bin/zsh');
    assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:6152');
    assert.equal(env.NO_PROXY, 'localhost');
    assert.equal(env.ZCODE_TEST_PASSTHROUGH, 'yes');
    assert.equal(env.GIAN_PLUGIN_ID, 'com.zhipu.zcode');
    assert.equal(env.GIAN_AGENT_HOME, null);
    assert.equal(env.GIAN_RUNTIME_BIN, null);
    assert.equal(env.NODE_OPTIONS, null);
    assert.ok(String(env.PATH).split(':').includes('/opt/homebrew/bin'));
  } finally {
    await harness.close();
  }
  const built = buildAppServerEnvironment({ HOME: '/real', PATH: '/custom/bin:/usr/bin', GIAN_X: '1' }, { home: '/agent' });
  assert.equal(built.HOME, '/agent');
  assert.equal(built.GIAN_X, undefined);
  assert.equal(built.PATH?.split(':')[0], '/custom/bin', 'the inherited PATH order wins');
});

test('an idle app-server stops and transparently restarts with the next request', async () => {
  const harness = startHarness({
    scenario: { behavior: { persistSessions: true }, turn: {
      turnId: 'turn_after_idle',
      events: [{ seq: 1, eventId: 'evt_idle_done', payload: { resultType: 'success' } }],
    } },
    env: { GIAN_ZCODE_IDLE_TIMEOUT_MS: '400' },
  });
  try {
    await initialize(harness);
    const streamId = await createSession(harness);
    const firstPid = harness.fakeLog().find((entry) => entry.method === 'v4/command')?.pid;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    assert.equal(await sessionState(harness), 'idle', 'idle stop keeps the session attached');
    assert.equal((await startTurn(harness, streamId, 't_after_idle')).kind, 'result');
    const terminal = await harness.waitNotificationFor((line) => line.method === 'turn.completed');
    assert.equal(paramsOf(terminal).streamId, streamId, 'the stream continues');
    const sends = harness.fakeLog().filter((entry) => entry.kind === 'v4-command'
      && (entry.params as { type?: string }).type === 'sendText');
    assert.notEqual(sends.at(-1)?.pid, firstPid, 'the turn ran on a restarted app-server');
    const resumes = harness.fakeLog().filter((entry) => entry.method === 'session/resume' && entry.pid === sends.at(-1)?.pid);
    assert.equal(resumes.length, 1, 'the session was re-attached before the turn');
  } finally {
    await harness.close();
  }
});

test('the idle stop waits for a background task the turn left running', async () => {
  const harness = startHarness({
    scenario: {
      turns: [
        { turnId: 'turn_bg', events: [
          { seq: 1, eventId: 'evt_bg_start', type: 'background_task_started', payload: { taskId: 'bg-1', taskKind: 'bash', status: 'running', command: 'sleep 600' } },
          { seq: 2, eventId: 'evt_bg_turn_done', payload: { resultType: 'success' } },
          // A silent background command: no events for longer than the idle timeout.
          { op: 'wait', ms: 1_500 },
          { seq: 3, eventId: 'evt_bg_end', type: 'background_task_completed', payload: { taskId: 'bg-1', taskKind: 'bash', status: 'completed' } },
        ] },
        { turnId: 'turn_during_bg', events: [{ seq: 4, eventId: 'evt_during_done', payload: { resultType: 'success' } }] },
      ],
    },
    env: { GIAN_ZCODE_IDLE_TIMEOUT_MS: '300' },
  });
  const sendPids = () => harness.fakeLog()
    .filter((entry) => entry.kind === 'v4-command' && (entry.params as { type?: string }).type === 'sendText')
    .map((entry) => entry.pid);
  const turnDone = (turnId: string) => harness.waitNotificationFor((line) => (
    line.method === 'turn.completed' && (line.payload.params as { turnId?: string }).turnId === turnId
  ));
  // Every idle stop the proxy starts is reported on its stderr.
  const idleStops = () => harness.lastStderr.split('"kind":"idle-stop"').length - 1;
  try {
    await initialize(harness);
    const streamId = await createSession(harness);
    assert.equal((await startTurn(harness, streamId, 't_bg')).kind, 'result');
    await turnDone('t_bg');
    // Well past the idle timeout, while the background task still runs.
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.equal((await startTurn(harness, streamId, 't_during')).kind, 'result');
    await turnDone('t_during');
    assert.equal(sendPids()[1], sendPids()[0], 'the app-server was stopped while a background task was running');

    // Once the task has ended, the idle stop applies again. (The catalog
    // app-server's own idle stop happened long before this baseline.)
    const before = idleStops();
    const deadline = Date.now() + 5_000;
    while (idleStops() === before && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(idleStops(), before + 1, 'the idle app-server was stopped after the background task ended');
  } finally {
    await harness.close();
  }
});

test('credential cipher requests get the upstream Host answer without a key', async () => {
  const requestId = '0b6f3c2e-7a59-4a8e-9b1a-2f4d6c8e0a12';
  assert.deepEqual(answerCredentialCipherRequest({ requestId: 'nope', operation: 'decrypt', value: 'x' }),
    { error: { code: -32602, message: 'Credential cipher is unavailable' } });
  const harness = startHarness({ scenario: { behavior: {
    cipherRequest: { requestId, operation: 'decrypt', value: 'enc:v2:os:0123456789abcdef01234567:a.b.c' },
  } } });
  try {
    await initialize(harness);
    await createSession(harness);
    const answer = harness.fakeLog().find((entry) => entry.kind === 'cipher-answer')?.answer as Record<string, unknown>;
    assert.deepEqual((answer.result as Record<string, unknown>).requestId, requestId);
    assert.deepEqual(((answer.result as { result: { ok: boolean; error: { code: string } } }).result.ok), false);
    assert.equal(((answer.result as { result: { error: { code: string } } }).result.error.code),
      'CREDENTIAL_SECURE_STORAGE_UNAVAILABLE');
  } finally {
    await harness.close();
  }
});

test('a slow turn.start in one session does not block other requests', async () => {
  const harness = startHarness({ scenario: { behavior: { sendAckDelayMs: 1_500 }, turn: { events: [] } } });
  try {
    await initialize(harness);
    const streamId = await createSession(harness);
    const started = Date.now();
    const turn = startTurn(harness, streamId, 't_slow');
    const catalog = await harness.request('catalog.list', {});
    assert.equal(catalog.kind, 'result');
    assert.ok(Date.now() - started < 1_200, 'catalog.list answered while turn.start was blocked');
    assert.equal((await turn).kind, 'result');
  } finally {
    await harness.close();
  }
});

test('replay reports one usage per turn: a delta for session.replay, context for live attach', async () => {
  const { buildReplayEvents } = await import('../src/adapter.js');
  const messages = [
    { info: { role: 'user', messageId: 'u1', time: { created: 1 } }, parts: [{ type: 'text', text: 'hi' }] },
    { info: { role: 'assistant', messageId: 'a1', parentMessageId: 'u1', time: { created: 2 },
      tokens: { input: 100, output: 10, reasoning: 5, cache: { read: 40, write: 0 } } }, parts: [{ type: 'text', text: 'one' }] },
    { info: { role: 'assistant', messageId: 'a2', parentMessageId: 'u1', time: { created: 3 },
      tokens: { input: 20, output: 4, reasoning: 0, cache: { read: 150, write: 0 } } }, parts: [{ type: 'text', text: 'two' }] },
  ];
  const usageOf = (mode: 'delta' | 'context') => buildReplayEvents({
    gianSessionId: 's', streamId: '', nativeSessionId: 'n', messages, usage: mode,
  }).filter((event) => event.method === 'usage.updated').map((event) => event.data);
  assert.deepEqual(usageOf('delta'), [{ conversation: {
    mode: 'delta', inputTokens: 310, outputTokens: 19, cachedInputTokens: 190, totalTokens: 329,
  } }]);
  assert.deepEqual(usageOf('context'), [{ context: { used: 174 } }]);
});
