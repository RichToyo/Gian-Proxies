/**
 * Bridge/1.0 JSON-RPC client + DSH child supervisor.
 *
 * The proxy spawns one shared DSH Host per launch binding (a scoped Gian
 * profile running `@gian/dsh-bridge`) and speaks `gian.dsh.bridge/1.0` over its stdio.
 *
 * `start()` resolves only after the Bridge answered its `initialize`
 * handshake, so the start timeout covers DSH boot and profile mounting, and a
 * DSH that dies while booting fails with its own stderr. The client keeps a
 * bounded stderr tail for every failure it reports.
 *
 * The client does not interpret bridge payloads; the adapter owns projection.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { Buffer } from 'node:buffer';

export interface BridgeClientOptions {
  command: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Bound on one bridge request round-trip (default 30 s). */
  requestTimeoutMs?: number;
  /** Bound between spawn and the Bridge's `initialize` answer (default 60 s). */
  startTimeoutMs?: number;
  /** Where DSH stderr is mirrored (default: this process's stderr). */
  stderr?: (text: string) => void;
}

export interface BridgeNotification {
  method: string;
  params: Record<string, unknown>;
}

export interface BridgeExitInfo {
  code: number | null;
  signal: string | null;
  /** Bounded tail of the child's stderr, possibly empty. */
  stderrTail: string;
}

interface Pending {
  method: string;
  resolve: (result: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** Largest stderr tail carried into a failure message. */
export const STDERR_TAIL_BYTES = 4096;
/**
 * The Bridge refuses or rolls back a request this long before the Proxy
 * stops waiting, so a request the Proxy reports as timed out never commits.
 */
export const DEADLINE_FENCE_MS = 2_000;

export const BRIDGE_INITIALIZE_PARAMS = { protocol: { versions: ['1.0'] } } as const;

export class BridgeClientError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly domainCode?: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'BridgeClientError';
  }
}

/** Keep the last `limit` characters of a text stream, cut at a line start. */
export class StderrTail {
  private text = '';

  constructor(private readonly limit = STDERR_TAIL_BYTES) {}

  push(chunk: string): void {
    this.text += chunk;
    if (this.text.length > this.limit * 2) this.text = this.text.slice(-this.limit);
  }

  toString(): string {
    let tail = this.text.length > this.limit ? this.text.slice(-this.limit) : this.text;
    if (tail.length < this.text.length) {
      const newline = tail.indexOf('\n');
      if (newline >= 0 && newline < tail.length - 1) tail = tail.slice(newline + 1);
    }
    return tail.trim();
  }
}

function withTail(message: string, tail: string): string {
  return tail.length > 0 ? `${message} DSH stderr (last lines):\n${tail}` : message;
}

export class BridgeClient {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<(notification: BridgeNotification) => void>();
  private readonly exitListeners = new Set<(info: BridgeExitInfo) => void>();
  private readonly tail = new StderrTail();
  private starting: Promise<Record<string, unknown>> | null = null;
  private exited: Promise<void> = Promise.resolve();
  private lastExit: BridgeExitInfo | null = null;

  constructor(private readonly options: BridgeClientOptions) {}

  get isRunning(): boolean {
    return this.child !== null && this.child.exitCode === null && this.child.signalCode === null;
  }

  /** Last exit of the DSH child, when it exited. */
  get exitInfo(): BridgeExitInfo | null {
    return this.lastExit;
  }

  /** Current bounded stderr tail of the DSH child. */
  get stderrTail(): string {
    return this.tail.toString();
  }

  /**
   * Spawn DSH and complete the Bridge `initialize` handshake. Resolves with
   * the Bridge's initialize result; repeated calls share the same attempt.
   */
  start(): Promise<Record<string, unknown>> {
    this.starting ??= this.launch();
    return this.starting;
  }

  /** The Bridge initialize result; starts the child if needed. */
  ready(): Promise<Record<string, unknown>> {
    return this.start();
  }

  private launch(): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(startTimer);
        reject(error);
        void this.stop();
      };
      const startTimer = setTimeout(() => {
        fail(new BridgeClientError(
          -32000,
          withTail(`DSH did not answer the Bridge handshake within ${this.startTimeoutMs} ms.`, this.tail.toString()),
          'RUNTIME_UNAVAILABLE',
        ));
      }, this.startTimeoutMs);
      startTimer.unref();

      let child: ChildProcess;
      try {
        child = spawn(this.options.command, this.options.args ?? [], {
          env: { ...process.env, ...(this.options.env ?? {}) },
          cwd: this.options.cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          // Own process group on POSIX so shutdown takes the whole DSH tree
          // (the launcher spawns profile bundles as children) without touching
          // processes this proxy did not start. A Proxy killed outright closes
          // the stdin pipe, and the Bridge then exits DSH on EOF.
          detached: process.platform !== 'win32',
        });
      } catch (error) {
        fail(new BridgeClientError(
          -32000,
          `Cannot start DSH: ${error instanceof Error ? error.message : String(error)}`,
          'RUNTIME_UNAVAILABLE',
        ));
        return;
      }
      this.child = child;
      this.exited = new Promise(resolveExit => child.once('exit', () => resolveExit()));
      child.once('error', (error) => {
        fail(new BridgeClientError(-32000, `Cannot start DSH: ${error.message}`, 'RUNTIME_UNAVAILABLE'));
      });
      child.once('exit', (code, signal) => {
        const info: BridgeExitInfo = { code, signal, stderrTail: this.tail.toString() };
        this.lastExit = info;
        const reason = withTail(`DSH exited (code=${code}, signal=${signal}).`, info.stderrTail);
        fail(new BridgeClientError(-32000, reason, 'RUNTIME_UNAVAILABLE'));
        for (const [, pending] of this.pending) {
          clearTimeout(pending.timer);
          pending.reject(new BridgeClientError(
            -32000,
            `Bridge request ${pending.method} failed: ${reason}`,
            'RUNTIME_UNAVAILABLE',
          ));
        }
        this.pending.clear();
        if (this.child === child) this.child = null;
        for (const listener of this.exitListeners) listener(info);
      });
      // A pipe closed by a dying child must not crash the Proxy.
      child.stdin?.on('error', () => undefined);
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        this.tail.push(chunk);
        const mirrored = chunk.split('\n').filter(line => line.length > 0).map(line => `[dsh] ${line}\n`).join('');
        if (mirrored.length === 0) return;
        if (this.options.stderr) this.options.stderr(mirrored);
        else process.stderr.write(mirrored);
      });

      const reader = createInterface({ input: child.stdout!, crlfDelay: Infinity });
      reader.on('line', (line) => {
        if (line.trim() === '') return;
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          return;
        }
        this.handleLine(value);
      });

      this.request('initialize', { ...BRIDGE_INITIALIZE_PARAMS }, this.startTimeoutMs).then(
        (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(startTimer);
          resolve(result);
        },
        (error: unknown) => fail(error instanceof Error ? error : new Error(String(error))),
      );
    });
  }

  private get startTimeoutMs(): number {
    return this.options.startTimeoutMs ?? 60_000;
  }

  private get requestTimeoutMs(): number {
    return this.options.requestTimeoutMs ?? 30_000;
  }

  private handleLine(value: unknown): void {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return;
    const record = value as Record<string, unknown>;
    if (record.jsonrpc !== '2.0') return;
    if (typeof record.id === 'string' && record.id.length > 0) {
      const pending = this.pending.get(record.id);
      if (!pending) return;
      this.pending.delete(record.id);
      clearTimeout(pending.timer);
      if ('error' in record && record.error !== undefined) {
        const error = record.error as { code?: unknown; message?: unknown; data?: unknown };
        const data = error.data as { domainCode?: unknown; retryable?: unknown } | undefined;
        pending.reject(new BridgeClientError(
          typeof error.code === 'number' ? error.code : -32603,
          typeof error.message === 'string' ? error.message : 'bridge error',
          typeof data?.domainCode === 'string' ? data.domainCode : undefined,
          data?.retryable === true,
        ));
      } else {
        pending.resolve((record.result ?? {}) as Record<string, unknown>);
      }
      return;
    }
    if (typeof record.method === 'string') {
      const notification: BridgeNotification = {
        method: record.method,
        params: (record.params ?? {}) as Record<string, unknown>,
      };
      for (const listener of this.listeners) listener(notification);
    }
  }

  /**
   * Send one Bridge request. The envelope carries `deadlineAt`, a fence
   * margin before this client gives up; the Bridge neither starts nor
   * commits the request after it, so a timeout here never executes late.
   */
  request(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs: number = this.requestTimeoutMs,
  ): Promise<Record<string, unknown>> {
    const child = this.child;
    if (!child || !child.stdin || child.stdin.destroyed || child.stdin.writableEnded) {
      const exit = this.lastExit;
      return Promise.reject(new BridgeClientError(
        -32000,
        exit === null
          ? 'DSH is not running.'
          : withTail(`DSH is not running (exited code=${exit.code}, signal=${exit.signal}).`, exit.stderrTail),
        'RUNTIME_UNAVAILABLE',
      ));
    }
    const id = `dsh-${this.nextId}`;
    this.nextId += 1;
    const fence = Math.min(DEADLINE_FENCE_MS, Math.floor(timeoutMs / 4));
    const deadlineAt = Date.now() + timeoutMs - fence;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeClientError(
          -32000,
          `Bridge request ${method} exceeded ${timeoutMs} ms; DSH does not run it after its deadline.`,
          'RUNTIME_UNAVAILABLE',
          true,
        ));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { method, resolve, reject, timer });
      child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params, deadlineAt })}\n`);
    });
  }

  onNotification(listener: (notification: BridgeNotification) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Subscribe to the shared child's exit to terminalize open Gian turns. */
  onExit(listener: (info: BridgeExitInfo) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  /**
   * Stop the shared DSH child and its descendants: close stdin (the Bridge
   * exits DSH gracefully on EOF), SIGTERM the process group, SIGKILL it
   * after a bounded grace, and reap stragglers once the leader is gone.
   * Idempotent; resolves when the child has exited.
   */
  stop(graceMs = 1_500): Promise<void> {
    const child = this.child;
    if (!child) return this.exited;
    this.child = null;
    const pid = child.pid;
    const signalGroup = (signal: NodeJS.Signals): void => {
      try {
        // Negative pid targets the process group this proxy spawned.
        if (process.platform !== 'win32' && pid !== undefined) process.kill(-pid, signal);
        else child.kill(signal);
      } catch {
        try { child.kill(signal); } catch { /* already gone */ }
      }
    };
    child.stdin?.end();
    signalGroup('SIGTERM');
    const timer = setTimeout(() => signalGroup('SIGKILL'), graceMs);
    timer.unref();
    return this.exited.then(() => {
      clearTimeout(timer);
      if (process.platform !== 'win32' && pid !== undefined) {
        try { process.kill(-pid, 'SIGKILL'); } catch { /* group already empty */ }
      }
    });
  }
}

export const MAX_BRIDGE_LINE_BYTES = 16 * 1024 * 1024;
export function bridgeLineBytes(line: string): number {
  return Buffer.byteLength(line, 'utf8');
}
