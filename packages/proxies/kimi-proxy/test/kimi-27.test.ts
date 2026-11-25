/** Unit coverage for the Kimi Code 2.7 specific pieces of the Proxy. */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { KimiConversationBinding } from '../src/runtime/conversation-binding.js';
import { KimiConversationChannel } from '../src/runtime/conversation-channel.js';
import { conversationTurnError, isKimiAuthCode } from '../src/runtime/conversation-error.js';
import { KimiConversationSettlement } from '../src/runtime/conversation-settlement.js';
import { bindKimiCodeHome, kimiChildEnvironment, resolveKimiCodeHome } from '../src/runtime/home.js';
import { parseReadyLine } from '../src/runtime/server-supervisor.js';
import { assertSupportedKimiVersion, parseKimiVersion } from '../src/runtime/versions.js';
import { normalizeKimiError } from '../src/core/service.js';
import { KimiApiError } from '../src/runtime/rest-client.js';

test('GIAN_AGENT_HOME wins over the bridged KIMI_CODE_HOME, then KIMI_CODE_HOME, then ~/.kimi-code', () => {
  assert.equal(resolveKimiCodeHome({ GIAN_AGENT_HOME: '/agent', KIMI_CODE_HOME: '/bridge', HOME: '/u' }), '/agent');
  assert.equal(resolveKimiCodeHome({ GIAN_AGENT_HOME: 'relative', KIMI_CODE_HOME: '/bridge', HOME: '/u' }), '/bridge');
  assert.equal(resolveKimiCodeHome({ HOME: '/u' }), '/u/.kimi-code');
  const env: NodeJS.ProcessEnv = { GIAN_AGENT_HOME: '/agent', KIMI_CODE_HOME: '/bridge' };
  bindKimiCodeHome(env);
  assert.equal(env.KIMI_CODE_HOME, '/agent');
  const child = kimiChildEnvironment({ GIAN_AGENT_HOME: '/agent', PATH: '/bin' });
  assert.equal(child.KIMI_CODE_HOME, '/agent');
  assert.equal(child.KIMI_CODE_NO_AUTO_UPDATE, '1');
  assert.equal(child.PATH, '/bin');
});

test('only reviewed 2.7 releases are supported', () => {
  assert.equal(parseKimiVersion('2.7.2\n'), '2.7.2');
  assertSupportedKimiVersion('2.7.1');
  assertSupportedKimiVersion('2.7.2');
  for (const version of ['2.7.0', '2.6.3', '2.3.3', '2.7.3', '2.7.2-canary.1']) {
    assert.throws(() => assertSupportedKimiVersion(version), /is not supported by this Proxy\. Use Kimi Code 2\.7\.1 or 2\.7\.2/);
    assert.throws(() => assertSupportedKimiVersion(version), (error: Error & { domainCode?: string }) => error.domainCode === 'RUNTIME_UNAVAILABLE');
  }
});

test('the `kimi web --json` ready line yields a loopback endpoint and its private token', () => {
  // Shape captured from the real 2.7.2 binary (token redacted).
  assert.deepEqual(parseReadyLine('{"origin":"http://127.0.0.1:54594","ws_url":"ws://127.0.0.1:54594/api/v1/ws","token":"t0k","kimi_agent_protocol_version":"1.0.0"}'),
    { baseUrl: 'http://127.0.0.1:54594', token: 't0k' });
  assert.throws(() => parseReadyLine('Kimi server: http://127.0.0.1:1/#token=x'), /not JSON/);
  assert.throws(() => parseReadyLine('{"origin":"http://10.0.0.2:1","token":"x"}'), /non-loopback/);
  assert.throws(() => parseReadyLine('{"origin":"http://127.0.0.1:1","token":""}'), /no origin or token/);
});

test('native auth failures become RUNTIME_AUTH_REQUIRED; others keep their code and text', () => {
  for (const code of ['auth.login_required', 'auth.token_unauthorized', 'auth.model_not_resolved', 'provider.auth_error']) assert.equal(isKimiAuthCode(code), true);
  assert.equal(isKimiAuthCode('provider.rate_limit'), false);
  const auth = conversationTurnError({ code: 'auth.login_required', message: 'Not logged in.' }, 'error');
  assert.equal(auth.domainCode, 'RUNTIME_AUTH_REQUIRED');
  assert.match(auth.message, /^Not logged in\. Sign in to Kimi Code/);
  assert.equal(auth.retryable, false);
  const filtered = conversationTurnError(undefined, 'filtered');
  assert.deepEqual(filtered, { domainCode: 'RUNTIME_ERROR', message: 'The model provider filtered the Kimi response.', retryable: false, details: { endReason: 'filtered' } });
  const rest = normalizeKimiError(new KimiApiError({ code: 40113, msg: 'model not resolved', httpStatus: 200, requestId: null }));
  assert.equal(rest.domainCode, 'RUNTIME_AUTH_REQUIRED');
  assert.match(rest.message, /model not resolved\. Sign in to Kimi Code/);
  assert.deepEqual(rest.details, { nativeCode: 40113, httpStatus: 200 });
});

test('global 2.7 session events reach only attached sessions, tagged with their native id', async () => {
  const received: Record<string, unknown>[] = [];
  const channel = new KimiConversationChannel(() => undefined, frame => received.push(frame));
  const ack = channel.subscribe('s1');
  channel.receive('{"type":"response","request_id":"gian-1","code":0}');
  channel.receive(JSON.stringify({ type: 'turns', session_id: 's1', agent_id: 'main', turns: [], has_more: false }));
  await ack;
  channel.receive(JSON.stringify({ type: 'session', change: 'updated', session: { id: 's2', activity: 'turn' }, event_created_at: 't' }));
  channel.receive(JSON.stringify({ type: 'session', change: 'updated', session: { id: 's1', activity: 'background' }, event_created_at: 't' }));
  channel.receive(JSON.stringify({ type: 'config', config: {}, event_created_at: 't' }));
  assert.deepEqual(received.slice(1), [{ type: 'session', change: 'updated', session: { id: 's1', activity: 'background' }, event_created_at: 't', session_id: 's1' }]);
});

test('settlement treats background activity as busy and an ended main agent as idle', () => {
  const state = new KimiConversationSettlement('s1');
  const frame = (value: Record<string, unknown>) => ({ session_id: 's1', agent_id: 'main', ...value });
  const session = (activity: string, pending = 'none') => ({ type: 'session', change: 'updated', session_id: 's1', session: { id: 's1', activity, pending_interaction: pending } });
  state.receive(frame({ type: 'task.list', tasks: [] }));
  state.turnStarted();
  state.receive(frame({ type: 'task', task_id: 'bg', status: 'running' }));
  state.turnFinished();
  state.receive(frame({ type: 'task', task_id: 'bg', status: 'ended', outcome: 'completed' }));
  state.receive(frame({ type: 'agent', status: 'ended' }));
  state.receive(session('background'));
  assert.equal(state.canFinish(false), false);
  state.receive(session('idle', 'approval'));
  assert.equal(state.canFinish(false), false);
  state.receive(session('idle'));
  assert.equal(state.canFinish(false), true);
  assert.throws(() => state.receive(session('busy')), /work state/);
});

test('a queued prompt ignores the foreign turn that finishes first and binds its own opener', () => {
  const delivered: Record<string, unknown>[] = [];
  const binding = new KimiConversationBinding('s1', 'ours', frame => delivered.push(frame));
  const frame = (value: Record<string, unknown>) => ({ session_id: 's1', agent_id: 'main', ...value });
  binding.receive(frame({ type: 'turn.started', turn: { turn_id: 'notice-turn' } }));
  assert.equal(binding.hasUnbound(), true);
  binding.receive(frame({ type: 'turn.ended', turn: { turn_id: 'notice-turn', status: 'ended', outcome: 'completed' } }));
  assert.equal(binding.hasUnbound(), false, 'an ended unclaimed turn before our opener is foreign');
  binding.receive(frame({ type: 'turn.started', turn: { turn_id: 'our-turn' } }));
  binding.receive(frame({ type: 'item.ended', turn_id: 'our-turn', item: { type: 'user_message', placement: 'opener', prompt_ids: ['ours'] } }));
  assert.deepEqual(delivered.map(value => value.type), ['turn.started', 'item.ended']);
  assert.equal(binding.isBound(), true);
});
