import { isProxyOfficialQuotaData, type ProxyOfficialQuotaWindow } from '@gian/proxy-protocol';
import type { OfficialQuotaReadParams, ProxyOfficialQuotaReadResult } from '@gian/proxy-protocol';
import { hasBoundQuotaHome, quotaFailure, quotaIdentity, quotaState } from '@gian/proxy-protocol/node';

type AccountRequest = (method: 'config/read' | 'account/read' | 'account/rateLimits/read', params: Record<string, unknown>) => Promise<unknown>;

/** No thread/start or turn/start: only the bound app-server control surface. */
export async function queryCodexOfficialQuota(request: AccountRequest, selection: OfficialQuotaReadParams,
  env: NodeJS.ProcessEnv = process.env): Promise<ProxyOfficialQuotaReadResult> {
  if (!hasBoundQuotaHome(env, 'CODEX_HOME')) return quotaState('unsupported');
  if (selection.provider && selection.provider !== 'openai') return quotaState('excluded');
  let revision: string | null = null;
  const identify = async () => {
    const raw = object(await request('config/read', { includeLayers: false }));
    if (!raw.config || typeof raw.config !== 'object') return quotaState('unsupported');
    const config = object(raw.config);
    if (config.model_provider != null && typeof config.model_provider !== 'string') throw new Error('invalid_response');
    const override = object(object(config.model_providers).openai);
    if (config.model_provider != null && config.model_provider !== 'openai'
      || override.base_url != null || env.OPENAI_BASE_URL || env.CODEX_OPENAI_BASE_URL) return quotaState('excluded');
    const auth = object(await request('account/read', { refreshToken: false }));
    if (typeof auth.requiresOpenaiAuth !== 'boolean' || !Object.hasOwn(auth, 'account')) throw new Error('invalid_response');
    if (!auth.requiresOpenaiAuth) return quotaState('excluded');
    if (auth.account === null) return quotaState('auth_required');
    const account = object(auth.account);
    if (typeof account.type !== 'string') throw new Error('invalid_response');
    if (['apiKey', 'agentIdentity', 'personalAccessToken', 'bedrockApiKey'].includes(account.type)) return quotaState('excluded');
    if (account.type !== 'chatgpt') return quotaState('unsupported');
    const id = account.accountId ?? account.id ?? account.email;
    if (typeof id !== 'string' || !id) return quotaState('unsupported');
    return quotaIdentity(['codex', env.CODEX_HOME, id, account.workspaceId ?? null, account.organizationId ?? null, account.planType ?? null], selection.identityNonce);
  };
  try {
    const before = await identify();
    if (typeof before !== 'string') return before;
    revision = before;
    const data = normalizeCodexOfficialQuota(await request('account/rateLimits/read', {}));
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

export interface CodexQuotaBinding {
  configHome: string;
  runtimeVersion: string;
  authRevision: string;
  firstParty: boolean;
  verified: boolean;
}
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Native control channel only. The qualifier must prove the current binding
 * before supplying this callback; no default HOME/credentials are discovered. */
export async function readCodexOfficialQuota(binding: CodexQuotaBinding,
  request: (method: 'account/read' | 'account/rateLimits/read', params: Record<string, unknown>) => Promise<unknown>) {
  if (!binding.verified || !binding.firstParty || !binding.configHome.startsWith('/') || !binding.runtimeVersion || !binding.authRevision) throw new Error('unsupported');
  const auth = object(await request('account/read', { refreshToken: false }));
  if (auth.account === null) throw new Error('auth_required');
  if (auth.requiresOpenaiAuth !== true || object(auth.account).type !== 'chatgpt') throw new Error('unsupported');
  return normalizeCodexOfficialQuota(await request('account/rateLimits/read', {}));
}

export function normalizeCodexOfficialQuota(value: unknown) {
  const raw = object(value);
  const mapped = object(raw.rateLimitsByLimitId);
  const entries: Array<[string, unknown]> = Object.keys(mapped).length > 0 ? Object.entries(mapped) : [['codex', raw.rateLimits]];
  const windows: ProxyOfficialQuotaWindow[] = [];
  for (const [id, rawLimit] of entries) {
    if (!/^[a-zA-Z0-9_.:-]{1,128}$/u.test(id)) throw new Error('invalid_response');
    const limit = object(rawLimit);
    for (const name of ['primary', 'secondary'] as const) {
      const rawWindow = limit[name];
      if (rawWindow === null || rawWindow === undefined) continue;
      const window = object(rawWindow);
      if (typeof window.usedPercent !== 'number' || !Number.isFinite(window.usedPercent)
        || window.usedPercent < 0 || window.usedPercent > 100) throw new Error('invalid_response');
      const duration = window.windowDurationMins;
      const reset = window.resetsAt;
      if (duration != null && (!Number.isSafeInteger(duration) || (duration as number) <= 0)
        || reset != null && (!Number.isSafeInteger(reset) || (reset as number) < 0 || !Number.isSafeInteger((reset as number) * 1_000))) throw new Error('invalid_response');
      windows.push({ id: `${id}:${name}`, label: duration === 300 ? '5h' : duration === 10_080 ? 'Weekly' : duration ? `${duration} min` : name === 'primary' ? 'Primary' : 'Secondary',
        usedRatio: window.usedPercent / 100, resetAt: reset == null ? null : (reset as number) * 1_000,
        windowDurationMinutes: duration == null ? null : duration as number });
    }
  }
  const result = { windows, balances: [] };
  if (windows.length === 0 || !isProxyOfficialQuotaData(result)) throw new Error('invalid_response');
  return result;
}
