import { createHmac } from 'node:crypto';
import { isAbsolute } from 'node:path';

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const state = (status: string, authRevision: string | null = null, error: string | null = null) =>
  ({ status, authRevision, error, windows: [], balances: [] });

export interface DeepSeekQuotaContext {
  get(name: string): unknown;
}

export const DEEPSEEK_BALANCE_TIMEOUT_MS = 20_000;

/** Runs inside the bound DSH context. Credentials never cross bridge stdio. */
export async function readDeepSeekBalance(ctx: DeepSeekQuotaContext, params: { provider: string | null; model: string | null; identityNonce: string },
  fetchBalance: typeof fetch = fetch, env: NodeJS.ProcessEnv = process.env): Promise<Record<string, unknown>> {
  if (!env.DSH_HOME || !isAbsolute(env.DSH_HOME) || env.DSH_HOME !== env.GIAN_AGENT_HOME) return state('unsupported');
  let revision: string | null = null;
  const identify = async (): Promise<{ result: Record<string, unknown> } | { key: string; authRevision: string }> => {
    const defaults = ctx.get('agentDefaultModel') as { currentSelection?(): { provider?: string } } | undefined;
    const provider = params.provider ?? defaults?.currentSelection?.().provider;
    if (typeof provider !== 'string' || !provider) return { result: state('unsupported') };
    if (provider !== 'deepseek-official') return { result: state('excluded') };
    const llm = ctx.get('llm') as { listConfigurableProviders?(): Array<{ provider: string; settingsNs: string; settingsPath: string[] }> } | undefined;
    const settings = ctx.get('settings') as { describe?(options: { redactSecrets: boolean }): Array<{ ns: string; value: unknown; revision: number }> } | undefined;
    const route = llm?.listConfigurableProviders?.().find(item => item.provider === provider);
    const descriptor = route && settings?.describe?.({ redactSecrets: true }).find(item => item.ns === route.settingsNs);
    if (!route || !descriptor) return { result: state('unsupported') };
    let config = object(descriptor.value);
    for (const segment of route.settingsPath) config = object(config[segment]);
    const launch = ctx.get('launchEnvironment') as { get?(name: string): { value: string } | undefined } | undefined;
    const environmentBase = launch ? launch.get?.('DEEPSEEK_BASE_URL')?.value : env.DEEPSEEK_BASE_URL;
    const base = config.baseURL ?? environmentBase ?? 'https://api.deepseek.com/anthropic';
    if (typeof base !== 'string') return { result: state('unsupported') };
    const url = new URL(base);
    if (url.origin !== 'https://api.deepseek.com' || url.username || url.password || url.search || url.hash
      || !['', '/', '/v1', '/anthropic', '/anthropic/v1'].includes(url.pathname.replace(/\/$/u, ''))) return { result: state('excluded') };
    const ref = config.apiKeyEnv ?? 'DEEPSEEK_API_KEY';
    if (typeof ref !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(ref)) return { result: state('unsupported') };
    const credentials = ctx.get('credentials') as { resolve?(ref: string): Promise<{ value: string } | undefined> } | undefined;
    if (!credentials?.resolve) return { result: state('unsupported') };
    const key = (await credentials.resolve(ref))?.value;
    if (typeof key !== 'string' || !key || /[\r\n]/u.test(key)) return { result: state('auth_required') };
    const authRevision = createHmac('sha256', Buffer.from(params.identityNonce, 'hex')).update(JSON.stringify([env.DSH_HOME, provider, base, ref, descriptor.revision, key])).digest('hex');
    return { key, authRevision };
  };
  try {
    const before = await identify();
    if ('result' in before) return before.result!;
    revision = before.authRevision;
    const response = await fetchBalance('https://api.deepseek.com/user/balance', {
      method: 'GET',
      headers: { Authorization: `Bearer ${before.key}`, Accept: 'application/json' },
      redirect: 'error', signal: AbortSignal.timeout(DEEPSEEK_BALANCE_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      const current = await identify();
      if ('result' in current) return current.result;
      if (response.status === 401 || response.status === 403) return state('auth_required', current.authRevision);
      return state('error', current.authRevision, response.status === 429 ? 'rate_limited' : 'unavailable');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('invalid_response');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > 64 * 1024) throw new Error('invalid_response');
        chunks.push(next.value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    const raw = object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if (typeof raw.is_available !== 'boolean' || !Array.isArray(raw.balance_infos)
      || raw.balance_infos.length === 0 || raw.balance_infos.length > 16) throw new Error('invalid_response');
    const decimal = (value: unknown): string => {
      if (typeof value !== 'string' || !/^-?\d{1,30}(?:\.\d{1,12})?$/u.test(value)) throw new Error('invalid_response');
      return value;
    };
    const balances = raw.balance_infos.map(item => {
      const value = object(item);
      if (value.currency !== 'CNY' && value.currency !== 'USD') throw new Error('invalid_response');
      return { currency: value.currency, total: decimal(value.total_balance),
        granted: decimal(value.granted_balance), toppedUp: decimal(value.topped_up_balance) };
    });
    const after = await identify();
    if ('result' in after) return after.result!;
    if (after.authRevision !== revision) return state('error', after.authRevision, 'unavailable');
    return { status: 'ready', authRevision: revision, error: null, windows: [], balances };
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    if (revision) {
      try {
        const current = await identify();
        if ('result' in current) return current.result;
        revision = current.authRevision;
      } catch { revision = null; }
    }
    return state('error', revision, name === 'TimeoutError' || name === 'AbortError' ? 'timeout'
      : error instanceof SyntaxError || error instanceof Error && error.message === 'invalid_response' ? 'invalid_response' : 'unavailable');
  }
}
