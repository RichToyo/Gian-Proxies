import { isAbsolute } from 'node:path';
import type { OfficialQuotaReadParams, ProxyOfficialQuotaReadResult } from '@gian/proxy-protocol';
import { quotaFailure, quotaState } from '@gian/proxy-protocol/node';
import { normalizeAntigravityCliQuota, supportsAntigravityCliQuota } from '../core/official-quota.js';
import { AntigravityCliModelsError, readAntigravityCliReport,
  type AntigravityCliHelperIdentity, type AntigravityCliModelsOptions, type AntigravityCliReport } from './cli-models.js';

const cli = (result: ProxyOfficialQuotaReadResult): ProxyOfficialQuotaReadResult => ({ ...result, source: 'cli', authRevision: null });

export class AntigravityCliQuota {
  private closed = false;
  private pending: Promise<ProxyOfficialQuotaReadResult> | null = null;
  private cancel: AbortController | null = null;
  private provenHelper: AntigravityCliHelperIdentity | undefined;

  constructor(private readonly options: AntigravityCliModelsOptions = {},
    private readonly report: typeof readAntigravityCliReport = readAntigravityCliReport) {}

  read(_selection: OfficialQuotaReadParams): Promise<ProxyOfficialQuotaReadResult> {
    if (this.closed) return Promise.resolve(cli(quotaFailure(new Error('unavailable'), null)));
    if (this.pending) return this.pending;
    const controller = new AbortController();
    this.cancel = controller;
    const pending = this.query(controller).finally(() => {
      if (this.pending === pending) this.pending = null;
      if (this.cancel === controller) this.cancel = null;
    });
    this.pending = pending;
    return pending;
  }

  async stop(): Promise<void> {
    this.closed = true;
    this.cancel?.abort();
    await this.pending;
  }

  private async query(controller: AbortController): Promise<ProxyOfficialQuotaReadResult> {
    const env = { ...(this.options.env ?? process.env) };
    if (!env.GIAN_AGENT_HOME || !isAbsolute(env.GIAN_AGENT_HOME)) return cli(quotaState('unsupported'));
    const signal = this.options.signal ? AbortSignal.any([controller.signal, this.options.signal]) : controller.signal;
    let timedOut = false;
    // Includes preflight. The transport owns cleanup and refuses interactive
    // sign-in; no Runtime session, credential copy or profile rewrite occurs.
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 24_000);
    const query = async (command: 'help' | 'changelog' | 'usage', expected?: AntigravityCliHelperIdentity): Promise<AntigravityCliReport> => {
      const result = await this.report(command, { ...this.options, env, signal,
        timeoutMs: Math.min(this.options.timeoutMs ?? 20_000, command === 'usage' ? 20_000 : 4_000),
        maxOutputBytes: Math.min(this.options.maxOutputBytes ?? 512 * 1024, command === 'changelog' ? 512 * 1024 : 256 * 1024),
      }, expected);
      signal.throwIfAborted();
      return result;
    };
    try {
      if (!this.provenHelper) {
        const help = await query('help');
        if (!/^\s+changelog\s+/mu.test(help.stdout)) return cli(quotaState('unsupported'));
        const changelog = await query('changelog', help.helper);
        if (!supportsAntigravityCliQuota(changelog.stdout)) return cli(quotaState('unsupported'));
        this.provenHelper = changelog.helper;
      }
      const result = await query('usage', this.provenHelper);
      return cli({ status: 'ready', authRevision: null, error: null, ...normalizeAntigravityCliQuota(result.stdout) });
    } catch (error) {
      if (error instanceof AntigravityCliModelsError) {
        if (error.failure === 'helper_changed') this.provenHelper = undefined;
        if (['helper_missing', 'home_not_default'].includes(error.failure)) return cli(quotaState('unsupported'));
        if (error.failure === 'auth_required') return cli(quotaState('auth_required'));
        if (error.failure === 'timeout' || timedOut) return cli(quotaFailure(new Error('timeout'), null));
        if (error.failure === 'invalid_response' || error.failure === 'output_limit') return cli(quotaFailure(new Error('invalid_response'), null));
      }
      if (error instanceof Error && error.message === 'unsupported') return cli(quotaState('unsupported'));
      return cli(quotaFailure(timedOut ? new Error('timeout') : error, null));
    } finally { clearTimeout(timer); }
  }
}
