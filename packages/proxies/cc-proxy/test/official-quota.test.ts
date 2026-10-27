import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeClaudeOfficialQuota, queryClaudeOfficialQuota, type WithClaudeQuotaControl } from '../src/core/official-quota.js';
import { ClaudeProtocolV2Adapter } from '../src/protocol/v2-adapter.js';
import type { CcProxyService } from '../src/core/service.js';

const selection = { provider: null, model: null, identityNonce: 'a'.repeat(64) };
const account = { apiProvider: 'firstParty', email: 'fixture@example.invalid', organization: 'Fixture Org', subscriptionType: 'Claude Max' };
const usage = { subscription_type: 'max', rate_limits_available: true,
  rate_limits: { five_hour: { utilization: 20, resets_at: '2026-10-23T15:00:00Z' },
    seven_day: { utilization: 100, resets_at: null } },
  session: { model_usage: { ignored: { inputTokens: 999 } } }, behaviors: null };

function fixture(accounts: unknown[] = [account, account], response: unknown = usage) {
  let opens = 0;
  const requests: unknown[] = [];
  const control: WithClaudeQuotaControl = async read => {
    const index = opens++;
    return read(async request => {
      requests.push(request);
      if (request.subtype === 'initialize') return { account: accounts[index] ?? accounts.at(-1) };
      if (response instanceof Error) throw response;
      return response;
    });
  };
  return { control, requests, opens: () => opens };
}

test('Claude quota uses only initialize and get_usage with transcript scans disabled', async () => {
  const f = fixture();
  const result = await queryClaudeOfficialQuota(f.control, selection, '/isolated/claude');
  assert.equal(result.status, 'ready');
  assert.deepEqual(f.requests, [{ subtype: 'initialize', hooks: {} },
    { subtype: 'get_usage', skip_behaviors: true }, { subtype: 'initialize', hooks: {} }]);
  assert.equal(f.opens(), 2, 'identity is rechecked in a fresh metadata-only process');
  assert.match(result.authRevision!, /^[a-f0-9]{64}$/u);
  assert.equal(result.windows[0]?.usedRatio, 0.2);
  assert.equal(result.windows[1]?.usedRatio, 1);
  assert.doesNotMatch(JSON.stringify(result), /fixture@|Fixture Org|model_usage|behaviors|999|isolated/);
});

test('Claude excludes API-key and external providers before get_usage', async () => {
  for (const candidate of [{ ...account, apiProvider: 'gateway' }, { ...account, apiProvider: 'bedrock' },
    { ...account, subscriptionType: undefined, apiKeySource: 'ANTHROPIC_API_KEY' }, { ...account, subscriptionType: 'Claude API' }]) {
    const f = fixture([candidate]);
    assert.equal((await queryClaudeOfficialQuota(f.control, selection, '/isolated')).status, 'excluded');
    assert.equal(f.requests.length, 1);
  }
  const f = fixture();
  assert.equal((await queryClaudeOfficialQuota(f.control, { ...selection, provider: 'custom' }, '/isolated')).status, 'excluded');
  assert.equal(f.opens(), 0);
});

test('Claude lets the native plan check decide when a dormant API key and a subscription coexist', async () => {
  const candidate = { ...account, apiKeySource: 'ANTHROPIC_API_KEY' };
  assert.equal((await queryClaudeOfficialQuota(fixture([candidate, candidate]).control, selection, '/isolated')).status, 'ready');
  assert.equal((await queryClaudeOfficialQuota(fixture([candidate, candidate], { ...usage,
    subscription_type: null, rate_limits_available: false, rate_limits: null }).control, selection, '/isolated')).status, 'excluded');
});

test('Claude distinguishes missing login, unavailable plan data and absent native controls', async () => {
  assert.equal((await queryClaudeOfficialQuota(fixture([{ apiProvider: 'firstParty' }]).control, selection, '/isolated')).status, 'auth_required');
  const unavailable = await queryClaudeOfficialQuota(fixture(undefined, { ...usage, rate_limits: null }).control, selection, '/isolated');
  assert.equal(unavailable.status, 'error');
  assert.equal(unavailable.error, 'unavailable');
  const unsupported = await queryClaudeOfficialQuota(fixture(undefined, new Error('unsupported')).control, selection, '/isolated');
  assert.equal(unsupported.status, 'unsupported');
});

test('Claude discards results across account changes, including an unsuccessful read', async () => {
  for (const response of [usage, new Error('unavailable')]) {
    const f = fixture([account, { ...account, email: 'different@example.invalid' }], response);
    const result = await queryClaudeOfficialQuota(f.control, selection, '/isolated');
    assert.equal(result.status, 'error');
    assert.deepEqual(result.windows, []);
  }
});

test('Claude keeps unreported utilization unknown and never turns extra-spend caps into a balance', () => {
  const result = normalizeClaudeOfficialQuota({ five_hour: { utilization: null, resets_at: null },
    model_scoped: [{ display_name: 'Fixture', utilization: 50, resets_at: null }],
    extra_usage: { is_enabled: true, monthly_limit: 10000, used_credits: 500, utilization: 5 } });
  assert.equal(result.windows[0]?.usedRatio, null);
  assert.equal(result.windows[1]?.label, 'Weekly Fixture');
  assert.equal(result.windows[2]?.usedRatio, 0.05);
  assert.deepEqual(result.balances, []);
  for (const data of [{}, { five_hour: { utilization: 101 } }, { five_hour: { utilization: 1, resets_at: 'invalid' } },
    { model_scoped: [{ display_name: 'Invalid\nlabel', utilization: 1, resets_at: null }] }]) {
    assert.throws(() => normalizeClaudeOfficialQuota(data), /invalid_response/);
  }
});

test('Claude quota RPC negotiates only on 2.3 and rejects caller-supplied paths', async () => {
  for (const version of ['2.2', '2.3']) {
    let reads = 0;
    const service = { setEventSink() {}, readOfficialQuota: async () => {
      reads++;
      return { status: 'auth_required', authRevision: null, error: null, windows: [], balances: [] };
    } } as unknown as CcProxyService;
    const adapter = new ClaudeProtocolV2Adapter(service, '0.3.12-Dev', () => {});
    const init = await adapter.handle({ id: 'init', method: 'initialize', params: {
      protocol: { name: 'gian.proxy', versions: [version] }, host: { name: 'fixture', version: '0' },
    } }) as { capabilities: Record<string, number> };
    assert.equal(init.capabilities['account.quota.read'], version === '2.3' ? 1 : undefined);
    const request = { id: 'quota', method: 'account.quota.read', params: selection };
    if (version === '2.2') await assert.rejects(adapter.handle(request));
    else {
      await assert.rejects(adapter.handle({ ...request, params: { ...selection, configHome: '/arbitrary' } }));
      assert.equal(reads, 0);
      await adapter.handle(request);
      assert.equal(reads, 1);
    }
  }
});
