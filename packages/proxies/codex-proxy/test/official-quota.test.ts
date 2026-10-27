import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeCodexOfficialQuota, queryCodexOfficialQuota, readCodexOfficialQuota } from '../src/core/official-quota.js';

const binding = { configHome: '/isolated/codex', runtimeVersion: 'fixture', authRevision: 'identity-1', firstParty: true, verified: true };
const quotaEnv = { CODEX_HOME: '/isolated/codex', GIAN_AGENT_HOME: '/isolated/codex', GIAN_RUNTIME_BIN: '/isolated/codex-bin' };
const selection = { model: null, provider: null, identityNonce: 'c'.repeat(64) };

test('live Codex control route qualifies twice and never creates a thread or model turn', async () => {
  const calls: string[] = [];
  const result = await queryCodexOfficialQuota(async method => {
    calls.push(method);
    if (method === 'config/read') return { config: { model_provider: 'openai' } };
    if (method === 'account/read') return { requiresOpenaiAuth: true, account: { type: 'chatgpt', email: 'fixture@example.invalid' } };
    return { rateLimits: { primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 500 } } };
  }, selection, quotaEnv);
  assert.equal(result.status, 'ready');
  assert.equal(result.windows[0]?.usedRatio, 1);
  assert.match(result.authRevision!, /^[a-f0-9]{64}$/u);
  assert.deepEqual(calls, ['config/read', 'account/read', 'account/rateLimits/read', 'config/read', 'account/read']);
  assert.equal(JSON.stringify(result).includes('fixture@example.invalid'), false);
});

test('live Codex control excludes third-party routing before any quota request', async () => {
  for (const config of [{ model_provider: 'third-party' }, { model_provider: 'openai', model_providers: { openai: { base_url: 'https://proxy.invalid' } } }]) {
    const calls: string[] = [];
    const result = await queryCodexOfficialQuota(async method => { calls.push(method); return { config }; }, selection, quotaEnv);
    assert.equal(result.status, 'excluded');
    assert.deepEqual(calls, ['config/read']);
  }
  assert.equal((await queryCodexOfficialQuota(async () => { throw Error('must not call'); }, selection, {})).status, 'unsupported');
});

test('malformed native account data stays an error, not proof to hide the Agent', async () => {
  const result = await queryCodexOfficialQuota(async method => {
    if (method === 'config/read') return { config: {} };
    if (method === 'account/read') return { unexpected: 'not an account snapshot' };
    throw Error('must not query');
  }, selection, quotaEnv);
  assert.equal(result.status, 'error');
  assert.equal(result.error, 'invalid_response');
});

test('live Codex control drops a quota response when the account changes in flight', async () => {
  let reads = 0;
  const result = await queryCodexOfficialQuota(async method => {
    if (method === 'config/read') return { config: {} };
    if (method === 'account/read') return { requiresOpenaiAuth: true, account: { type: 'chatgpt', email: `${reads++}@fixture.invalid` } };
    return { rateLimits: { primary: { usedPercent: 10 } } };
  }, selection, quotaEnv);
  assert.equal(result.status, 'error');
  assert.deepEqual(result.windows, []);
});

test('Codex rechecks identity on failed quota requests before permitting stale cache reuse', async () => {
  let identity = 'first@fixture.invalid';
  let failing = false;
  const request: Parameters<typeof queryCodexOfficialQuota>[0] = async method => {
    if (method === 'config/read') return { config: {} };
    if (method === 'account/read') return { requiresOpenaiAuth: true, account: { type: 'chatgpt', email: identity } };
    if (failing) {
      identity = 'second@fixture.invalid';
      throw Object.assign(new Error('private response must not leak'), { status: 429 });
    }
    return { rateLimits: { primary: { usedPercent: 10 } } };
  };
  const first = await queryCodexOfficialQuota(request, selection, quotaEnv);
  failing = true;
  const failed = await queryCodexOfficialQuota(request, selection, quotaEnv);
  assert.equal(failed.error, 'rate_limited');
  assert.notEqual(failed.authRevision, first.authRevision);
  assert.equal(JSON.stringify(failed).includes('private response'), false);
});
test('Codex native quota is account-scoped, window-aware, and never calls account token usage', async () => {
  const calls: string[] = [];
  const result = await readCodexOfficialQuota(binding, async method => {
    calls.push(method);
    return method === 'account/read' ? { account: { type: 'chatgpt', email: 'must-not-leak@example.com' }, requiresOpenaiAuth: true }
      : { rateLimits: { primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 2_000 } } };
  });
  assert.deepEqual(calls, ['account/read', 'account/rateLimits/read']);
  assert.equal(result.windows[0]?.usedRatio, 0.25);
  assert.equal(result.windows[0]?.resetAt, 2_000_000);
  assert.equal(result.windows.length, 1);
  assert.equal(JSON.stringify(result).includes('must-not-leak'), false);
});
test('Codex rejects unqualified/default HOME, API-key identity and malformed percentages', async () => {
  let calls = 0;
  await assert.rejects(readCodexOfficialQuota({ ...binding, configHome: '' }, async () => { calls++; }), /unsupported/);
  assert.equal(calls, 0);
  await assert.rejects(readCodexOfficialQuota(binding, async () => ({ account: { type: 'apiKey' }, requiresOpenaiAuth: true })), /unsupported/);
  assert.throws(() => normalizeCodexOfficialQuota({ rateLimits: { primary: { usedPercent: NaN } } }), /invalid_response/);
  const multiple = normalizeCodexOfficialQuota({ rateLimits: { primary: { usedPercent: 99 } }, rateLimitsByLimitId: {
    codex: { primary: { usedPercent: 100, windowDurationMins: 15, resetsAt: null }, secondary: null },
  } });
  assert.equal(multiple.windows.length, 1);
  assert.equal(multiple.windows[0]?.label, '15 min');
});
