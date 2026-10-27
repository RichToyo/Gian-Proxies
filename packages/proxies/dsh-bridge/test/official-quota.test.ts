import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readDeepSeekBalance, type DeepSeekQuotaContext } from '../src/official-quota.js';

const env = { DSH_HOME: '/isolated/dsh', GIAN_AGENT_HOME: '/isolated/dsh' };
const selection = { model: null, provider: null, identityNonce: 'c'.repeat(64) };
function fixture(baseURL: string | null = 'https://api.deepseek.com/anthropic') {
  let resolutions = 0;
  let key = 'synthetic-key';
  const services: Record<string, unknown> = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-official' }) },
    llm: { listConfigurableProviders: () => [{ provider: 'deepseek-official', settingsNs: 'official', settingsPath: [] }] },
    settings: { describe: () => [{ ns: 'official', revision: 1, value: { baseURL, apiKeyEnv: 'DEEPSEEK_API_KEY' } }] },
    credentials: { resolve: async () => { resolutions++; return { value: key }; } },
  };
  const ctx: DeepSeekQuotaContext = { get: name => services[name] };
  return { ctx, resolutions: () => resolutions, change: () => { key = 'other-synthetic-key'; } };
}
const body = { is_available: false, balance_infos: [{ currency: 'CNY', total_balance: '0.00', granted_balance: '0', topped_up_balance: '0' }] };

test('DeepSeek queries only the fixed balance URL with a bounded 20-second deadline and no redirects', async t => {
  const f = fixture();
  const signal = new AbortController().signal;
  const deadline = t.mock.method(AbortSignal, 'timeout', (ms: number) => {
    assert.equal(ms, 20_000);
    return signal;
  });
  const request: typeof fetch = async (url, init) => {
    assert.equal(url, 'https://api.deepseek.com/user/balance');
    assert.equal(init?.redirect, 'error');
    assert.equal(init?.signal, signal);
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer synthetic-key');
    return Response.json(body);
  };
  const result = await readDeepSeekBalance(f.ctx, selection, request, env);
  assert.equal(result.status, 'ready');
  assert.equal(deadline.mock.callCount(), 1);
  assert.equal(JSON.stringify(result).includes('synthetic-key'), false);
  assert.deepEqual(result.balances, [{ currency: 'CNY', total: '0.00', granted: '0', toppedUp: '0' }]);
});
test('DeepSeek rejects third-party configurations before resolving any credential', async () => {
  const f = fixture('https://proxy.invalid/anthropic');
  const result = await readDeepSeekBalance(f.ctx, selection, async () => { throw Error('must not call'); }, env);
  assert.equal(result.status, 'excluded');
  assert.equal(f.resolutions(), 0);
  const ambient = fixture(null);
  const overridden = await readDeepSeekBalance(ambient.ctx, selection, async () => { throw Error('must not call'); },
    { ...env, DEEPSEEK_BASE_URL: 'https://proxy.invalid/anthropic' });
  assert.equal(overridden.status, 'excluded');
  assert.equal(ambient.resolutions(), 0);
});
test('DeepSeek drops in-flight balance after a credential switch and keeps malformed data unknown', async () => {
  const f = fixture();
  const switched = await readDeepSeekBalance(f.ctx, selection, async () => { f.change(); return Response.json(body); }, env);
  assert.equal(switched.status, 'error');
  assert.deepEqual(switched.balances, []);
  const invalid = await readDeepSeekBalance(f.ctx, selection, async () => Response.json({ ...body, balance_infos: [{ total_balance: 10 }] }), env);
  assert.equal(invalid.error, 'invalid_response');
});
