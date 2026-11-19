/**
 * Claude Code runtime backed by one long-lived process per session.
 *
 * Each session runs `claude -p --input-format stream-json --output-format
 * stream-json`, the streaming-input mode the Claude Agent SDK uses: user
 * messages and control requests (initialize, interrupt, set_model, ...) go in
 * on stdin; events, permission prompts (`can_use_tool`) and control responses
 * come back on stdout. The process starts with the session's first turn, is
 * kept for later turns, stops after an idle period, and resumes the native
 * session (`--resume`) when it is needed again.
 *
 * Turn boundaries: every user message is sent with a uuid, and the CLI echoes
 * it back when it consumes it (`--replay-user-messages`). A turn goes live at
 * the echo of its opening message and ends at a `result` only once every
 * message written for it has been consumed: a steer that arrives as a run is
 * finishing starts one more run, which still belongs to the turn. A `result`
 * before the opening echo belongs to an earlier, interrupted run and is
 * ignored.
 */

import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import type { ClaudeMcpServer, EffortLevel, ModelCapabilities, PermissionMode } from '../core/types.js';
import { readSavedClaudeModelUsage } from '../protocol/native-history.js';
import {
  annotateBuiltinFallbackModelError,
  classifyClaudeStreamEvent,
  claudeExecutable,
  claudeModelUsageTotals,
  discoverClaudeCapabilities,
  isClaudeCompactBoundary,
  labelDefaultModel,
  parseClaudeAssistantUsage,
  parseClaudeResultUsage,
  sanitizeDisplayName,
  subtractClaudeModelUsage,
  unknownClaudeEventKey,
  type ClaudeModelUsageTotals,
} from './claude-discovery.js';
import { readClaudeOfficialQuota } from './official-quota-control.js';
import type { ClaudeRuntime, ClaudeRuntimeEvents } from './types.js';

/** How long an idle session keeps its Claude Code process before it is
 *  stopped; the next turn resumes the session in a new process. Override
 *  with `GIAN_CLAUDE_IDLE_TIMEOUT_MS` (`0` keeps processes until the session
 *  closes). */
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000;
const CONTROL_TIMEOUT_MS = 30_000;
const INTERRUPT_TIMEOUT_MS = 10_000;
const STOP_GRACE_MS = 3_000;
const STDERR_LIMIT = 16 * 1024;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function record(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function idleTimeoutFromEnv(): number {
  const raw = process.env.GIAN_CLAUDE_IDLE_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_IDLE_TIMEOUT_MS;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : DEFAULT_IDLE_TIMEOUT_MS;
}

interface PendingControl {
  resolve(value: JsonRecord): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

/** One running `claude` process and the settings it currently has. */
interface ClaudeProcess {
  child: ChildProcess;
  /** `initialize` has been answered; before that the process is starting. */
  ready: boolean;
  exited: boolean;
  stderr: string;
  nextControlId: number;
  controls: Map<string, PendingControl>;
  mcpConfigPath: string | null;
  /** Fixed at launch: changing these needs a new process. */
  bypass: boolean;
  directories: Set<string>;
  /** Changed in place through control requests. */
  model: string | null;
  permissionMode: PermissionMode;
  effort: EffortLevel | null;
  /** Running `modelUsage` totals the next result is measured against. */
  usageBaseline: ClaudeModelUsageTotals;
  /** An interrupt Claude has not confirmed yet. Settles once it is
   *  confirmed, or once the process has been stopped instead. */
  pendingInterrupt: Promise<void> | null;
  agentTasks: Map<string, { toolUseId: string; description?: string; agentType?: string }>;
}

/** The turn Gian started, as the runtime sees it. */
interface ActiveTurn {
  openingUuid: string;
  /** The opening message has been consumed; output now belongs to this turn. */
  live: boolean;
  /** Messages written for this turn that the CLI has not consumed yet. */
  unconsumed: Set<string>;
  interrupted: boolean;
  streamedAnyText: boolean;
  streamedTextLength: number;
  /** Messages whose text/thinking already arrived as stream deltas, so their
   *  final assistant event must not repeat it. */
  streamedMessages: Set<string>;
  messageId: string | null;
  emittedUnknownKeys: Set<string>;
  context: { used: number } | null;
  model: string | null;
  /** Error of the latest run, kept while another run of this turn follows,
   *  or the error Claude reported while it was starting. */
  resultError: string | null;
  /** The process died during this turn and `processExited` reported it. */
  exitReported: boolean;
}

interface ManagedSession {
  sessionId: string;
  claudeSessionId: string;
  cwd: string;
  mcpServers: ClaudeMcpServer[];
  model: string | null;
  /** Last model id reported by `system init`. Claude can auto-promote (e.g.
   *  opus → opus[1m]), so the alias we asked for is not necessarily what
   *  runs. Used for context-window inference. */
  detectedModelId: string | null;
  /** Claude has created the native session, so a new process resumes it. */
  created: boolean;
  process: ClaudeProcess | null;
  turn: ActiveTurn | null;
  /** Pending `can_use_tool` requests by control request id. */
  permissions: Map<string, { toolName: string; input: JsonRecord }>;
  idleTimer: NodeJS.Timeout | null;
}

interface TurnSettings {
  permissionMode: PermissionMode;
  effort: EffortLevel | null;
  directories: string[];
  displayName: string | null;
}

/** Build the streaming-input `claude` argv. Exported so MCP isolation and
 *  permission-mode handling are unit-testable without spawning a Provider. */
export function buildClaudeStreamArgs(options: {
  claudeSessionId: string;
  resume: boolean;
  model: string | null;
  permissionMode: PermissionMode;
  effort: EffortLevel | null;
  directories: readonly string[];
  mcpConfigPath: string | null;
  displayName?: string | null;
}): string[] {
  const args: string[] = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--replay-user-messages',
  ];
  if (options.directories.length > 0) {
    args.push('--add-dir', ...options.directories);
  }
  // cc-proxy owns the MCP surface for this process. `--strict-mcp-config`
  // makes Claude load only the servers named by `--mcp-config`, so a session
  // never inherits unrelated user/project MCP servers.
  args.push('--strict-mcp-config');
  if (options.mcpConfigPath) args.push('--mcp-config', options.mcpConfigPath);
  if (options.permissionMode === 'bypassPermissions') {
    args.push('--dangerously-skip-permissions');
  } else {
    // Permission prompts come back as `can_use_tool` control requests.
    args.push('--permission-mode', options.permissionMode, '--permission-prompt-tool', 'stdio');
  }
  if (options.effort) args.push('--effort', options.effort);
  if (options.resume) {
    args.push('--resume', options.claudeSessionId);
  } else {
    args.push('--session-id', options.claudeSessionId);
    const displayName = sanitizeDisplayName(options.displayName);
    if (displayName) args.push('--name', displayName);
  }
  if (options.model) args.push('--model', options.model);
  return args;
}

/** AskUserQuestion answers as Claude Code expects them: question text →
 *  answer, multi-select answers comma-separated. */
function flattenAnswers(answers: Record<string, string | string[]>): Record<string, string> {
  return Object.fromEntries(Object.entries(answers).map(([question, answer]) => (
    [question, Array.isArray(answer) ? answer.join(', ') : answer]
  )));
}

export class ClaudeStreamRuntime extends EventEmitter<ClaudeRuntimeEvents> implements ClaudeRuntime {
  readOfficialQuota(params: import('@gian/proxy-protocol').OfficialQuotaReadParams) {
    return readClaudeOfficialQuota(params);
  }

  private readonly sessions = new Map<string, ManagedSession>();
  private discoveredModels: ModelCapabilities[] = [];
  /** True only while the menu is the built-in opus/sonnet/haiku list. */
  private builtinFallbackActive = false;
  private discoveredPermissionModes: string[] = [];
  private modelDiscoveryPromise: Promise<void> | null = null;
  private modelDiscoveryAbort = new AbortController();
  private readonly idleTimeoutMs: number;
  private readonly interruptTimeoutMs: number;

  constructor(options: { idleTimeoutMs?: number; interruptTimeoutMs?: number } = {}) {
    super();
    this.idleTimeoutMs = options.idleTimeoutMs ?? idleTimeoutFromEnv();
    this.interruptTimeoutMs = options.interruptTimeoutMs ?? INTERRUPT_TIMEOUT_MS;
  }

  async start(): Promise<number> {
    // Discover metadata without a user turn: local configuration/help and,
    // when no explicit menu exists, Claude's initialize control response.
    this.modelDiscoveryAbort = new AbortController();
    this.modelDiscoveryPromise = discoverClaudeCapabilities({
      signal: this.modelDiscoveryAbort.signal,
      debug: (message) => this.emit('debug', message),
    }).then((capabilities) => {
      this.discoveredModels = capabilities.models;
      this.discoveredPermissionModes = capabilities.permissionModes;
      this.builtinFallbackActive = capabilities.builtinFallbackActive;
    }).catch((err) => {
      this.emit('debug', `[runtime] Model discovery failed: ${err}`);
    });
    return 0;
  }

  getModels(): ModelCapabilities[] {
    return this.discoveredModels;
  }

  getPermissionModes(): string[] {
    return this.discoveredPermissionModes;
  }

  /** Block until initial capability discovery finishes. Used by
   *  capabilities.list so it doesn't return an empty models array on a
   *  freshly-spawned proxy. */
  async awaitModelDiscovery(): Promise<void> {
    if (this.modelDiscoveryPromise) await this.modelDiscoveryPromise;
  }

  async spawnSession(options: {
    sessionId: string;
    claudeSessionId: string;
    cwd: string;
    model?: string | null;
    isResume: boolean;
    mcpServers?: ClaudeMcpServer[];
  }): Promise<void> {
    this.killSession(options.sessionId);
    // Register only; the process starts with the first turn.
    this.sessions.set(options.sessionId, {
      sessionId: options.sessionId,
      claudeSessionId: options.claudeSessionId,
      cwd: options.cwd,
      mcpServers: structuredClone(options.mcpServers ?? []),
      model: options.model ?? null,
      detectedModelId: null,
      created: options.isResume,
      process: null,
      turn: null,
      permissions: new Map(),
      idleTimer: null,
    });
    this.emit('debug', `[runtime] Session registered: ${options.sessionId} (claude: ${options.claudeSessionId})`);
  }

  setSessionModel(sessionId: string, model: string | null): void {
    const session = this.requireSession(sessionId);
    session.model = model;
    // The last init event belongs to the previous selection; the next run
    // reports the model it actually uses.
    session.detectedModelId = null;
  }

  /**
   * Rotate the Claude Code session id for an existing Gian session. Used by
   * the `/clear` intercept: the next turn starts a new process with
   * `--session-id <new>`, so Claude begins with empty history while the Gian
   * session id stays the same.
   */
  resetClaudeSessionId(sessionId: string, newClaudeSessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.clearIdleTimer(session);
    if (session.process) void this.stopProcess(session, session.process, 'kill');
    session.turn = null;
    session.permissions.clear();
    session.claudeSessionId = newClaudeSessionId;
    session.created = false;
    this.emit('debug', `[runtime] Session ${sessionId} reset to fresh claude session ${newClaudeSessionId}`);
  }

  async sendMessage(sessionId: string, content: string, options?: {
    permissionMode?: PermissionMode | null;
    effort?: EffortLevel | null;
    displayName?: string | null;
    additionalDirectories?: string[];
  }): Promise<void> {
    const session = this.requireSession(sessionId);
    this.clearIdleTimer(session);
    // A new turn never lands in a process whose interrupt is unconfirmed: it
    // waits until Claude confirms, or until that process has been stopped
    // (then the turn resumes the session in a new one).
    const pendingInterrupt = session.process?.pendingInterrupt;
    if (pendingInterrupt) await pendingInterrupt;
    const settings: TurnSettings = {
      permissionMode: options?.permissionMode ?? 'default',
      effort: options?.effort ?? null,
      directories: options?.additionalDirectories ?? [],
      displayName: options?.displayName ?? null,
    };

    // The turn exists before the process starts: a Claude that dies while
    // starting (unknown model, bad configuration) fails this turn with what it
    // reported, exactly like a death later in the turn.
    const uuid = randomUUID();
    const turn: ActiveTurn = {
      openingUuid: uuid,
      live: false,
      unconsumed: new Set([uuid]),
      interrupted: false,
      streamedAnyText: false,
      streamedTextLength: 0,
      streamedMessages: new Set(),
      messageId: null,
      emittedUnknownKeys: new Set(),
      context: null,
      model: null,
      resultError: null,
      exitReported: false,
    };
    session.turn = turn;

    let proc = session.process;
    try {
      if (proc && !this.canKeep(proc, settings)) {
        this.emit('debug', `[runtime] Restarting Claude for ${sessionId}: launch flags changed`);
        await this.stopProcess(session, proc, 'graceful');
        proc = null;
      }
      if (proc) {
        await this.applySettings(session, proc, settings);
      } else {
        proc = await this.startProcess(session, settings);
      }
    } catch (error) {
      // Already reported as this turn's processExited.
      if (turn.exitReported) return;
      if (session.turn === turn) session.turn = null;
      throw error;
    }
    this.writeUserMessage(proc, content, uuid);
  }

  async steer(sessionId: string, content: string): Promise<void> {
    const session = this.requireSession(sessionId);
    const turn = session.turn;
    const proc = session.process;
    if (!turn || !proc || turn.interrupted) {
      throw new Error('This session does not have an active turn to steer.');
    }
    const uuid = randomUUID();
    turn.unconsumed.add(uuid);
    try {
      this.writeUserMessage(proc, content, uuid);
    } catch (error) {
      turn.unconsumed.delete(uuid);
      throw error;
    }
  }

  async respondPermission(
    sessionId: string,
    requestId: string,
    behavior: 'allow' | 'deny',
    extra?: {
      updatedInput?: Record<string, unknown>;
      answers?: Record<string, string | string[]>;
      message?: string;
    },
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    const pending = session?.permissions.get(requestId);
    if (!session || !pending) {
      this.emit('debug', `[runtime] respondPermission: no pending request ${requestId} for ${sessionId}`);
      return;
    }
    session.permissions.delete(requestId);
    const proc = session.process;
    if (!proc) return;
    // An allow always carries the tool input: Claude runs the tool with it.
    const response = behavior === 'allow'
      ? {
          behavior: 'allow',
          updatedInput: extra?.updatedInput
            ?? (extra?.answers ? { ...pending.input, answers: flattenAnswers(extra.answers) } : pending.input),
        }
      : { behavior: 'deny', message: extra?.message ?? 'The user declined this action.' };
    try {
      this.write(proc, {
        type: 'control_response',
        response: { subtype: 'success', request_id: requestId, response },
      });
    } catch (error) {
      this.emit('debug', `[runtime] respondPermission: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  isSessionAlive(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  getDetectedModelId(sessionId: string): string | null {
    return this.sessions.get(sessionId)?.detectedModelId ?? null;
  }

  killSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.clearIdleTimer(session);
    if (session.process) void this.stopProcess(session, session.process, 'kill');
    session.turn = null;
    session.permissions.clear();
    this.sessions.delete(sessionId);
  }

  /** Stop the active turn and keep the process for the next one. Queued
   *  steer messages are cancelled too. If Claude does not confirm in time the
   *  process is stopped instead; the next turn resumes the session. */
  interruptActiveProcess(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.permissions.clear();
    const turn = session.turn;
    const proc = session.process;
    if (!turn || !proc) return;
    turn.interrupted = true;
    const pending: Promise<void> = this.control(
      proc,
      { subtype: 'interrupt', cancel_queued: true },
      this.interruptTimeoutMs,
    ).then(
      (receipt) => {
        // A turn whose opening message was cancelled before it ran never
        // produces a result of its own.
        const cancelled = Array.isArray(receipt.cancelled) ? receipt.cancelled : [];
        if (session.turn === turn && !turn.live && cancelled.includes(turn.openingUuid)) {
          this.finishTurn(session);
        }
      },
      async (error: unknown) => {
        this.emit('debug', `[runtime] Interrupt failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
        if (session.process === proc) {
          if (session.turn === turn) session.turn = null;
          await this.stopProcess(session, proc, 'kill');
        }
      },
    ).finally(() => {
      if (proc.pendingInterrupt === pending) proc.pendingInterrupt = null;
    });
    proc.pendingInterrupt = pending;
  }

  async stop(): Promise<void> {
    this.modelDiscoveryAbort.abort();
    const stopping: Promise<void>[] = [];
    for (const session of this.sessions.values()) {
      this.clearIdleTimer(session);
      if (session.process) stopping.push(this.stopProcess(session, session.process, 'kill'));
    }
    this.sessions.clear();
    await Promise.all(stopping);
    await this.modelDiscoveryPromise;
  }

  // ---------------------------------------------------------------------------
  // Process lifecycle
  // ---------------------------------------------------------------------------

  /** Whether the running process can take a turn with these settings, or
   *  one of its launch-only flags has to change. */
  private canKeep(proc: ClaudeProcess, settings: TurnSettings): boolean {
    if ((settings.permissionMode === 'bypassPermissions') !== proc.bypass) return false;
    if (settings.directories.some((directory) => !proc.directories.has(directory))) return false;
    // An effort override is set through a control request; going back to
    // Claude's own default needs a launch without `--effort`.
    if (settings.effort === null && proc.effort !== null) return false;
    return true;
  }

  private async startProcess(session: ManagedSession, settings: TurnSettings): Promise<ClaudeProcess> {
    const mcpConfigPath = session.mcpServers.length > 0 ? await this.writeMcpConfig(session) : null;
    const args = buildClaudeStreamArgs({
      claudeSessionId: session.claudeSessionId,
      resume: session.created,
      model: session.model,
      permissionMode: settings.permissionMode,
      effort: settings.effort,
      directories: settings.directories,
      mcpConfigPath,
      displayName: settings.displayName,
    });
    this.emit('debug', `[runtime] Starting Claude for ${session.sessionId}: claude ${args.slice(0, 6).join(' ')} ...`);

    const child = spawn(claudeExecutable(), args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: session.cwd,
      env: { ...process.env },
    });
    // Surface ENOENT and friends to the turn instead of leaving it running.
    try {
      await new Promise<void>((resolve, reject) => {
        const onSpawn = () => { cleanup(); resolve(); };
        const onError = (err: Error) => { cleanup(); reject(err); };
        const cleanup = () => {
          child.removeListener('spawn', onSpawn);
          child.removeListener('error', onError);
        };
        child.once('spawn', onSpawn);
        child.once('error', onError);
      });
    } catch (error) {
      if (mcpConfigPath) void unlink(mcpConfigPath).catch(() => undefined);
      this.emit('debug', `[runtime] Failed to spawn claude: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }

    // A resumed session continues from the usage totals its transcript saved.
    const savedUsage = session.created
      ? readSavedClaudeModelUsage(session.claudeSessionId, session.cwd)
      : null;
    const proc: ClaudeProcess = {
      child,
      ready: false,
      exited: false,
      stderr: '',
      nextControlId: 0,
      controls: new Map(),
      mcpConfigPath,
      bypass: settings.permissionMode === 'bypassPermissions',
      directories: new Set(settings.directories),
      model: session.model,
      permissionMode: settings.permissionMode,
      effort: settings.effort,
      usageBaseline: claudeModelUsageTotals(savedUsage),
      pendingInterrupt: null,
      agentTasks: new Map(),
    };
    session.process = proc;

    const lines = createInterface({ input: child.stdout! });
    lines.on('line', (line) => this.handleLine(session, proc, line));
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      if (proc.stderr.length < STDERR_LIMIT) proc.stderr += text.slice(0, STDERR_LIMIT - proc.stderr.length);
      if (text.trim()) this.emit('debug', `[runtime:${session.sessionId}:stderr] ${text.trim()}`);
    });
    child.stdin?.on('error', (err) => {
      this.emit('debug', `[runtime] stdin error for ${session.sessionId}: ${err.message}`);
    });
    child.on('error', (err) => {
      this.emit('debug', `[runtime] post-spawn error for ${session.sessionId}: ${err.message}`);
    });
    child.on('exit', (code, signal) => this.handleExit(session, proc, code, signal));
    if (child.exitCode !== null || child.signalCode !== null) {
      this.handleExit(session, proc, child.exitCode, child.signalCode);
    }

    try {
      // Same first frame the Agent SDK sends.
      await this.control(proc, { subtype: 'initialize', hooks: {} });
    } catch (error) {
      await this.stopProcess(session, proc, 'kill');
      throw error;
    }
    proc.ready = true;
    return proc;
  }

  /** Bring a running process to this turn's model, permission mode and
   *  effort before the message is written. */
  private async applySettings(session: ManagedSession, proc: ClaudeProcess, settings: TurnSettings): Promise<void> {
    const updates: Promise<void>[] = [];
    if (session.model !== proc.model) {
      const model = session.model;
      updates.push(this.control(proc, { subtype: 'set_model', model }).then(() => { proc.model = model; }));
    }
    if (!proc.bypass && settings.permissionMode !== proc.permissionMode) {
      const mode = settings.permissionMode;
      updates.push(this.control(proc, { subtype: 'set_permission_mode', mode }).then(() => { proc.permissionMode = mode; }));
    }
    if (settings.effort !== null && settings.effort !== proc.effort) {
      const effort = settings.effort;
      updates.push(this.control(proc, {
        subtype: 'apply_flag_settings',
        settings: { effortLevel: effort },
      }).then(() => { proc.effort = effort; }));
    }
    await Promise.all(updates);
  }

  /** Stop a process: `graceful` closes stdin so Claude finishes writing its
   *  transcript, `kill` also signals at once. Either way the process is
   *  escalated to SIGTERM and SIGKILL if it does not exit. Resolves on exit. */
  private async stopProcess(session: ManagedSession, proc: ClaudeProcess, mode: 'graceful' | 'kill'): Promise<void> {
    if (session.process === proc) session.process = null;
    if (proc.exited) return;
    const exited = new Promise<void>((resolve) => proc.child.once('exit', () => resolve()));
    try { proc.child.stdin?.end(); } catch { /* already closed */ }
    const term = setTimeout(() => { if (!proc.exited) proc.child.kill('SIGTERM'); }, mode === 'kill' ? 0 : STOP_GRACE_MS);
    const hard = setTimeout(() => { if (!proc.exited) proc.child.kill('SIGKILL'); }, STOP_GRACE_MS * 2);
    if (!proc.exited) await exited;
    clearTimeout(term);
    clearTimeout(hard);
  }

  private handleExit(
    session: ManagedSession,
    proc: ClaudeProcess,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (proc.exited) return;
    proc.exited = true;
    for (const pending of proc.controls.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`Claude Code exited (code=${code}, signal=${signal}).`));
    }
    proc.controls.clear();
    if (proc.mcpConfigPath) void unlink(proc.mcpConfigPath).catch(() => undefined);

    // A stopped or replaced process: its exit is expected and owns no turn.
    if (session.process !== proc || this.sessions.get(session.sessionId) !== session) {
      this.emit('debug', `[runtime] Claude process for ${session.sessionId} exited (code=${code}, signal=${signal})`);
      return;
    }
    session.process = null;
    this.clearIdleTimer(session);
    session.permissions.clear();
    const turn = session.turn;
    session.turn = null;
    if (!turn || turn.interrupted) {
      this.emit('debug', `[runtime] Claude process for ${session.sessionId} exited while idle (code=${code}, signal=${signal})`);
      return;
    }
    const detail = turn.resultError
      ?? (code !== 0 && proc.stderr.trim() ? proc.stderr.trim() : undefined);
    turn.exitReported = true;
    this.emit(
      'processExited',
      session.sessionId,
      code,
      signal,
      detail ? annotateBuiltinFallbackModelError(this.builtinFallbackActive, session.model, detail) : undefined,
      turn.streamedTextLength,
    );
  }

  private finishTurn(session: ManagedSession): void {
    session.turn = null;
    session.permissions.clear();
    this.armIdleTimer(session);
  }

  private armIdleTimer(session: ManagedSession): void {
    this.clearIdleTimer(session);
    if (this.idleTimeoutMs <= 0 || !session.process || session.turn) return;
    const timer = setTimeout(() => {
      if (session.idleTimer === timer) session.idleTimer = null;
      const proc = session.process;
      if (!proc || session.turn) return;
      this.emit('debug', `[runtime] Stopping idle Claude process for ${session.sessionId}`);
      void this.stopProcess(session, proc, 'graceful');
    }, this.idleTimeoutMs);
    timer.unref();
    session.idleTimer = timer;
  }

  private clearIdleTimer(session: ManagedSession): void {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }

  // ---------------------------------------------------------------------------
  // stdin
  // ---------------------------------------------------------------------------

  private write(proc: ClaudeProcess, frame: JsonRecord): void {
    const stdin = proc.child.stdin;
    if (proc.exited || !stdin || stdin.destroyed || stdin.writableEnded) {
      throw new Error('The Claude Code process is not running.');
    }
    stdin.write(`${JSON.stringify(frame)}\n`);
  }

  private writeUserMessage(proc: ClaudeProcess, content: string, uuid: string): void {
    // Plain string content: Claude records it in the transcript exactly as a
    // `claude -p <prompt>` turn, which native replay depends on.
    this.write(proc, {
      type: 'user',
      session_id: '',
      parent_tool_use_id: null,
      uuid,
      message: { role: 'user', content },
    });
  }

  private control(proc: ClaudeProcess, request: JsonRecord, timeoutMs = CONTROL_TIMEOUT_MS): Promise<JsonRecord> {
    proc.nextControlId += 1;
    const requestId = `gian-${proc.nextControlId}`;
    return new Promise<JsonRecord>((resolve, reject) => {
      const timer = setTimeout(() => {
        proc.controls.delete(requestId);
        reject(new Error(`Claude Code did not answer ${String(request.subtype)} within ${timeoutMs} ms.`));
      }, timeoutMs);
      proc.controls.set(requestId, { resolve, reject, timer });
      try {
        this.write(proc, { type: 'control_request', request_id: requestId, request });
      } catch (error) {
        clearTimeout(timer);
        proc.controls.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  // ---------------------------------------------------------------------------
  // stdout
  // ---------------------------------------------------------------------------

  private handleLine(session: ManagedSession, proc: ClaudeProcess, line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let event: JsonRecord;
    try {
      event = record(JSON.parse(trimmed));
    } catch {
      this.emit('debug', `[runtime:${session.sessionId}:stdout] ${trimmed.slice(0, 200)}`);
      return;
    }
    if (event.type === 'control_response') {
      this.resolveControl(proc, record(event.response));
      return;
    }
    // Output of a process this session no longer uses is dropped.
    if (session.process !== proc) return;
    if (event.type === 'control_request') {
      this.handleControlRequest(session, proc, event);
      return;
    }
    if (event.type === 'control_cancel_request') {
      const requestId = nonEmptyString(event.request_id);
      if (requestId && session.permissions.delete(requestId)) {
        this.emit('permissionCancelled', session.sessionId, requestId);
      }
      return;
    }
    this.handleStreamEvent(session, proc, event);
  }

  private resolveControl(proc: ClaudeProcess, response: JsonRecord): void {
    const requestId = nonEmptyString(response.request_id);
    const pending = requestId ? proc.controls.get(requestId) : undefined;
    if (!requestId || !pending) return;
    proc.controls.delete(requestId);
    clearTimeout(pending.timer);
    if (response.subtype === 'success') pending.resolve(record(response.response));
    else pending.reject(new Error(nonEmptyString(response.error) ?? 'Claude Code rejected the control request.'));
  }

  private handleControlRequest(session: ManagedSession, proc: ClaudeProcess, event: JsonRecord): void {
    const requestId = nonEmptyString(event.request_id);
    if (!requestId) return;
    const request = record(event.request);
    if (request.subtype === 'can_use_tool') {
      const toolName = nonEmptyString(request.tool_name) ?? 'unknown';
      const input = record(request.input);
      if (!session.turn || session.turn.interrupted) {
        // Nobody can answer outside a Gian turn.
        this.write(proc, {
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: requestId,
            response: { behavior: 'deny', message: 'There is no active Gian turn to approve this action.' },
          },
        });
        return;
      }
      session.permissions.set(requestId, { toolName, input });
      // Pass the full input through. Host-side normalizers JSON.parse it to
      // extract per-tool fields; truncating would break Edit/Write inputs.
      let inputPreview = '';
      try { inputPreview = JSON.stringify(input); } catch { /* unserializable input */ }
      const description = nonEmptyString(request.description) ?? `Tool ${toolName} requires permission.`;
      this.emit('debug', `[runtime] permissionRequest sessionId=${session.sessionId} toolName=${toolName} inputKeys=${Object.keys(input).join(',')}`);
      this.emit('permissionRequest', session.sessionId, requestId, toolName, description, inputPreview);
      return;
    }
    // Gian registers no hooks, SDK MCP servers or dialogs; refuse the rest
    // so Claude never waits on an answer that cannot come.
    this.write(proc, {
      type: 'control_response',
      response: {
        subtype: 'error',
        request_id: requestId,
        error: `Gian does not handle ${String(request.subtype ?? 'unknown')} requests.`,
      },
    });
  }

  private handleStreamEvent(session: ManagedSession, proc: ClaudeProcess, event: JsonRecord): void {
    const sessionId = session.sessionId;
    const eventType = typeof event.type === 'string' ? event.type : '';

    // `system init` opens every run and reports the model actually running.
    if (eventType === 'system' && event.subtype === 'init') {
      session.created = true;
      if (typeof event.model === 'string') {
        session.detectedModelId = event.model;
        if (labelDefaultModel(this.discoveredModels, event.model)) {
          this.emit('defaultModelLabeled', event.model);
        }
      }
    }
    if (eventType === 'user' && event.isReplay === true) {
      this.handleEcho(session, event);
      return;
    }
    if (eventType === 'result') {
      this.handleResult(session, proc, event);
      return;
    }

    const turn = session.turn;
    // Output with no live turn (an interrupted run winding down, or a run
    // Claude started on its own) is not part of any Gian turn. It stays in
    // the native transcript, where history replay picks it up.
    if (!turn || !turn.live || turn.interrupted) return;

    if (eventType === 'stream_event') {
      this.handlePartial(sessionId, turn, record(event.event));
      return;
    }

    // Claude exposes subagents as a native task lifecycle. Keep the native
    // task id and the parent Agent tool_use id separate: the latter is the
    // stable transcript anchor, while task_id is what later SendMessage/
    // TaskOutput calls address.
    if (eventType === 'system' && event.subtype === 'task_started') {
      const taskId = nonEmptyString(event.task_id);
      const toolUseId = nonEmptyString(event.tool_use_id);
      if (taskId && toolUseId) {
        const description = nonEmptyString(event.description) ?? undefined;
        const agentType = nonEmptyString(event.subagent_type) ?? undefined;
        proc.agentTasks.set(taskId, {
          toolUseId,
          ...(description ? { description } : {}),
          ...(agentType ? { agentType } : {}),
        });
        this.emit('agentTask', sessionId, {
          taskId,
          toolUseId,
          status: 'running',
          ...(description ? { description } : {}),
          ...(agentType ? { agentType } : {}),
          startedAt: Date.now(),
        });
      }
    }

    if (eventType === 'system' && event.subtype === 'task_notification') {
      const taskId = nonEmptyString(event.task_id);
      const known = taskId ? proc.agentTasks.get(taskId) : undefined;
      const toolUseId = nonEmptyString(event.tool_use_id) ?? known?.toolUseId ?? '';
      if (taskId && toolUseId) {
        const summary = nonEmptyString(event.summary) ?? undefined;
        const outputFile = nonEmptyString(event.output_file) ?? undefined;
        this.emit('agentTask', sessionId, {
          taskId,
          toolUseId,
          status: event.status === 'completed' ? 'done' : 'error',
          ...(known?.description ? { description: known.description } : {}),
          ...(known?.agentType ? { agentType: known.agentType } : {}),
          ...(summary ? { summary } : {}),
          ...(outputFile ? { outputFile } : {}),
          completedAt: Date.now(),
        });
      }
    }

    if (isClaudeCompactBoundary(event)) {
      // Assistant usage before this boundary describes the old context.
      turn.context = null;
      this.emit('tokenUsage', sessionId, { context: null, reason: 'compact_started' });
    }

    if (eventType === 'assistant') {
      const usageSample = parseClaudeAssistantUsage(event);
      if (usageSample) {
        turn.context = usageSample.context;
        turn.model = usageSample.model ?? session.detectedModelId ?? session.model;
        this.emit('tokenUsage', sessionId, { context: usageSample.context });
      }
      this.handleAssistantMessage(sessionId, turn, record(event.message));
    }

    if (eventType === 'user') {
      const content = Array.isArray(record(event.message).content) ? record(event.message).content as unknown[] : [];
      for (const block of content) {
        const result = record(block);
        if (result.type !== 'tool_result') continue;
        const callId = nonEmptyString(result.tool_use_id);
        if (!callId) continue;
        this.emit('toolResult', sessionId, callId, result.content ?? null, result.is_error === true);
      }
    }

    if (classifyClaudeStreamEvent(event) === 'unknown') {
      const key = unknownClaudeEventKey(event);
      if (!turn.emittedUnknownKeys.has(key)) {
        turn.emittedUnknownKeys.add(key);
        this.emit('unknownClaudeEvent', sessionId, event);
      }
    }
    if (eventType && eventType !== 'system') {
      this.emit('debug', `[runtime:${sessionId}] ${eventType}${event.subtype ? `:${String(event.subtype)}` : ''}`);
    }
  }

  /** The CLI consumed a message we wrote. */
  private handleEcho(session: ManagedSession, event: JsonRecord): void {
    const turn = session.turn;
    if (!turn) return;
    const uuid = nonEmptyString(event.uuid);
    // CLIs that echo without our uuid consume messages in the order written.
    const consumed = uuid ?? turn.unconsumed.values().next().value;
    if (!consumed || !turn.unconsumed.delete(consumed)) return;
    if (consumed === turn.openingUuid) turn.live = true;
  }

  /** Partial assistant output (`--include-partial-messages`). Deltas of one
   *  content block share an item id, so the adapter appends them in place. */
  private handlePartial(sessionId: string, turn: ActiveTurn, streamEvent: JsonRecord): void {
    if (streamEvent.type === 'message_start') {
      turn.messageId = nonEmptyString(record(streamEvent.message).id) ?? `msg_${randomUUID()}`;
      return;
    }
    if (streamEvent.type !== 'content_block_delta') return;
    turn.messageId ??= `msg_${randomUUID()}`;
    const index = typeof streamEvent.index === 'number' ? streamEvent.index : 0;
    const itemId = `${turn.messageId}_${index}`;
    const delta = record(streamEvent.delta);
    if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
      turn.streamedMessages.add(turn.messageId);
      turn.streamedAnyText = true;
      turn.streamedTextLength += delta.text.length;
      this.emit('assistantText', sessionId, delta.text, itemId);
    } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking) {
      turn.streamedMessages.add(turn.messageId);
      this.emit('assistantReasoning', sessionId, delta.thinking, itemId);
    }
  }

  /** A complete assistant message. Text and thinking that already streamed
   *  are not repeated; tool calls always come from here. */
  private handleAssistantMessage(sessionId: string, turn: ActiveTurn, message: JsonRecord): void {
    const messageId = nonEmptyString(message.id) ?? `msg_${Date.now()}`;
    const streamed = turn.streamedMessages.has(messageId);
    const content = Array.isArray(message.content) ? message.content : [];
    for (const [blockIdx, block] of content.entries()) {
      const b = record(block);
      const itemId = nonEmptyString(b.id) ?? `${messageId}_${blockIdx}`;
      if (b.type === 'text' && typeof b.text === 'string' && b.text.length > 0) {
        if (streamed) continue;
        turn.streamedAnyText = true;
        turn.streamedTextLength += b.text.length;
        this.emit('assistantText', sessionId, b.text, itemId);
      } else if (b.type === 'thinking' || b.type === 'reasoning') {
        const text = typeof (b.thinking ?? b.text) === 'string' ? String(b.thinking ?? b.text) : '';
        if (streamed || !text) continue;
        this.emit('assistantReasoning', sessionId, text, itemId);
      } else if (b.type === 'tool_use') {
        const toolName = nonEmptyString(b.name) ?? 'unknown';
        // ExitPlanMode and AskUserQuestion reach Gian as can_use_tool
        // requests; the host tags them by toolName.
        this.emit('toolUse', sessionId, toolName, record(b.input), itemId);
      }
    }
  }

  private handleResult(session: ManagedSession, proc: ClaudeProcess, event: JsonRecord): void {
    // `modelUsage` is a running total; measure every run against the last
    // one, including runs Gian does not surface, so no usage is counted twice.
    const modelUsage = subtractClaudeModelUsage(event.modelUsage, proc.usageBaseline);
    if (isRecord(event.modelUsage)) proc.usageBaseline = claudeModelUsageTotals(event.modelUsage);

    const subtype = typeof event.subtype === 'string' ? event.subtype : null;
    const resultText = typeof event.result === 'string' ? event.result : '';
    const terminalReason = typeof event.terminal_reason === 'string' ? event.terminal_reason : null;
    const failed = event.is_error === true || terminalReason === 'api_error' || subtype !== 'success';
    const errorText = resultText
      || (terminalReason ? `Claude Code turn failed (${terminalReason}).` : 'Claude Code turn failed.');

    const turn = session.turn;
    if (!turn || !turn.live) {
      // An error before `initialize` was answered is Claude refusing to
      // start; keep it as the reason this turn's process died.
      if (turn && !proc.ready && failed) turn.resultError = errorText;
      // Otherwise a run that ended before this turn's opening message was
      // consumed: an interrupted earlier run, or one Claude started on its own.
      this.emit('debug', `[runtime] Result of a run outside the active turn for ${session.sessionId}`);
      if (!turn) this.armIdleTimer(session);
      return;
    }
    if (turn.interrupted) {
      this.finishTurn(session);
      return;
    }
    this.emit('debug', `[runtime] Run result for ${session.sessionId} (${subtype}): ${resultText.slice(0, 120)}...`);

    const usageUpdate = parseClaudeResultUsage(
      { ...event, modelUsage },
      turn.context,
      turn.model ?? session.detectedModelId ?? session.model,
    );
    if (usageUpdate) this.emit('tokenUsage', session.sessionId, usageUpdate);

    turn.resultError = failed ? errorText : null;
    // A steer that arrived as this run finished starts one more run.
    if (turn.unconsumed.size > 0) return;

    const error = turn.resultError;
    this.finishTurn(session);
    if (error) {
      this.emit(
        'turnFailed',
        session.sessionId,
        annotateBuiltinFallbackModelError(this.builtinFallbackActive, session.model, error),
        turn.streamedTextLength,
      );
      return;
    }
    // Text that already streamed is not repeated; a run that streamed none
    // (rare) still surfaces its final text.
    this.emit('channelReply', session.sessionId, turn.streamedAnyText ? '' : resultText);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private requireSession(sessionId: string): ManagedSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`No session found for ${sessionId}`);
    return session;
  }

  /** Host-provided HTTP MCP servers for this session, in a private file so
   *  their headers never appear in the process list. */
  private async writeMcpConfig(session: ManagedSession): Promise<string> {
    const path = join(tmpdir(), `cc-proxy-mcp-${process.pid}-${randomUUID()}.json`);
    const mcpServers = Object.fromEntries(session.mcpServers.map(server => [server.name, {
      type: 'http',
      url: server.url,
      ...(Object.keys(server.headers).length > 0 ? { headers: server.headers } : {}),
    }]));
    await writeFile(path, JSON.stringify({ mcpServers }), { encoding: 'utf8', mode: 0o600 });
    return path;
  }
}
