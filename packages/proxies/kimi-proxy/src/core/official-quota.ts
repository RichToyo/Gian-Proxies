import { isProxyOfficialQuotaData, type ProxyOfficialQuotaWindow, type ProxyOfficialQuotaBalance } from '@gian/proxy-protocol';
import type { OfficialQuotaReadParams, ProxyOfficialQuotaReadResult } from '@gian/proxy-protocol';
import { hasBoundQuotaHome, quotaFailure, quotaIdentity, quotaState } from '@gian/proxy-protocol/node';

export async function queryKimiOfficialQuota(request: (path: string) => Promise<unknown>, selection: OfficialQuotaReadParams,
  env: NodeJS.ProcessEnv = process.env): Promise<ProxyOfficialQuotaReadResult> {
  if (!hasBoundQuotaHome(env, 'KIMI_CODE_HOME')) return quotaState('unsupported');
  if (selection.provider && selection.provider !== 'managed:kimi-code') return quotaState('excluded');
  let revision: string | null = null;
  const identify = async () => {
    const managed = object(object(await request('/api/v1/auth')).managed_provider);
    const authenticated = managed.name === 'managed:kimi-code' && managed.status === 'authenticated';
    const config = object(await request('/api/v1/config'));
    const model = selection.model || config.default_model;
    const direct = typeof model === 'string' ? object(object(config.models)[model]).provider : undefined;
    let provider = direct;
    if (provider == null) {
      const models = object(await request('/api/v1/models')).items;
      const matches = Array.isArray(models) ? models.map(object).filter(item => item.model === model || item.id === model) : [];
      const providers = new Set(matches.map(item => item.provider).filter(item => typeof item === 'string'));
      if (providers.size !== 1) return quotaState(authenticated ? 'unsupported' : 'auth_required');
      provider = [...providers][0];
    }
    if (typeof provider !== 'string') return quotaState('unsupported');
    if (provider !== 'managed:kimi-code') return quotaState('excluded');
    if (!authenticated) return quotaState('auth_required');
    const identity = object(await request('/api/v1/oauth/userinfo?provider=managed:kimi-code'));
    if (identity.kind !== 'ok') throw Object.assign(new Error('unavailable'), { status: identity.status });
    const id = object(identity.userInfo).userId;
    if (!(typeof id === 'string' && id) && !(typeof id === 'number' && Number.isSafeInteger(id) && id >= 0)) return quotaState('unsupported');
    return quotaIdentity(['kimi', env.KIMI_CODE_HOME, id], selection.identityNonce);
  };
  try {
    const before = await identify();
    if (typeof before !== 'string') return before;
    revision = before;
    const data = normalizeKimiOfficialQuota(await request('/api/v1/oauth/usage?provider=managed:kimi-code'));
    const after = await identify();
    if (typeof after !== 'string') return after;
    if (before !== after) return quotaFailure(new Error('unavailable'), after);
    return { status: 'ready', authRevision: revision, error: null, ...data };
  } catch (error) {
    if (revision) {
      try {
        const current = await identify();
        if (typeof current !== 'string') return current;
        return quotaFailure(error, current);
      } catch { return quotaFailure(error, null); }
    }
    return quotaFailure(error, null);
  }
}

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** The existing Runtime REST client unwraps the transport envelope. In-band
 * OAuth errors still require an explicit kind check, even after HTTP 200. */
export async function readKimiOfficialQuota(binding: {
  configHome: string; runtimeVersion: string; authRevision: string; firstParty: boolean; verified: boolean;
}, request: (path: '/api/v1/auth' | '/api/v1/oauth/usage?provider=managed:kimi-code') => Promise<unknown>) {
  if (!binding.verified || !binding.firstParty || !binding.configHome.startsWith('/') || !binding.runtimeVersion || !binding.authRevision) throw new Error('unsupported');
  const auth = object(await request('/api/v1/auth'));
  const managed = object(auth.managed_provider);
  if (managed.name !== 'managed:kimi-code' || managed.status !== 'authenticated') throw new Error('auth_required');
  return normalizeKimiOfficialQuota(await request('/api/v1/oauth/usage?provider=managed:kimi-code'));
}

export function normalizeKimiOfficialQuota(value: unknown) {
  const raw = object(value);
  if (raw.kind !== 'ok') throw new Error(raw.kind === 'error' && raw.status === 401 ? 'auth_required'
    : raw.kind === 'error' && raw.status === 429 ? 'rate_limited' : 'invalid_response');
  const quota = object(raw.quota);
  const usages = object(quota.usages);
  const windows: ProxyOfficialQuotaWindow[] = [];
  const labels = { limit5h: ['5h', 300], limit7d: ['Weekly', 10_080], monthTotal: ['Monthly', null], monthCode: ['Monthly Code', null] } as const;
  for (const id of Object.keys(labels) as Array<keyof typeof labels>) {
    if (!Object.hasOwn(usages, id)) continue;
    const window = object(usages[id]);
    const resetAt = window.resetAt == null ? null : typeof window.resetAt === 'string' ? Date.parse(window.resetAt) : NaN;
    if (resetAt !== null && !Number.isSafeInteger(resetAt)) throw new Error('invalid_response');
    windows.push({ id, label: labels[id][0], usedRatio: window.usedRatio as number, resetAt, windowDurationMinutes: labels[id][1] });
  }
  const balances: ProxyOfficialQuotaBalance[] = [];
  if (quota.extraUsage != null) {
    const wallet = object(quota.extraUsage);
    if (!Number.isSafeInteger(wallet.balanceCents) || typeof wallet.currency !== 'string') throw new Error('invalid_response');
    const cents = BigInt(wallet.balanceCents as number);
    const magnitude = cents < 0 ? -cents : cents;
    const total = `${cents < 0 ? '-' : ''}${magnitude / 100n}.${String(magnitude % 100n).padStart(2, '0')}`;
    balances.push({ currency: wallet.currency, total, granted: null, toppedUp: null });
  }
  const result = { windows, balances };
  if (windows.length + balances.length === 0 || !isProxyOfficialQuotaData(result)) throw new Error('invalid_response');
  return result;
}
