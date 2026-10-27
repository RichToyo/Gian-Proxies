import { isProxyOfficialQuotaData, type ProxyOfficialQuotaBalance } from '@gian/proxy-protocol';

/** Only a Proxy-owned controlled credential resolver may supply readBalance.
 * This adapter never reads environment keys or another Agent's HOME. */
export async function readDeepSeekOfficialBalance(binding: {
  baseUrl: string; configHome: string; runtimeVersion: string; authRevision: string; firstParty: boolean; verified: boolean;
}, readBalance: (url: 'https://api.deepseek.com/user/balance') => Promise<unknown>) {
  if (!binding.verified || !binding.firstParty || !binding.configHome.startsWith('/') || !binding.runtimeVersion || !binding.authRevision
    || !['https://api.deepseek.com', 'https://api.deepseek.com/', 'https://api.deepseek.com/v1', 'https://api.deepseek.com/v1/'].includes(binding.baseUrl)) throw new Error('unsupported');
  return normalizeDeepSeekOfficialBalance(await readBalance('https://api.deepseek.com/user/balance'));
}

export function normalizeDeepSeekOfficialBalance(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_response');
  const raw = value as Record<string, unknown>;
  if (typeof raw.is_available !== 'boolean' || !Array.isArray(raw.balance_infos)) throw new Error('invalid_response');
  const balances: ProxyOfficialQuotaBalance[] = raw.balance_infos.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('invalid_response');
    const info = item as Record<string, unknown>;
    if (info.currency !== 'CNY' && info.currency !== 'USD') throw new Error('invalid_response');
    return { currency: info.currency, total: info.total_balance as string, granted: info.granted_balance as string, toppedUp: info.topped_up_balance as string };
  });
  const result = { windows: [], balances };
  if (balances.length === 0 || !isProxyOfficialQuotaData(result)) throw new Error('invalid_response');
  return result;
}
