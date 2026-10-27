import { isProxyOfficialQuotaData, type OfficialQuotaReadParams, type ProxyOfficialQuotaReadResult,
  type ProxyOfficialQuotaWindow } from '@gian/proxy-protocol';
import { hasBoundQuotaHome, quotaFailure, quotaIdentity, quotaState } from '@gian/proxy-protocol/node';

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};

export type GrokQuotaMethod = 'x.ai/auth/info' | 'x.ai/billing';

/** Account controls, never authentication, session creation or a prompt. The
 * native billing handler itself requires grok.com auth (not an API key). */
export async function queryGrokOfficialQuota(initialized: unknown,
  request: (method: GrokQuotaMethod) => Promise<unknown>, selection: OfficialQuotaReadParams,
  env: NodeJS.ProcessEnv): Promise<ProxyOfficialQuotaReadResult> {
  if (!hasBoundQuotaHome(env, 'GROK_HOME')) return quotaState('unsupported');
  if (selection.provider && !['grok.com', 'xai'].includes(selection.provider)) return quotaState('excluded');
  const init = object(initialized);
  if (object(init._meta).grokShell !== true) return quotaState('unsupported');
  const methods = Array.isArray(init.authMethods) ? init.authMethods.map(item => object(item).id) : [];
  // Available methods are not the active method: Grok prefers a cached
  // subscription token even when an API key also exists.
  if (methods.includes('oidc')) return quotaState('excluded');
  if (!methods.includes('grok.com')) return quotaState('unsupported');
  if ((init.authMethods as unknown[]).some(item => object(item).id === 'grok.com'
    && object(object(item)._meta).external_provider === true)) return quotaState('excluded');
  let revision: string | null = null;
  const identify = async () => {
    const auth = object(await request('x.ai/auth/info'));
    if (!Object.hasOwn(auth, 'methodId')) throw new Error('invalid_response');
    if (auth.methodId === null) return quotaState('auth_required');
    if (auth.methodId === 'xai.api_key' || auth.methodId === 'oidc') return quotaState('excluded');
    if (!['cached_token', 'grok.com'].includes(String(auth.methodId))) return quotaState('unsupported');
    const id = auth.principalId ?? auth.email;
    if (typeof id !== 'string' || !id) return quotaState('auth_required');
    for (const field of ['teamId', 'organizationId', 'principalType']) {
      if (auth[field] != null && typeof auth[field] !== 'string') throw new Error('invalid_response');
    }
    return quotaIdentity(['grok', env.GROK_HOME, id, auth.teamId ?? null,
      auth.organizationId ?? null, auth.principalType ?? null], selection.identityNonce);
  };
  const failure = (error: unknown, identity: string | null) => {
    const code = object(error).code;
    if (code === -32601 || object(error).name === 'GrokExtMethodUnsupportedError') return quotaState('unsupported');
    if (code === -32000) return quotaState('auth_required', identity);
    return quotaFailure(error, identity);
  };
  try {
    const before = await identify();
    if (typeof before !== 'string') return before;
    revision = before;
    const data = normalizeGrokOfficialQuota(await request('x.ai/billing'));
    const after = await identify();
    if (typeof after !== 'string') return after;
    if (before !== after) return quotaFailure(new Error('unavailable'), after);
    return { status: 'ready', authRevision: revision, error: null, ...data };
  } catch (error) {
    if (revision) {
      try {
        const current = await identify();
        if (typeof current !== 'string') return current;
        revision = current;
      } catch { revision = null; }
    }
    return failure(error, revision);
  }
}

/** xAI BillingConfigResponse: percentages are percentages, Cent.val is USD
 * cents, and historical billing periods are not current quota windows. */
export function normalizeGrokOfficialQuota(value: unknown) {
  const config = object(object(value).config);
  const windows: ProxyOfficialQuotaWindow[] = [];
  const cents = (value: unknown): bigint => {
    const cent = object(value);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_response');
    const raw = Object.hasOwn(cent, 'val') ? cent.val : 0;
    if (typeof raw === 'number' && Number.isSafeInteger(raw)) return BigInt(raw);
    if (typeof raw === 'string' && /^-?\d{1,19}$/u.test(raw)) return BigInt(raw);
    throw new Error('invalid_response');
  };
  let usedRatio: number | null = null;
  if (config.creditUsagePercent != null) {
    if (typeof config.creditUsagePercent !== 'number' || !Number.isFinite(config.creditUsagePercent)
      || config.creditUsagePercent < 0 || config.creditUsagePercent > 100) throw new Error('invalid_response');
    usedRatio = config.creditUsagePercent / 100;
  } else if (config.monthlyLimit != null && config.used != null) {
    const limit = cents(config.monthlyLimit);
    const used = cents(config.used);
    if (limit < 0n || used < 0n) throw new Error('invalid_response');
    if (limit > 0n) usedRatio = Number(used > limit ? limit : used) / Number(limit);
  }
  if (usedRatio !== null) {
    const period = object(config.currentPeriod);
    const end = period.end ?? config.billingPeriodEnd;
    const resetAt = end == null ? null : typeof end === 'string' ? Date.parse(end) : NaN;
    if (resetAt !== null && (!Number.isSafeInteger(resetAt) || resetAt < 0)) throw new Error('invalid_response');
    const weekly = period.type === 'USAGE_PERIOD_TYPE_WEEKLY';
    const monthly = period.type === 'USAGE_PERIOD_TYPE_MONTHLY'
      || config.currentPeriod == null && config.monthlyLimit != null;
    windows.push({ id: 'included', label: weekly ? 'Weekly' : monthly ? 'Monthly' : 'Current period',
      usedRatio, resetAt, windowDurationMinutes: weekly ? 10_080 : null });
  }
  const balances = [];
  if (config.prepaidBalance != null) {
    const balance = cents(config.prepaidBalance);
    const absolute = balance < 0n ? -balance : balance;
    balances.push({ currency: 'USD', total: `${balance < 0n ? '-' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`,
      granted: null, toppedUp: null });
  }
  const result = { windows, balances };
  if (windows.length + balances.length === 0 || !isProxyOfficialQuotaData(result)) throw new Error('invalid_response');
  return result;
}
