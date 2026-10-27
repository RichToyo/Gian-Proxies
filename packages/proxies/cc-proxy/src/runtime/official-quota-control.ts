import { spawn } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { OfficialQuotaReadParams, ProxyOfficialQuotaReadResult } from '@gian/proxy-protocol';
import { quotaFailure, quotaState } from '@gian/proxy-protocol/node';
import { queryClaudeOfficialQuota, type ClaudeQuotaControl } from '../core/official-quota.js';

/** Mirrors Host's default Claude HOME exception: setting CLAUDE_CONFIG_DIR
 * for ~/.claude changes native credential-store selection, so do not add it. */
export async function readClaudeOfficialQuota(selection: OfficialQuotaReadParams,
  env: NodeJS.ProcessEnv = process.env): Promise<ProxyOfficialQuotaReadResult> {
  const executable = env.GIAN_RUNTIME_BIN;
  const home = env.GIAN_AGENT_HOME;
  if (!executable || !isAbsolute(executable) || !home || !isAbsolute(home)) return quotaState('unsupported');
  const effective = env.CLAUDE_CONFIG_DIR ?? join(env.HOME || homedir(), '.claude');
  if (!isAbsolute(effective) || await realpath(effective).catch(() => effective) !== home) return quotaState('unsupported');
  try {
    return await queryClaudeOfficialQuota(read => withClaudeQuotaControl(executable, env, read), selection, home);
  } catch (error) { return quotaFailure(error, null); }
}

/** Bounded pipe-only metadata inspection. No user frame, tools, hooks, MCP,
 * project settings or transcript persistence; resolves after child cleanup. */
export async function withClaudeQuotaControl<T>(executable: string, env: NodeJS.ProcessEnv,
  read: (request: ClaudeQuotaControl) => Promise<T>, timeoutMs = 10_000): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), 'gian-claude-quota-'));
  try {
    return await new Promise<T>((resolve, reject) => {
      const grouped = process.platform !== 'win32';
      const child = spawn(executable, [
        '--print', '--input-format', 'stream-json', '--output-format', 'stream-json',
        '--verbose', '--no-session-persistence', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
        '--settings', '{"disableAllHooks":true}', '--tools', '',
      ], { cwd, env, detached: grouped, stdio: ['pipe', 'pipe', 'pipe'] });
      let sequence = 0;
      let pending: { id: string; resolve(value: unknown): void; reject(error: Error): void } | null = null;
      let buffer = '';
      let bytes = 0;
      let finished = false;
      let outcome: { value: T } | { error: Error } | undefined;
      let terminateTimer: ReturnType<typeof setTimeout> | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const kill = (signal: NodeJS.Signals) => {
        try { if (grouped && child.pid) process.kill(-child.pid, signal); else child.kill(signal); }
        catch { /* Already closed. */ }
      };
      const finish = (result: NonNullable<typeof outcome>) => {
        if (finished) return;
        finished = true;
        outcome = result;
        clearTimeout(timer);
        pending?.reject('error' in result ? result.error : new Error('unavailable'));
        pending = null;
        child.stdin.end();
        terminateTimer = setTimeout(() => kill('SIGTERM'), 100);
        killTimer = setTimeout(() => kill('SIGKILL'), 1_000);
      };
      const timer = setTimeout(() => finish({ error: new Error('timeout') }), timeoutMs);
      child.stderr.resume();
      child.stdin.on('error', () => finish({ error: new Error('unavailable') }));
      child.on('error', () => finish({ error: new Error('unavailable') }));
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (finished) return;
        bytes += Buffer.byteLength(chunk);
        if (bytes > 1_048_576) { finish({ error: new Error('invalid_response') }); return; }
        buffer += chunk;
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          let event;
          try { event = JSON.parse(line); } catch { continue; }
          if (event?.type === 'control_request' || event?.type === 'assistant' || event?.type === 'result') {
            finish({ error: new Error('invalid_response') }); return;
          }
          const response = event?.response;
          if (event?.type !== 'control_response' || !pending || response?.request_id !== pending.id) continue;
          const current = pending;
          pending = null;
          if (response.subtype === 'success') current.resolve(response.response);
          else current.reject(new Error(response.error === 'get_usage is not supported in this context'
            || response.error_code === 'UNSUPPORTED_REQUEST' ? 'unsupported' : 'unavailable'));
        }
      });
      child.on('close', () => {
        clearTimeout(timer);
        clearTimeout(terminateTimer);
        clearTimeout(killTimer);
        finished = true;
        pending?.reject(new Error('unavailable'));
        pending = null;
        if (outcome && 'value' in outcome) resolve(outcome.value);
        else reject(outcome && 'error' in outcome ? outcome.error : new Error('unavailable'));
      });
      const request: ClaudeQuotaControl = value => new Promise((resolveRequest, rejectRequest) => {
        if (finished || pending) { rejectRequest(new Error('unavailable')); return; }
        // A type cast at a caller cannot turn this into a generic control port.
        if (!(value.subtype === 'initialize' && Object.keys(value).every(key => ['subtype', 'hooks'].includes(key))
          && Object.keys(value.hooks).length === 0)
          && !(value.subtype === 'get_usage' && value.skip_behaviors === true
            && Object.keys(value).every(key => ['subtype', 'skip_behaviors'].includes(key)))) {
          rejectRequest(new Error('invalid_response')); return;
        }
        const id = `gian-quota-${++sequence}`;
        pending = { id, resolve: resolveRequest, reject: rejectRequest };
        child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: id, request: value })}\n`);
      });
      void Promise.resolve().then(() => read(request)).then(value => finish({ value }),
        error => finish({ error: new Error(error instanceof Error
          && ['unsupported', 'invalid_response', 'timeout'].includes(error.message) ? error.message : 'unavailable') }));
    });
  } finally { await rm(cwd, { recursive: true, force: true }); }
}
