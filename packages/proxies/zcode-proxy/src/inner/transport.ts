/**
 * ZCode Protocol v1 inner transport (WP0-frozen facts, evidence/wp0).
 *
 * - NDJSON over stdio; envelopes are `{id, method, params}` — no `jsonrpc` key.
 * - Responses are `{id, result}` or `{id, error:{code, data?, message}}`.
 * - Notifications are `{method, params}`.
 * - The server sends REVERSE REQUESTS `{id:"server-N", method, params}`; the
 *   client must answer on the same id. Unknown reverse methods get an explicit
 *   method-not-supported error so the server never hangs on us.
 *
 * Hardening required by the Revision 2 contract §8.1: byte-oriented line
 * framing with a max line limit, UTF-8 validation, per-request timeouts,
 * late-response tombstones, redacted stderr, and process-exit fanout.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';

export const MAX_INNER_LINE_BYTES = 16 * 1024 * 1024;

export interface InnerErrorShape {
  code: number;
  message: string;
  data?: unknown;
}

export class InnerError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(error: InnerErrorShape) {
    super(typeof error.message === 'string' ? redactSecrets(error.message) as string : 'inner error');
    this.name = 'InnerError';
    this.code = error.code;
    this.data = error.data === undefined ? undefined : redactSecrets(error.data);
  }
}

export interface ReverseRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

export type ReverseHandler = (
  params: Record<string, unknown>,
  /** Transport-level server request id; needed to answer later on defer. */
  transportId: string,
) => { result: unknown } | { error: InnerErrorShape } | { defer: true };

export interface InnerNotification {
  method: string;
  params: Record<string, unknown>;
}

export interface TransportOptions {
  /** Module path of the Runtime embedded in ZCode.app (or a fake test server). */
  runtimeBin: string;
  /** Working directory handed to `app-server --cwd`. */
  cwd: string;
  /** Node executable; defaults to the running interpreter. */
  nodeBin?: string;
  requestTimeoutMs?: number;
  /** Extra spawn args before `app-server` (test seams). */
  extraArgs?: string[];
  /** Production uses the same protocol surface as ZCode Desktop. */
  launchMode?: 'desktop-stdio' | 'legacy-cwd';
  /** Complete child environment (see buildAppServerEnvironment). Omitted:
   *  this process's environment minus Gian internals. */
  env?: Readonly<Record<string, string>>;
}

/** Gian Host/Proxy internals that must not reach the ZCode runtime or the
 *  tools it runs. GIAN_PLUGIN_ID / GIAN_PLUGIN_DATA_DIR stay (plugin
 *  identity contract); everything else under GIAN_ is Host plumbing (agent
 *  homes, Runtime paths, catalog and remote-session channels, test seams). */
const KEPT_GIAN_VARIABLES = new Set(['GIAN_PLUGIN_ID', 'GIAN_PLUGIN_DATA_DIR']);
const DROPPED_VARIABLES = new Set([
  // Node/Electron loader switches belong to the Proxy process, not to the
  // separate app-server Node process (or the shells and tools it spawns).
  'NODE_OPTIONS', 'NODE_CHANNEL_FD', 'NODE_CHANNEL_SERIALIZATION_MODE', 'NODE_UNIQUE_ID',
  'ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE',
]);

/** Directories a macOS GUI launch leaves out of PATH. ZCode's Bash tool,
 *  MCP stdio servers and Git rely on the user's normal toolchain. */
const MACOS_TOOL_PATHS = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];

/** The app-server environment: the Proxy's full environment (SHELL, proxy
 *  variables such as HTTPS_PROXY/NO_PROXY, locale, user toolchain), as the
 *  Claude and Antigravity Proxies pass it, minus Gian internals. HOME is the
 *  Host's ZCode HOME contract (the parent of the bound .zcode directory) and
 *  always wins. PATH keeps the inherited order and appends the standard
 *  macOS tool directories that a GUI launch omits. */
export function buildAppServerEnvironment(
  source: Readonly<Record<string, string | undefined>>,
  overrides: { home: string; tmpdir?: string },
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (key.startsWith('GIAN_') && !KEPT_GIAN_VARIABLES.has(key)) continue;
    if (DROPPED_VARIABLES.has(key)) continue;
    env[key] = value;
  }
  const inherited = (env.PATH ?? '').split(':').filter((entry) => entry !== '');
  env.PATH = [...new Set([...inherited, ...MACOS_TOOL_PATHS])].join(':');
  env.HOME = overrides.home;
  if (!env.TMPDIR && overrides.tmpdir) env.TMPDIR = overrides.tmpdir;
  if (!env.LANG && !env.LC_ALL) env.LANG = 'en_US.UTF-8';
  return env;
}

/** Bounded, redacted stderr kept for failure text (startup crashes print
 *  their reason only there). */
const STDERR_TAIL_LINES = 12;
const STDERR_TAIL_CHARS = 1_200;

/** Deterministic redaction for anything that might reach logs or errors. */
const SECRET_KEY = /api[-_]?key|token|authorization|secret|cookie|password|credential/i;
/** Inline `key=value` / `key: value` secrets inside free text (stderr lines,
 *  error messages). */
const SECRET_PAIR = new RegExp(
  "([A-Za-z_-]*(?:api[-_]?key|token|authorization|secret|cookie|password|credential)[A-Za-z_-]*)([\\\"']?\\s*[=:]\\s*[\\\"']?)(\\S+)",
  'gi',
);
export function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > 12) return '[depth]';
  if (typeof value === 'string') {
    return value.replace(SECRET_PAIR, (_match: string, key: string, sep: string) => `${key}${sep}[REDACTED]`);
  }
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, depth + 1));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY.test(key) ? '[REDACTED]' : redactSecrets(item, depth + 1);
    }
    return out;
  }
  return value;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: NodeJS.Timeout;
}

export interface InnerRuntimeFailure {
  kind: 'provider-business-error';
  providerCode: string;
  domainCode: 'RUNTIME_ERROR';
  message: string;
  retryable: boolean;
}

/** ZCode logs a provider rejection on stderr. 0.16.5 sent no terminal
 * protocol event at all; 3.18 follows with a typed turn.failed, so this is
 * only a hint (see ZcodeV2Adapter.handleInnerRuntimeFailure). Parse the
 * bounded typed prefix without retaining provider text, request ids,
 * headers, or response bodies. */
export function parseInnerRuntimeFailure(line: string): InnerRuntimeFailure | null {
  const match = line.match(/ProviderBusinessError:\s*\[([0-9A-Za-z_-]{1,64})\]/);
  if (!match) return null;
  const providerCode = match[1]!;
  return {
    kind: 'provider-business-error',
    providerCode,
    domainCode: 'RUNTIME_ERROR',
    message: providerCode === '1113'
      ? 'ZCode provider rejected the turn because the account has no available resource package.'
      : `ZCode provider rejected the turn (code ${providerCode}).`,
    retryable: false,
  };
}

/**
 * One ZCode app-server child. Requests are serialized through a monotonically
 * increasing numeric id; every request must resolve exactly once.
 */
export class ZCodeTransport extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly lateResponses = new Set<string>();
  private nextId = 1;
  private readonly reverseHandlers = new Map<string, ReverseHandler>();
  private buffer = '';
  private stderrBuffer = '';
  private readonly stderrLines: string[] = [];
  private lastRuntimeFailure: { line: string; at: number } | null = null;
  private exited = false;
  exitCode: number | null = null;
  exitSignal: string | null = null;

  constructor(private readonly options: TransportOptions) {
    super();
    this.setMaxListeners(0);
  }

  /** Register a reverse-request handler. MUST happen before spawn so the
   *  server never sees an unanswered request during startup (contract §15.1). */
  registerReverseHandler(method: string, handler: ReverseHandler): void {
    this.reverseHandlers.set(method, handler);
  }

  /** Spawn a fresh app-server after a deliberate stop (idle park). Reverse
   *  handlers and listeners on this transport stay registered. */
  restart(): void {
    if (this.child && !this.exited) throw new Error('ZCode transport is still running.');
    this.child = null;
    this.exited = false;
    this.exitCode = null;
    this.exitSignal = null;
    this.buffer = '';
    this.stderrBuffer = '';
    this.stderrLines.length = 0;
    this.start();
  }

  /** Spawn the app-server child. Handlers must already be registered. */
  start(): void {
    if (this.child) throw new Error('ZCode transport already started.');
    const env: NodeJS.ProcessEnv = { ...(this.options.env
      ?? buildAppServerEnvironment(process.env, { home: process.env.HOME ?? '' })) };
    const launchArgs = this.options.launchMode === 'legacy-cwd'
      ? ['app-server', '--cwd', this.options.cwd]
      : ['app-server', '--stdio', '--surface', 'desktop'];
    this.child = spawn(
      this.options.nodeBin ?? process.execPath,
      [
        ...this.options.extraArgs ?? [],
        this.options.runtimeBin,
        ...launchArgs,
      ],
      { cwd: this.options.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.consume(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => this.consumeStderr(chunk));
    this.child.once('exit', (code, signal) => {
      this.flushStderr();
      this.exited = true;
      this.exitCode = code;
      this.exitSignal = signal;
      const tail = this.stderrTail();
      const error = new InnerError({
        code: -32603,
        message: `ZCode app-server exited (code ${code ?? 'none'}, signal ${signal ?? 'none'})`
          + (tail ? `: ${tail}` : '.'),
        data: { reason: 'app_server_exited', exitCode: code, signal, ...(tail ? { stderrTail: tail } : {}) },
      });
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
      this.emit('exit', code, signal);
    });
    this.child.stdin.on('error', (error) => this.emit('error', error));
  }

  private consumeStderr(chunk: string): void {
    this.stderrBuffer += chunk;
    for (;;) {
      const index = this.stderrBuffer.indexOf('\n');
      if (index < 0) {
        if (this.stderrBuffer.length > 8_000) this.flushStderr();
        return;
      }
      const line = this.stderrBuffer.slice(0, index);
      this.stderrBuffer = this.stderrBuffer.slice(index + 1);
      this.handleStderrLine(line);
    }
  }

  private flushStderr(): void {
    if (this.stderrBuffer.length === 0) return;
    const line = this.stderrBuffer;
    this.stderrBuffer = '';
    this.handleStderrLine(line);
  }

  private handleStderrLine(raw: string): void {
    const line = raw.trim();
    if (line.length === 0) return;
    const redacted = redactSecrets(line.slice(0, 4_000)) as string;
    this.stderrLines.push(redacted.replace(/\x1b\[[0-9;]*m/g, '').slice(0, 400));
    if (this.stderrLines.length > STDERR_TAIL_LINES) this.stderrLines.shift();
    this.emit('stderr', redacted);
    const failure = parseInnerRuntimeFailure(line);
    if (failure === null) return;
    // One logged error can print the same line more than once; a later,
    // separate failure with the same provider code must still be reported.
    const now = Date.now();
    if (this.lastRuntimeFailure?.line === line && now - this.lastRuntimeFailure.at < 1_000) return;
    this.lastRuntimeFailure = { line, at: now };
    this.emit('runtime-failure', failure);
  }

  /** The last stderr lines, redacted and bounded, joined for failure text. */
  stderrTail(): string {
    const joined = this.stderrLines.join(' | ');
    return joined.length > STDERR_TAIL_CHARS ? `…${joined.slice(-STDERR_TAIL_CHARS)}` : joined;
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const index = this.buffer.indexOf('\n');
      if (index < 0) {
        if (Buffer.byteLength(this.buffer, 'utf8') > MAX_INNER_LINE_BYTES) {
          this.fail(new InnerError({ code: -32600, message: 'Inner NDJSON line limit exceeded.' }));
        }
        return;
      }
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      // Malformed envelope inside the stream: bounded diagnostic, never fatal
      // unless it saturates the line limit (contract §8.1).
      this.emit('diagnostic', { kind: 'unparseable-line' });
      return;
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      this.emit('diagnostic', { kind: 'invalid-envelope' });
      return;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.method === 'string' && typeof record.id === 'string') {
      this.handleReverseRequest({
        id: record.id,
        method: record.method,
        params: (record.params ?? {}) as Record<string, unknown>,
      });
      return;
    }
    if (typeof record.method === 'string' && record.id === undefined) {
      this.emit('notification', {
        method: record.method,
        params: (record.params ?? {}) as Record<string, unknown>,
      } satisfies InnerNotification);
      return;
    }
    if (typeof record.id === 'string') {
      const pending = this.pending.get(record.id);
      if (!pending) {
        // Late response after timeout: tombstone it (never resolve twice).
        this.lateResponses.add(record.id);
        if (this.lateResponses.size > 1_000) this.lateResponses.clear();
        this.emit('diagnostic', { kind: 'late-response', id: record.id });
        return;
      }
      this.pending.delete(record.id);
      clearTimeout(pending.timer);
      if (record.error !== undefined && record.error !== null) {
        const error = record.error as Record<string, unknown>;
        pending.reject(new InnerError({
          code: typeof error.code === 'number' ? error.code : -32603,
          message: typeof error.message === 'string' ? error.message : 'inner error',
          data: error.data,
        }));
      } else {
        pending.resolve(record.result);
      }
      return;
    }
    this.emit('diagnostic', { kind: 'unroutable-envelope' });
  }

  private handleReverseRequest(request: ReverseRequest): void {
    const handler = this.reverseHandlers.get(request.method);
    if (handler !== undefined) {
      const answer = handler(request.params, request.id);
      // Deferred answers (e.g. permission prompts) are sent later via
      // respondToServer once the Gian user has acted.
      if ('defer' in answer && answer.defer === true) return;
      if ('error' in answer && answer.error !== undefined) {
        this.write({ id: request.id, error: answer.error });
        return;
      }
      this.write({ id: request.id, result: (answer as { result: unknown }).result ?? {} });
      return;
    }
    this.write({
      id: request.id,
      error: { code: -32601, message: `Method not supported by client: ${request.method}` },
    });
  }

  private write(envelope: Record<string, unknown>): void {
    if (!this.child || this.exited) {
      throw new InnerError({ code: -32603, message: 'app-server stdin is closed.' });
    }
    this.child.stdin.write(`${JSON.stringify(envelope)}\n`);
  }

  /** Answer a server reverse request by its id (interaction.respond path). */
  respondToServer(serverRequestId: string, answer: { result?: unknown; error?: Record<string, unknown> }): void {
    this.write({
      id: serverRequestId,
      ...(answer.error !== undefined ? { error: answer.error } : { result: answer.result ?? {} }),
    });
  }

  request(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    if (this.exited) {
      return Promise.reject(new InnerError({ code: -32603, message: 'app-server has exited.' }));
    }
    const id = `g${this.nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // Tombstone: the pending entry is dropped BEFORE the timeout fires any
        // late response, so a duplicate resolution is impossible.
        this.pending.delete(id);
        reject(new InnerError({
          code: -32603,
          message: `Inner request ${method} timed out after ${timeoutMs ?? this.options.requestTimeoutMs ?? 30_000}ms.`,
        }));
      }, timeoutMs ?? this.options.requestTimeoutMs ?? 30_000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof InnerError ? error : new InnerError({ code: -32603, message: String(error) }));
      }
    });
  }

  private fail(error: InnerError): void {
    this.emit('error', error);
    this.child?.kill('SIGKILL');
  }

  isExited(): boolean {
    return this.exited;
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child || this.exited) return;
    child.stdin.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }, 3_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

/** WP0-frozen Gian runtime preference profile (Revision 2 §4.4). */
export const GIAN_RUNTIME_PREFERENCES = {
  materialization: {
    nativeSearchEnhancementsEnabled: false,
    memoryEnabled: false,
    askUserQuestionAutoResolutionEnabled: false,
    modelContextBudgetStrategy: 'preflight-v1',
  },
  userExecution: {
    nativeSearchEnhancementsEnabled: false,
    memoryEnabled: false,
    askUserQuestionAutoResolutionEnabled: false,
    modelContextBudgetStrategy: 'preflight-v1',
    integratedTerminalShell: { mode: 'auto' },
  },
} as const;

/** Register the standard Gian reverse-request handlers on a transport. */
export function registerGianReverseHandlers(transport: ZCodeTransport): void {
  transport.registerReverseHandler('session/requestRuntimePreferences', (params) => ({
    result: params.scope === 'user-execution'
      ? GIAN_RUNTIME_PREFERENCES.userExecution
      : GIAN_RUNTIME_PREFERENCES.materialization,
  }));
  transport.registerReverseHandler('interaction/requestOfficialMcpAuthHeaders', () => ({
    error: {
      code: -32603,
      data: { reason: 'official_auth_unavailable' },
      message: 'Gian does not provide official MCP auth headers.',
    },
  }));
  transport.registerReverseHandler('interaction/requestCredentialCipher', answerCredentialCipherRequest);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** credentialCipherRequestSchema bound (packages/shared/src/validation.ts). */
const CREDENTIAL_CIPHERTEXT_MAX_CHARS = Math.ceil(1_048_576 / 3) * 4 + 128;

/** `interaction/requestCredentialCipher` (ZCode 3.18): the app-server asks
 *  its Host to encrypt/decrypt a credentials.json value with the system
 *  key-store key the Host owns (Desktop: Electron main through
 *  executeCredentialCipherRequest). Gian's integrated Runtime keeps that key
 *  in-process, as the standalone CLI does, so this request is not expected.
 *  If it arrives anyway, answer exactly as upstream Hosts do, and never touch
 *  the Keychain or invent a key from the Proxy:
 *  - malformed params: JSON-RPC -32602 "Credential cipher is unavailable"
 *    (zcodeAgentService without a cipher provider);
 *  - a valid request: a typed CREDENTIAL_SECURE_STORAGE_UNAVAILABLE result,
 *    which the bridge turns into a storage error without migrating or
 *    rewriting any credential. */
export function answerCredentialCipherRequest(params: Record<string, unknown>):
  { result: unknown } | { error: InnerErrorShape } {
  const keys = Object.keys(params);
  const valid = keys.length === 3
    && typeof params.requestId === 'string' && UUID.test(params.requestId)
    && (params.operation === 'encrypt' || params.operation === 'decrypt')
    && typeof params.value === 'string' && params.value.length <= CREDENTIAL_CIPHERTEXT_MAX_CHARS;
  if (!valid) return { error: { code: -32602, message: 'Credential cipher is unavailable' } };
  return {
    result: {
      requestId: params.requestId,
      result: {
        ok: false,
        error: {
          code: 'CREDENTIAL_SECURE_STORAGE_UNAVAILABLE',
          message: 'Gian does not hold the ZCode credential key; the ZCode Runtime reads its own system '
            + 'credential store. Unlock the macOS Keychain and allow access when asked, then retry.',
        },
      },
    },
  };
}
