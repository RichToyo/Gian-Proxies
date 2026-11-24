import { isProxyOfficialQuotaData, type ProxyOfficialQuotaWindow } from '@gian/proxy-protocol';
import type { OfficialQuotaReadParams, ProxyOfficialQuotaReadResult } from '@gian/proxy-protocol';
import { hasBoundQuotaHome, quotaFailure, quotaIdentity, quotaState } from '@gian/proxy-protocol/node';

import { redactCodexDiagnostic } from '../runtime/codex-app-server-client.js';
import { isCodexAuthFailure } from './codex-errors.js';

type AccountRequest = (method: 'config/read' | 'account/read' | 'account/rateLimits/read', params: Record<string, unknown>) => Promise<unknown>;

export interface CodexQuotaQueryOptions {
  /** Diagnostic sink for the reason behind a non-ready result. The text is
   *  redacted and bounded; it never enters the quota result itself. */
  log?: (line: string) => void;
  /** Whole-read budget, kept under the Host's 28 s request bound so a slow
   *  app-server start reports `timeout` instead of an opaque Host failure. */
  deadlineMs?: number;
}

const QUOTA_DEADLINE_MS = 25_000;
const QUOTA_LOG_TEXT_BYTES = 300;

/** Account types that never use the ChatGPT subscription quota. */
const EXCLUDED_ACCOUNT_TYPES = ['apiKey', 'agentIdentity', 'personalAccessToken', 'bedrockApiKey', 'amazonBedrock', 'gcp'];

class QuotaStageError extends Error {
  constructor(readonly stage: string, readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = cause instanceof Error ? cause.name : 'Error';
  }
}

function describeFailure(error: unknown): string {
  const stage = error instanceof QuotaStageError ? `${error.stage}: ` : '';
  const cause = error instanceof QuotaStageError ? error.cause : error;
  const code = cause && typeof cause === 'object' && typeof (cause as { code?: unknown }).code === 'number'
    ? ` (code ${(cause as { code: number }).code})`
    : '';
  const text = redactCodexDiagnostic(cause instanceof Error ? cause.message : String(cause)).replace(/\s+/g, ' ').trim();
  const bounded = text.length > QUOTA_LOG_TEXT_BYTES ? `${text.slice(0, QUOTA_LOG_TEXT_BYTES)}...` : text;
  return `${stage}${bounded}${code}`;
}

/** No thread/start or turn/start: only the bound app-server control surface. */
export async function queryCodexOfficialQuota(request: AccountRequest, selection: OfficialQuotaReadParams,
  env: NodeJS.ProcessEnv = process.env, options: CodexQuotaQueryOptions = {}): Promise<ProxyOfficialQuotaReadResult> {
  const log = options.log ?? ((line: string) => console.warn(line));
  const report = (result: ProxyOfficialQuotaReadResult, reason: string): ProxyOfficialQuotaReadResult => {
    log(`[codex-proxy:quota] ${result.status === 'error' ? result.error : result.status}: ${reason}`);
    return result;
  };
  if (!hasBoundQuotaHome(env, 'CODEX_HOME')) {
    return report(quotaState('unsupported'), 'CODEX_HOME is not the Agent HOME bound by the Host, or the Runtime path is not absolute.');
  }
  if (selection.provider && selection.provider !== 'openai') return quotaState('excluded');
  let revision: string | null = null;
  const call = async (method: Parameters<AccountRequest>[0], params: Record<string, unknown>) => {
    try { return await request(method, params); }
    catch (error) { throw new QuotaStageError(method, error); }
  };
  const identify = async () => {
    const raw = object(await call('config/read', { includeLayers: false }));
    if (!raw.config || typeof raw.config !== 'object') {
      return report(quotaState('unsupported'), 'config/read returned no effective config.');
    }
    const config = object(raw.config);
    if (config.model_provider != null && typeof config.model_provider !== 'string') throw new QuotaStageError('config/read', new Error('invalid_response'));
    const override = object(object(config.model_providers).openai);
    if (config.model_provider != null && config.model_provider !== 'openai'
      || override.base_url != null || env.OPENAI_BASE_URL || env.CODEX_OPENAI_BASE_URL) return quotaState('excluded');
    const auth = object(await call('account/read', { refreshToken: false }));
    if (typeof auth.requiresOpenaiAuth !== 'boolean' || !Object.hasOwn(auth, 'account')) throw new QuotaStageError('account/read', new Error('invalid_response'));
    if (!auth.requiresOpenaiAuth) return quotaState('excluded');
    if (auth.account === null) return report(quotaState('auth_required'), 'account/read reports no signed-in account.');
    const account = object(auth.account);
    if (typeof account.type !== 'string') throw new QuotaStageError('account/read', new Error('invalid_response'));
    if (EXCLUDED_ACCOUNT_TYPES.includes(account.type)) return quotaState('excluded');
    if (account.type !== 'chatgpt') return report(quotaState('unsupported'), `account type ${JSON.stringify(account.type)} has no subscription quota.`);
    // Codex 0.171 identifies a ChatGPT account by email and the top-level
    // userId; workspace routing arrives later and must not change identity.
    const id = account.email ?? auth.userId;
    if (typeof id !== 'string' || !id) return report(quotaState('unsupported'), 'account/read returned no account identity.');
    return quotaIdentity(['codex', env.CODEX_HOME, id, account.planType ?? null], selection.identityNonce);
  };
  const classify = (error: unknown, authRevision: string | null) => {
    const cause = error instanceof QuotaStageError ? error.cause : error;
    const message = cause instanceof Error ? cause.message : String(cause);
    const failure = isCodexAuthFailure({ message }) ? { status: 401 } : cause;
    return report(quotaFailure(failure, authRevision), describeFailure(error));
  };
  const read = async (): Promise<ProxyOfficialQuotaReadResult> => {
    try {
      const before = await identify();
      if (typeof before !== 'string') return before;
      revision = before;
      const limits = await call('account/rateLimits/read', {});
      let data;
      try { data = normalizeCodexOfficialQuota(limits); }
      catch (error) { throw new QuotaStageError('account/rateLimits/read', error); }
      const after = await identify();
      if (typeof after !== 'string') return after;
      if (before !== after) {
        return report(quotaFailure(new Error('unavailable'), after), 'the signed-in account changed while quota was read.');
      }
      return { status: 'ready', authRevision: revision, error: null, ...data };
    } catch (error) {
      if (revision) {
        try {
          const current = await identify();
          if (typeof current !== 'string') return current;
          return classify(error, current);
        } catch { return classify(error, null); }
      }
      return classify(error, null);
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadlineMs = options.deadlineMs ?? QUOTA_DEADLINE_MS;
  const expired = new Promise<ProxyOfficialQuotaReadResult>((resolve) => {
    timer = setTimeout(() => {
      const timeout = new Error(`quota read exceeded ${deadlineMs}ms`);
      timeout.name = 'TimeoutError';
      resolve(report(quotaFailure(timeout, null), timeout.message));
    }, deadlineMs);
  });
  try {
    return await Promise.race([read(), expired]);
  } finally {
    clearTimeout(timer);
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
