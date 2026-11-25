/**
 * Supervisor for the Kimi local server (`kimi web`).
 *
 * Upstream facts (kimi-code 2.7.x, apps/kimi-code/src/cli/sub/web/run.ts):
 * - `kimi web --json` mints an in-memory bearer token for this process only,
 *   implies `--no-open`, writes logs to stderr and prints exactly one ready
 *   line on stdout: {origin, ws_url, token, kimi_agent_protocol_version}.
 *   The shared `$KIMI_CODE_HOME/server.token` is never consulted, so a
 *   `kimi web rotate-token` by the user cannot invalidate this server.
 * - `--port 0` binds an OS-chosen port and the ready line reports it; a
 *   fixed port silently moves to port+1 when another process holds it.
 * - `GET /api/v1/healthz` answers {ok:true}; `POST /api/v1/shutdown` stops a
 *   loopback server.
 *
 * The proxy always runs its own dedicated instance: reusing a user-started
 * `kimi web` would couple Gian sessions to a process the user can close.
 *
 * The server must not outlive the Proxy: a leftover server keeps its session
 * locks and every later turn is refused with 40931. A small watchdog stops it
 * when the Proxy is gone, and leftovers of earlier Proxies are reclaimed
 * before a new server starts (see orphan-servers.ts).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { isAbsolute } from 'node:path';

import { kimiChildEnvironment, resolveKimiCodeHome } from './home.js';
import { KIMI_SERVER_WATCHDOG, reclaimOrphanedKimiServers } from './orphan-servers.js';
import { KimiServerRestClient } from './rest-client.js';

export interface KimiServerEndpoint {
  baseUrl: string;
  token: string;
}

export interface SupervisorExit {
  code: number | null;
  signal: string | null;
}

export interface SupervisorOptions {
  kimiBin: string;
  /** Injected endpoint: skip spawn (test seam / externally managed server). */
  endpoint?: KimiServerEndpoint;
  env?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
  debug?: (message: string) => void;
}

export interface KimiServerSupervisorResult {
  endpoint: KimiServerEndpoint;
  pid: number | null;
  exit: Promise<SupervisorExit>;
  stop(): Promise<void>;
}

const OUTPUT_TAIL = 400;

/** Parse the `kimi web --json` ready line. Only a loopback HTTP origin and a
 *  non-empty token are accepted. */
export function parseReadyLine(line: string): KimiServerEndpoint {
  let value: unknown;
  try { value = JSON.parse(line); } catch { throw new Error('Kimi server ready line is not JSON.'); }
  const ready = value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
  if (typeof ready.origin !== 'string' || typeof ready.token !== 'string' || ready.token === '') {
    throw new Error('Kimi server ready line has no origin or token.');
  }
  const origin = new URL(ready.origin);
  if (origin.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(origin.hostname)) {
    throw new Error('Kimi server ready line names a non-loopback origin.');
  }
  return { baseUrl: origin.origin, token: ready.token };
}

/** Stops the server if this Proxy process disappears without stopping it. */
function startServerWatchdog(serverPid: number | undefined): void {
  if (serverPid === undefined || process.platform === 'win32') return;
  try {
    const watchdog = spawn('/bin/sh', ['-c', KIMI_SERVER_WATCHDOG, 'gian-kimi-watchdog', String(process.pid), String(serverPid)], {
      stdio: 'ignore',
      detached: true,
    });
    watchdog.on('error', () => undefined);
    watchdog.unref();
  } catch { /* the reclaim on the next start still covers a leftover server */ }
}

export class KimiServerSupervisor {
  constructor(private readonly options: SupervisorOptions) {}

  async start(): Promise<KimiServerSupervisorResult> {
    if (this.options.endpoint !== undefined) {
      return {
        endpoint: this.options.endpoint,
        pid: null,
        exit: new Promise<SupervisorExit>(() => { /* injected endpoints have no child */ }),
        stop: async () => undefined,
      };
    }
    const kimiBin = this.options.kimiBin;
    if (!isAbsolute(kimiBin)) throw new Error(`Kimi binary path must be absolute: ${kimiBin}`);
    const env = this.options.env ?? process.env;
    await reclaimOrphanedKimiServers(resolveKimiCodeHome(env), {
      debug: this.options.debug ?? (message => { process.stderr.write(`${message}\n`); }),
    }).catch(() => []);
    const child: ChildProcess = spawn(kimiBin, [
      'web', '--json', '--no-open',
      '--port', '0',
      '--host', '127.0.0.1',
      '--log-level', 'silent',
    ], {
      env: kimiChildEnvironment(env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    startServerWatchdog(child.pid);
    let stdout = '';
    let stderr = '';
    const tail = () => `${stderr}${stdout}`.trim().slice(-OUTPUT_TAIL);
    const exit = new Promise<SupervisorExit>((resolvePromise) => {
      child.once('exit', (code, signal) => resolvePromise({ code, signal }));
    });
    child.stderr?.on('data', (chunk: Buffer) => { stderr = `${stderr}${chunk.toString('utf8')}`.slice(-8 * OUTPUT_TAIL); });
    const ready = new Promise<string>((resolvePromise) => {
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
        const newline = stdout.indexOf('\n');
        if (newline >= 0) resolvePromise(stdout.slice(0, newline));
      });
    });
    const timeoutMs = this.options.startupTimeoutMs ?? 30_000;
    let timer: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      ready.then(line => ({ kind: 'ready' as const, line })),
      exit.then(() => ({ kind: 'exited' as const })),
      new Promise<{ kind: 'timeout' }>((resolvePromise) => {
        timer = setTimeout(() => resolvePromise({ kind: 'timeout' }), timeoutMs);
      }),
    ]).finally(() => { if (timer) clearTimeout(timer); });
    if (outcome.kind === 'exited') {
      throw new Error(`Kimi server exited during startup${tail() ? `: ${tail()}` : ''}`);
    }
    if (outcome.kind === 'timeout') {
      child.kill('SIGKILL');
      throw new Error(`Kimi server did not report ready within ${timeoutMs}ms${tail() ? `; output: ${tail()}` : ''}`);
    }
    let endpoint: KimiServerEndpoint;
    try {
      endpoint = parseReadyLine(outcome.line);
      if (!(await new KimiServerRestClient(endpoint).healthz())) throw new Error('Kimi server is not healthy after its ready line.');
    } catch (error) {
      child.kill('SIGKILL');
      throw error;
    }
    let stopping = false;
    return {
      endpoint,
      pid: child.pid ?? null,
      exit,
      stop: async () => {
        if (stopping) return;
        stopping = true;
        await new KimiServerRestClient(endpoint).shutdown();
        const graceful = await Promise.race([
          exit.then(() => true),
          new Promise<false>((resolvePromise) => setTimeout(() => resolvePromise(false), 3_000)),
        ]);
        if (graceful) return;
        try { child.kill('SIGTERM'); } catch { /* already gone */ }
        const terminated = await Promise.race([
          exit.then(() => true),
          new Promise<false>((resolvePromise) => setTimeout(() => resolvePromise(false), 2_000)),
        ]);
        if (terminated) return;
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        await exit.catch(() => undefined);
      },
    };
  }
}
