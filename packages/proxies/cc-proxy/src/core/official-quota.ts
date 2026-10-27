import { isProxyOfficialQuotaData, type OfficialQuotaReadParams, type ProxyOfficialQuotaReadResult,
  type ProxyOfficialQuotaWindow } from '@gian/proxy-protocol';
import { quotaFailure, quotaIdentity, quotaState } from '@gian/proxy-protocol/node';

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};

export type ClaudeQuotaControl = (request: { subtype: 'initialize'; hooks: Record<string, never> }
  | { subtype: 'get_usage'; skip_behaviors: true }) => Promise<unknown>;
export type WithClaudeQuotaControl = <T>(read: (request: ClaudeQuotaControl) => Promise<T>) => Promise<T>;

/** initialize.account is display metadata; get_usage is the authoritative
 * plan check. Neither session costs nor local behavior statistics are used. */
export async function queryClaudeOfficialQuota(control: WithClaudeQuotaControl,
  selection: OfficialQuotaReadParams, configHome: string): Promise<ProxyOfficialQuotaReadResult> {
  if (selection.provider && !['anthropic', 'firstParty'].includes(selection.provider)) return quotaState('excluded');
  let revision: string | null = null;
  const identify = async (request: ClaudeQuotaControl) => {
    const account = object(object(await request({ subtype: 'initialize', hooks: {} })).account);
    if (typeof account.apiProvider !== 'string') return quotaState('unsupported');
    if (account.apiProvider !== 'firstParty') return quotaState('excluded');
    if (account.subscriptionType === 'Claude API') return quotaState('excluded');
    if (!account.subscriptionType && account.apiKeySource && account.apiKeySource !== 'none') return quotaState('excluded');
    if (typeof account.email !== 'string' || !account.email) return quotaState('auth_required');
    if (typeof account.subscriptionType !== 'string' || !account.subscriptionType) return quotaState('unsupported');
    if (account.organization != null && typeof account.organization !== 'string') throw new Error('invalid_response');
    return quotaIdentity(['claude', configHome, account.email, account.organization ?? null, account.subscriptionType], selection.identityNonce);
  };
  try {
    const result = await control(async request => {
      const before = await identify(request);
      if (typeof before !== 'string') return before;
      revision = before;
      const raw = object(await request({ subtype: 'get_usage', skip_behaviors: true }));
      if (raw.subscription_type === null) return quotaState('excluded');
      if (!['pro', 'max', 'team', 'enterprise'].includes(String(raw.subscription_type))) return quotaState('unsupported');
      if (raw.rate_limits_available === false) return quotaState('unsupported');
      if (raw.rate_limits_available !== true) throw new Error('invalid_response');
      if (raw.rate_limits === null) throw new Error('unavailable');
      return { status: 'ready' as const, authRevision: before, error: null, ...normalizeClaudeOfficialQuota(raw.rate_limits) };
    });
    if (!revision) return result;
    // A fresh metadata-only child sees login changes on disk; initialize may
    // not be repeated in an already initialized stream-json process.
    const after = await control(identify);
    if (typeof after !== 'string') return after;
    if (after !== revision) return quotaFailure(new Error('unavailable'), after);
    return result;
  } catch (error) {
    if (revision) {
      try {
        const current = await control(identify);
        if (typeof current !== 'string') return current;
        revision = current;
      } catch { revision = null; }
    }
    if (error instanceof Error && error.message === 'unsupported') return quotaState('unsupported');
    return quotaFailure(error, revision);
  }
}

export function normalizeClaudeOfficialQuota(value: unknown) {
  const raw = object(value);
  const windows: ProxyOfficialQuotaWindow[] = [];
  const append = (id: string, label: string, input: unknown, duration: number | null) => {
    const window = object(input);
    const ratio = window.utilization;
    if (ratio !== null && (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio < 0 || ratio > 100)) throw new Error('invalid_response');
    const resetAt = window.resets_at == null ? null : typeof window.resets_at === 'string' ? Date.parse(window.resets_at) : NaN;
    if (resetAt !== null && (!Number.isSafeInteger(resetAt) || resetAt < 0)) throw new Error('invalid_response');
    windows.push({ id, label, usedRatio: ratio === null ? null : (ratio as number) / 100,
      resetAt, windowDurationMinutes: duration });
  };
  for (const [id, label, duration] of [
    ['five_hour', '5h', 300], ['seven_day', 'Weekly', 10_080],
    ['seven_day_oauth_apps', 'Weekly apps', 10_080], ['seven_day_opus', 'Weekly Opus', 10_080],
    ['seven_day_sonnet', 'Weekly Sonnet', 10_080],
  ] as const) if (raw[id] != null) append(id, label, raw[id], duration);
  if (raw.model_scoped != null) {
    if (!Array.isArray(raw.model_scoped) || raw.model_scoped.length > 32) throw new Error('invalid_response');
    raw.model_scoped.forEach((item, index) => {
      const model = object(item);
      if (typeof model.display_name !== 'string' || !model.display_name) throw new Error('invalid_response');
      append(`model:${index}`, `Weekly ${model.display_name}`, model, 10_080);
    });
  }
  const extra = object(raw.extra_usage);
  if (extra.is_enabled === true && extra.utilization != null) {
    // This is a spend cap, not a prepaid balance. Never subtract credits to
    // manufacture a wallet amount or assume an undocumented currency unit.
    append('extra_usage', 'Extra usage', { utilization: extra.utilization, resets_at: null }, null);
  }
  const result = { windows, balances: [] };
  if (!windows.length || !isProxyOfficialQuotaData(result)) throw new Error('invalid_response');
  return result;
}
