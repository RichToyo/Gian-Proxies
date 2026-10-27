import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeKimiOfficialQuota, queryKimiOfficialQuota, readKimiOfficialQuota } from '../src/core/official-quota.js';

const env = { KIMI_CODE_HOME: '/isolated/kimi', GIAN_AGENT_HOME: '/isolated/kimi', GIAN_RUNTIME_BIN: '/isolated/kimi-bin' };
const selection = { model: null, provider: null, identityNonce: 'c'.repeat(64) };
test('live Kimi account route checks model ownership and returns no account profile', async () => {
  const calls: string[] = [];
  const result = await queryKimiOfficialQuota(async path => {
    calls.push(path);
    if (path === '/api/v1/auth') return { managed_provider: { name: 'managed:kimi-code', status: 'authenticated' } };
    if (path === '/api/v1/config') return { default_model: 'official', models: { official: { provider: 'managed:kimi-code' } } };
    if (path.includes('/userinfo')) return { kind: 'ok', userInfo: { userId: 'fixture-user', phone: 'must-not-leak' } };
    if (path.includes('/usage')) return { kind: 'ok', quota: { usages: { limit7d: { usedRatio: 0.4 } } } };
    throw Error('Unexpected request');
  }, selection, env);
  assert.equal(result.status, 'ready');
  assert.equal(result.windows.length, 1);
  assert.equal(result.windows[0]?.id, 'limit7d');
  assert.equal(calls.some(path => path.includes('/sessions')), false);
  assert.equal(JSON.stringify(result).includes('fixture-user'), false);
  assert.equal(JSON.stringify(result).includes('must-not-leak'), false);
});
test('Kimi third-party model and missing login do not query quota', async () => {
  const result = await queryKimiOfficialQuota(async path => {
    if (path === '/api/v1/auth') return { managed_provider: { name: 'managed:kimi-code', status: 'authenticated' } };
    if (path === '/api/v1/config') return { default_model: 'external', models: { external: { provider: 'vendor' } } };
    throw Error('must not query');
  }, selection, env);
  assert.equal(result.status, 'excluded');
  assert.equal((await queryKimiOfficialQuota(async () => ({ managed_provider: null }), selection, env)).status, 'auth_required');
  const thirdPartyOnly = await queryKimiOfficialQuota(async path => {
    if (path === '/api/v1/auth') return { managed_provider: null };
    if (path === '/api/v1/config') return { default_model: 'external', models: { external: { provider: 'vendor' } } };
    throw Error('must not query');
  }, selection, env);
  assert.equal(thirdPartyOnly.status, 'excluded');
});

test('Kimi checks in-band kind and retains only actual windows and exact wallet decimals', () => {
  assert.throws(() => normalizeKimiOfficialQuota({ kind: 'error', status: 401, message: 'private details' }), /^Error: auth_required$/);
  const result = normalizeKimiOfficialQuota({ kind: 'ok', quota: { usages: { limit7d: { usedRatio: 1, resetAt: '2026-11-01T00:00:00Z' } },
    extraUsage: { balanceCents: 12345, currency: 'CNY' } } });
  assert.equal(result.windows.length, 1);
  assert.equal(result.windows[0]?.id, 'limit7d');
  assert.equal(result.balances[0]?.total, '123.45');
  assert.throws(() => normalizeKimiOfficialQuota({ kind: 'ok', quota: { usages: { limit5h: { usedRatio: '1' } } } }), /invalid_response/);
});
test('Kimi requires the bound managed identity and never submits prompts', async () => {
  const binding = { configHome: '/isolated/kimi', runtimeVersion: 'fixture', authRevision: 'identity', firstParty: true, verified: true };
  const paths: string[] = [];
  await readKimiOfficialQuota(binding, async path => {
    paths.push(path);
    return path === '/api/v1/auth' ? { managed_provider: { name: 'managed:kimi-code', status: 'authenticated' } }
      : { kind: 'ok', quota: { usages: { limit5h: { usedRatio: 0 } } } };
  });
  assert.deepEqual(paths, ['/api/v1/auth', '/api/v1/oauth/usage?provider=managed:kimi-code']);
  await assert.rejects(readKimiOfficialQuota({ ...binding, verified: false }, async () => { throw new Error('must not query'); }), /unsupported/);
});
