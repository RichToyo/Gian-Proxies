import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeGrokOfficialQuota, queryGrokOfficialQuota, type GrokQuotaMethod } from '../src/core/official-quota.js';
import { GrokProxyService } from '../src/core/service.js';
import type { GrokAcpClient } from '../src/runtime/grok-acp-client.js';
import { GrokProtocolV2Adapter } from '../src/protocol/v2-adapter.js';

const env = { GROK_HOME: '/isolated/grok', GIAN_AGENT_HOME: '/isolated/grok', GIAN_RUNTIME_BIN: '/isolated/bin/grok' };
const selection = { provider: null, model: null, identityNonce: 'a'.repeat(64) };
const initialized = { _meta: { grokShell: true, agentVersion: '1.0.62' },
  authMethods: [{ id: 'cached_token' }, { id: 'grok.com' }] };
const auth = { methodId: 'cached_token', email: 'fixture@example.invalid', principalId: 'fixture-user', teamId: null,
  organizationId: null, principalType: 'user' };
const billing = { config: { creditUsagePercent: 25, currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY',
  start: '2026-10-19T00:00:00Z', end: '2026-10-26T00:00:00Z' }, prepaidBalance: { val: 1234 } } };

test('Grok native quota uses only account controls and returns no profile', async () => {
  const calls: GrokQuotaMethod[] = [];
  const result = await queryGrokOfficialQuota(initialized, async method => {
    calls.push(method);
    return method === 'x.ai/auth/info' ? auth : billing;
  }, selection, env);
  assert.equal(result.status, 'ready');
  assert.match(result.authRevision!, /^[a-f0-9]{64}$/u);
  assert.deepEqual(calls, ['x.ai/auth/info', 'x.ai/billing', 'x.ai/auth/info']);
  assert.deepEqual(result.windows, [{ id: 'included', label: 'Weekly', usedRatio: 0.25,
    resetAt: Date.parse('2026-10-26T00:00:00Z'), windowDurationMinutes: 10_080 }]);
  assert.deepEqual(result.balances, [{ currency: 'USD', total: '12.34', granted: null, toppedUp: null }]);
  assert.doesNotMatch(JSON.stringify(result), /fixture-user|example.invalid|isolated/);
});

test('Grok rejects unbound HOME, third-party selection and enterprise without reading billing', async () => {
  const never = async () => { throw Error('must not query'); };
  assert.equal((await queryGrokOfficialQuota(initialized, never, selection, {})).status, 'unsupported');
  assert.equal((await queryGrokOfficialQuota(initialized, never, { ...selection, provider: 'custom' }, env)).status, 'excluded');
  assert.equal((await queryGrokOfficialQuota({ ...initialized,
    authMethods: [...initialized.authMethods, { id: 'oidc' }] }, never, selection, env)).status, 'excluded');
  assert.equal((await queryGrokOfficialQuota(initialized, async method => {
    assert.equal(method, 'x.ai/auth/info');
    return { ...auth, methodId: 'xai.api_key' };
  }, selection, env)).status, 'excluded');
});

test('Grok uses the active subscription even when an unused API-key method is also offered', async () => {
  const result = await queryGrokOfficialQuota({ ...initialized,
    authMethods: [...initialized.authMethods, { id: 'xai.api_key' }] },
  async method => method === 'x.ai/auth/info' ? auth : billing, selection, env);
  assert.equal(result.status, 'ready');
});

test('Grok missing login, unknown interface and malformed data stay distinct', async () => {
  assert.equal((await queryGrokOfficialQuota(initialized, async () => ({ methodId: null }), selection, env)).status, 'auth_required');
  assert.equal((await queryGrokOfficialQuota(initialized, async () => { throw { code: -32601 }; }, selection, env)).status, 'unsupported');
  assert.equal((await queryGrokOfficialQuota(initialized, async () => { throw { code: -32000 }; }, selection, env)).status, 'auth_required');
  const malformed = await queryGrokOfficialQuota(initialized, async () => ({}), selection, env);
  assert.equal(malformed.status, 'error');
  assert.equal(malformed.error, 'invalid_response');
});

test('Grok never publishes a prior account value after success or failure races', async () => {
  for (const fail of [false, true]) {
    let switched = false;
    const result = await queryGrokOfficialQuota(initialized, async method => {
      if (method === 'x.ai/auth/info') return { ...auth, principalId: switched ? 'other-user' : auth.principalId };
      switched = true;
      if (fail) throw Error('unavailable');
      return billing;
    }, selection, env);
    assert.equal(result.status, 'error');
    assert.deepEqual(result.windows, []);
    assert.deepEqual(result.balances, []);
  }
});

test('Grok respects actual periods and handles exact cents without inventing monthly or weekly quota', () => {
  assert.equal(normalizeGrokOfficialQuota({ config: { creditUsagePercent: 0 } }).windows[0]?.label, 'Current period');
  assert.equal(normalizeGrokOfficialQuota({ config: { monthlyLimit: { val: 100 }, used: { val: 150 } } }).windows[0]?.usedRatio, 1);
  assert.deepEqual(normalizeGrokOfficialQuota({ config: { prepaidBalance: {} } }).balances,
    [{ currency: 'USD', total: '0.00', granted: null, toppedUp: null }]);
  assert.equal(normalizeGrokOfficialQuota({ config: { prepaidBalance: { val: '9007199254740993' } } }).balances[0]?.total, '90071992547409.93');
  assert.equal(normalizeGrokOfficialQuota({ config: { prepaidBalance: { val: -1 } } }).balances[0]?.total, '-0.01');
  for (const config of [{}, { history: [{ totalUsed: { val: 100 } }] }, { creditUsagePercent: 101 },
    { creditUsagePercent: 1, currentPeriod: { end: 'invalid' } }, { prepaidBalance: { val: 1.5 } },
    { prepaidBalance: { val: Number.MAX_SAFE_INTEGER + 1 } }]) {
    assert.throws(() => normalizeGrokOfficialQuota({ config }), /invalid_response/);
  }
});

test('Grok quota inspection always disposes its separate child on success and failure', async () => {
  for (const fail of [false, true]) {
    let stopped = 0;
    const service = new GrokProxyService({ binaryPath: '/isolated/bin/grok', createRuntime: () => ({
      readOfficialQuota: async () => {
        if (fail) throw Error('unavailable');
        return { status: 'ready', authRevision: 'b'.repeat(64), error: null, ...normalizeGrokOfficialQuota(billing) };
      },
      stop: async (options: { force: boolean }) => { assert.equal(options.force, true); stopped++; },
    } as unknown as GrokAcpClient) });
    assert.equal((await service.readOfficialQuota(selection)).status, fail ? 'error' : 'ready');
    assert.equal(stopped, 1);
  }
});

test('Grok quota capability is negotiated only on 2.3 and rejects unsafe parameters', async () => {
  for (const version of ['2.2', '2.3']) {
    let reads = 0;
    const service = { setEventSink() {}, probeInterjectSupport: async () => false,
      readOfficialQuota: async () => { reads++; return { status: 'auth_required', authRevision: null, error: null, windows: [], balances: [] }; },
    } as unknown as GrokProxyService;
    const adapter = new GrokProtocolV2Adapter(service, '0.3.13-Dev', () => {});
    const init = await adapter.handle({ id: 'init', method: 'initialize',
      params: { protocol: { name: 'gian.proxy', versions: [version] } } }) as { capabilities: Record<string, number> };
    assert.equal(init.capabilities['account.quota.read'], version === '2.3' ? 1 : undefined);
    const request = { id: 'quota', method: 'account.quota.read', params: selection };
    if (version === '2.2') await assert.rejects(adapter.handle(request));
    else {
      await assert.rejects(adapter.handle({ ...request, params: { ...selection, url: 'https://invalid.test' } }));
      assert.equal(reads, 0);
      await adapter.handle(request);
      assert.equal(reads, 1);
    }
  }
});
