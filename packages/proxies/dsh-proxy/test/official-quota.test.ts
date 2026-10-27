import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeDeepSeekOfficialBalance, readDeepSeekOfficialBalance } from '../src/core/official-quota.js';

const raw = { is_available: false, balance_infos: [
  { currency: 'CNY', total_balance: '0.00', granted_balance: '0.00', topped_up_balance: '0.00' },
  { currency: 'USD', total_balance: '123456789012345.12345', granted_balance: '0', topped_up_balance: '123456789012345.12345' },
] };
test('DeepSeek keeps currency-separated decimal strings even when depleted', () => {
  const result = normalizeDeepSeekOfficialBalance(raw);
  assert.equal(result.balances.length, 2);
  assert.equal(result.balances[1]?.total, '123456789012345.12345');
  assert.deepEqual(result.windows, []);
  assert.throws(() => normalizeDeepSeekOfficialBalance({ ...raw, balance_infos: [{ ...raw.balance_infos[0], total_balance: 0 }] }), /invalid_response/);
});
test('DeepSeek accepts only fixed official URLs and a qualified controlled credential binding', async () => {
  const binding = { baseUrl: 'https://api.deepseek.com/v1', configHome: '/isolated/dsh', runtimeVersion: 'fixture', authRevision: 'identity', firstParty: true, verified: true };
  let target = '';
  await readDeepSeekOfficialBalance(binding, async url => { target = url; return raw; });
  assert.equal(target, 'https://api.deepseek.com/user/balance');
  await assert.rejects(readDeepSeekOfficialBalance({ ...binding, baseUrl: 'https://proxy.example.com' }, async () => { throw new Error('must not query'); }), /unsupported/);
});
