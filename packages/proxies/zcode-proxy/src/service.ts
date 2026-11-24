/**
 * Shared outer ZCode Proxy with Desktop-equivalent per-workspace inner
 * app-servers (ADR-0052). The existing adapter remains the owner of one
 * ZCode Protocol/1 runtime; this service only routes outer requests and owns
 * runtime lifecycle.
 */

import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  ModelFactStore,
  ServiceError,
  ZcodeV2Adapter,
  type DispatchOutcome,
  type WireRequest,
} from './adapter.js';
import {
  ZCodeTransport,
} from './inner/transport.js';
import type { OuterNotification } from './events.js';

interface RuntimeEntry {
  key: string;
  adapter: ZcodeV2Adapter;
  transport: ZCodeTransport;
  sessionIds: Set<string>;
  stopping: boolean;
}

interface SessionRoute {
  runtime: RuntimeEntry;
  nativeSessionId: string | null;
}

export interface ZcodeSharedServiceOptions {
  runtimeBin: string;
  nodeBin?: string;
  dataDir: string | null;
  catalogWorkspace: string;
  interactionEnabled: boolean;
  /** Complete app-server environment (buildAppServerEnvironment). */
  env: Readonly<Record<string, string>>;
  /** Stop an app-server after this long without requests, turns or native
   *  activity; it restarts with the next request. 0 disables. */
  idleTimeoutMs?: number;
  /** Interrupt confirmation deadline (tests). */
  interruptDeadlineMs?: number;
  onStderr?: (runtimeKey: string, line: unknown) => void;
  onDiagnostic?: (runtimeKey: string, info: unknown) => void;
}

/** How long an app-server may sit idle before it is stopped. */
export const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000;
/** Budget for initialize's runtime liveness probe. A slow start does not fail
 *  initialize; only an app-server that exits or cannot answer does. */
const STARTUP_PROBE_TIMEOUT_MS = 20_000;

/** Holds keep a session's notifications behind the Response of every
 *  request in flight for that session (Response-before-Notification). */
interface Hold {
  depth: number;
  buffer: OuterNotification[];
}

const SESSION_METHODS = new Set([
  'session.get',
  'turn.start',
  'turn.interrupt',
  'interaction.respond',
  'session.close',
  'session.replay',
  'session.rename',
  'turn.steer',
  'session.fork',
]);
// Addressed without an attached session: session.native.delete and the
// sidechat family are answered by the (shared) catalog runtime adapter,
// which rejects them with the documented capability errors.
const UNATTACHED_METHODS = new Set(['session.native.delete', 'sidechat.create', 'sidechat.resume', 'sidechat.close']);

export class ZcodeSharedService {
  private initializationParams: Record<string, unknown> | null = null;
  /** Model/thoughtLevel facts observed from live session snapshots; feeds the
   *  side-effect-free catalog (0.16.9 snapshots only report the current
   *  model, and the provider registry never crosses the protocol). */
  private readonly modelFacts = new ModelFactStore();
  private catalogRuntime: RuntimeEntry | null = null;
  private catalogRuntimePending: Promise<RuntimeEntry> | null = null;
  private readonly workspaceRuntimes = new Map<string, RuntimeEntry>();
  private readonly workspaceRuntimesPending = new Map<string, Promise<RuntimeEntry>>();
  private readonly sessionRoutes = new Map<string, SessionRoute>();
  private readonly nativeOwners = new Map<string, string>();
  private readonly holds = new Map<string, Hold>();
  private emitSink: (notification: OuterNotification) => void = () => undefined;
  private idleTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(private readonly options: ZcodeSharedServiceOptions) {
    const idleMs = this.idleTimeoutMs();
    if (idleMs > 0) {
      this.idleTimer = setInterval(() => { void this.stopIdleRuntimes(); }, Math.max(250, Math.min(60_000, Math.floor(idleMs / 4))));
      this.idleTimer.unref?.();
    }
  }

  private idleTimeoutMs(): number {
    return this.options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  }

  setEmitSink(sink: (notification: OuterNotification) => void): void {
    this.emitSink = sink;
  }

  /** Every adapter emits here: a notification for a session with a request
   *  in flight waits for that request's Response; anything else goes out at
   *  once. Session-less notifications (catalog.changed) follow '*' holds. */
  private route(notification: OuterNotification): void {
    const hold = this.holds.get(holdKeyOf(notification.params));
    if (hold !== undefined) hold.buffer.push(notification);
    else this.emitSink(notification);
  }

  /** Dispatch with adapter-owned ordering for the Proxy Kit: `respond` writes
   *  the Response, then the notifications that the request (or concurrent
   *  native activity on the same session) produced are released in order. */
  async dispatchOrdered(
    request: WireRequest,
    respond: (result: unknown, error?: unknown) => void,
  ): Promise<void> {
    const keys = requestHoldKeys(request);
    for (const key of keys) {
      const hold = this.holds.get(key) ?? { depth: 0, buffer: [] };
      hold.depth += 1;
      this.holds.set(key, hold);
    }
    try {
      const outcome = await this.dispatch(request);
      if (outcome.ok) respond(outcome.result);
      else respond(undefined, outcome.error);
    } finally {
      for (const key of keys) {
        const hold = this.holds.get(key);
        if (hold === undefined) continue;
        hold.depth -= 1;
        if (hold.depth > 0) continue;
        this.holds.delete(key);
        for (const notification of hold.buffer) this.emitSink(notification);
      }
    }
  }

  async dispatch(request: WireRequest): Promise<DispatchOutcome> {
    try {
      switch (request.method) {
        case 'initialize':
          return await this.initialize(request);
        case 'catalog.list':
        case 'catalog.resolve':
          return await this.dispatchCatalog(request);
        case 'session.native.list':
          return await this.dispatchCatalog(request);
        case 'session.create':
          return await this.createSession(request);
        case 'shutdown':
          return await this.shutdown(request);
        default:
          if (request.method === 'interaction.respond' && !this.options.interactionEnabled) {
            throw new ServiceError('CAPABILITY_NOT_SUPPORTED', 'interaction capability is not declared.');
          }
          if (UNATTACHED_METHODS.has(request.method)) return await this.dispatchCatalog(request);
          if (SESSION_METHODS.has(request.method)) return await this.dispatchSession(request);
          return await this.dispatchCatalog(request);
      }
    } catch (error) {
      return normalizeServiceError(error);
    }
  }

  private async initialize(request: WireRequest): Promise<DispatchOutcome> {
    if (this.initializationParams !== null) {
      throw new ServiceError('ALREADY_INITIALIZED', 'initialize can only be sent once.');
    }
    const runtime = await this.getOrCreateCatalogRuntime();
    const outcome = await runtime.adapter.dispatch(request);
    if (!outcome.ok) return outcome;
    // Contact the app-server once: a Runtime that cannot start (missing
    // builtin config, broken install, bad environment) fails initialize with
    // its own stderr instead of a later, opaque "exited" error.
    const probe = await runtime.adapter.probeLiveness(STARTUP_PROBE_TIMEOUT_MS);
    if (probe !== null) {
      runtime.stopping = true;
      if (this.catalogRuntime === runtime) this.catalogRuntime = null;
      await runtime.transport.stop();
      throw new ServiceError('RUNTIME_UNAVAILABLE', probe, true);
    }
    this.initializationParams = { ...request.params };
    return outcome;
  }

  private async dispatchCatalog(request: WireRequest): Promise<DispatchOutcome> {
    this.requireInitialized();
    return (await this.getOrCreateCatalogRuntime()).adapter.dispatch(request);
  }

  private async createSession(request: WireRequest): Promise<DispatchOutcome> {
    this.requireInitialized();
    const sessionId = requiredString(request.params, 'sessionId');
    const existing = this.sessionRoutes.get(sessionId);
    const workspace = request.params.workspace as Record<string, unknown> | undefined;
    const cwd = requiredString(workspace ?? {}, 'cwd');
    const runtime = existing?.runtime ?? await this.getOrCreateWorkspaceRuntime(cwd);
    const outcome = await runtime.adapter.dispatch(request);
    if (!outcome.ok) return outcome;

    const session = (outcome.result as { session?: Record<string, unknown> } | undefined)?.session;
    const native = session?.nativeSession as Record<string, unknown> | undefined;
    const nativeSessionId = typeof native?.id === 'string' ? native.id : null;
    runtime.sessionIds.add(sessionId);
    this.sessionRoutes.set(sessionId, { runtime, nativeSessionId });
    if (nativeSessionId) this.nativeOwners.set(nativeSessionId, sessionId);
    return outcome;
  }

  private async dispatchSession(request: WireRequest): Promise<DispatchOutcome> {
    this.requireInitialized();
    // session.fork addresses the SOURCE session; params.sessionId names the
    // new child Gian session and is not attached yet.
    const routingId = request.method === 'session.fork'
      ? requiredString(request.params, 'sourceSessionId')
      : requiredString(request.params, 'sessionId');
    const route = this.sessionRoutes.get(routingId);
    if (!route) throw new ServiceError('SESSION_NOT_FOUND', `Session ${routingId} is not attached.`);
    const outcome = await route.runtime.adapter.dispatch(request);
    if (request.method === 'session.fork' && outcome.ok) {
      // The adapter created (or rolled back) the child adapter record; the
      // Shared Service must atomically register the child's route in the same
      // step, or the first child turn.start dies with "Session ... is not
      // attached" (live-verified 0.16.9). The adapter only reports a child
      // after its record, native id, and ownership are committed.
      const session = (outcome.result as { session?: Record<string, unknown> } | undefined)?.session;
      const childId = typeof session?.id === 'string' ? session.id : null;
      const native = session?.nativeSession as Record<string, unknown> | undefined;
      const nativeId = typeof native?.id === 'string' && native.id !== '' ? native.id : null;
      if (childId !== null) {
        route.runtime.sessionIds.add(childId);
        this.sessionRoutes.set(childId, { runtime: route.runtime, nativeSessionId: nativeId });
        if (nativeId !== null) this.nativeOwners.set(nativeId, childId);
      }
    }
    if (request.method === 'session.close' && outcome.ok) {
      this.sessionRoutes.delete(routingId);
      route.runtime.sessionIds.delete(routingId);
      if (route.nativeSessionId && this.nativeOwners.get(route.nativeSessionId) === routingId) {
        this.nativeOwners.delete(route.nativeSessionId);
      }
      if (route.runtime.sessionIds.size === 0) await this.stopWorkspaceRuntime(route.runtime);
    }
    return outcome;
  }

  private async shutdown(request: WireRequest): Promise<DispatchOutcome> {
    this.closed = true;
    if (this.idleTimer !== null) clearInterval(this.idleTimer);
    this.idleTimer = null;
    // Runtimes still starting must not outlive shutdown.
    await Promise.allSettled([
      ...this.catalogRuntimePending ? [this.catalogRuntimePending] : [],
      ...this.workspaceRuntimesPending.values(),
    ]);
    const runtimes = [
      ...this.catalogRuntime ? [this.catalogRuntime] : [],
      ...this.workspaceRuntimes.values(),
    ];
    let first: DispatchOutcome | null = null;
    for (const runtime of runtimes) {
      runtime.stopping = true;
      const outcome = await runtime.adapter.dispatch(request);
      first ??= outcome;
    }
    this.catalogRuntime = null;
    this.workspaceRuntimes.clear();
    this.sessionRoutes.clear();
    this.nativeOwners.clear();
    return first ?? { ok: true, result: { ok: true }, notifications: [] };
  }

  /** Stop the app-server of every idle runtime; requests restart it. */
  private async stopIdleRuntimes(): Promise<void> {
    if (this.closed) return;
    const idleMs = this.idleTimeoutMs();
    const now = Date.now();
    const runtimes = [
      ...this.catalogRuntime ? [this.catalogRuntime] : [],
      ...this.workspaceRuntimes.values(),
    ];
    for (const runtime of runtimes) {
      if (runtime.stopping || !runtime.adapter.isIdle(now, idleMs)) continue;
      this.options.onDiagnostic?.(runtime.key, { kind: 'idle-stop', idleMs });
      await runtime.adapter.park().catch(() => undefined);
    }
  }

  /** Release every app-server (kit close, EOF or signal). */
  async close(): Promise<void> {
    if (this.closed && this.catalogRuntime === null && this.workspaceRuntimes.size === 0) return;
    await this.shutdown({ id: 'internal-close', method: 'shutdown', params: {} });
  }

  private getOrCreateCatalogRuntime(): Promise<RuntimeEntry> {
    if (this.catalogRuntime) return Promise.resolve(this.catalogRuntime);
    // Concurrent catalog requests share one start.
    this.catalogRuntimePending ??= this.createCatalogRuntime()
      .finally(() => { this.catalogRuntimePending = null; });
    return this.catalogRuntimePending;
  }

  private async createCatalogRuntime(): Promise<RuntimeEntry> {
    const workspace = resolve(this.options.catalogWorkspace);
    mkdirSync(workspace, { recursive: true });
    const runtime = this.createRuntime('catalog', workspace);
    this.catalogRuntime = runtime;
    if (this.initializationParams !== null) {
      const initialized = await runtime.adapter.dispatch({
        id: `internal-initialize-${runtimeId('catalog')}`,
        method: 'initialize',
        params: { ...this.initializationParams },
      });
      if (!initialized.ok) {
        runtime.stopping = true;
        if (this.catalogRuntime === runtime) this.catalogRuntime = null;
        await runtime.transport.stop();
        throw new Error(initialized.error?.message ?? 'ZCode catalog runtime initialization failed.');
      }
    }
    return runtime;
  }

  private getOrCreateWorkspaceRuntime(cwd: string): Promise<RuntimeEntry> {
    const workspace = resolve(cwd);
    const key = `workspace:${workspace}`;
    const existing = this.workspaceRuntimes.get(key);
    if (existing) return Promise.resolve(existing);
    // Two sessions of one workspace starting together share one app-server.
    let pending = this.workspaceRuntimesPending.get(key);
    if (pending === undefined) {
      pending = this.createWorkspaceRuntime(key, workspace)
        .finally(() => { this.workspaceRuntimesPending.delete(key); });
      this.workspaceRuntimesPending.set(key, pending);
    }
    return pending;
  }

  private async createWorkspaceRuntime(key: string, workspace: string): Promise<RuntimeEntry> {
    const runtime = this.createRuntime(key, workspace);
    const initialized = await runtime.adapter.dispatch({
      id: `internal-initialize-${runtimeId(key)}`,
      method: 'initialize',
      params: { ...this.initializationParams },
    });
    if (!initialized.ok) {
      runtime.stopping = true;
      await runtime.transport.stop();
      throw new Error(initialized.error?.message ?? 'ZCode workspace runtime initialization failed.');
    }
    this.workspaceRuntimes.set(key, runtime);
    return runtime;
  }

  private createRuntime(key: string, workspace: string): RuntimeEntry {
    const dataDir = this.options.dataDir
      ? join(this.options.dataDir, key === 'catalog' ? 'catalog' : 'workspaces', runtimeId(key))
      : null;
    if (dataDir) mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const transport = new ZCodeTransport({
      runtimeBin: this.options.runtimeBin,
      ...(this.options.nodeBin ? { nodeBin: this.options.nodeBin } : {}),
      cwd: workspace,
      launchMode: 'desktop-stdio',
      env: this.options.env,
    });
    const adapter = new ZcodeV2Adapter(transport, {
      dataDir,
      catalogWorkspace: workspace,
      interactionEnabled: this.options.interactionEnabled,
      runtimeBin: this.options.runtimeBin,
      isNativeSessionOwned: nativeSessionId => this.nativeOwners.has(nativeSessionId),
      modelFacts: this.modelFacts,
      onDiagnostic: info => this.options.onDiagnostic?.(key, info),
      ...(this.options.interruptDeadlineMs !== undefined ? { interruptDeadlineMs: this.options.interruptDeadlineMs } : {}),
    });
    adapter.setEmitSink(notification => this.route(notification));
    const runtime: RuntimeEntry = { key, adapter, transport, sessionIds: new Set(), stopping: false };
    transport.on('stderr', (line: unknown) => this.options.onStderr?.(key, line));
    transport.on('diagnostic', (info: unknown) => this.options.onDiagnostic?.(key, info));
    transport.on('exit', () => {
      if (runtime.stopping || adapter.isParked()) return;
      if (this.catalogRuntime === runtime) this.catalogRuntime = null;
      if (this.workspaceRuntimes.get(key) === runtime) this.workspaceRuntimes.delete(key);
      for (const sessionId of runtime.sessionIds) {
        const route = this.sessionRoutes.get(sessionId);
        if (route?.runtime === runtime) {
          this.sessionRoutes.delete(sessionId);
          if (route.nativeSessionId && this.nativeOwners.get(route.nativeSessionId) === sessionId) {
            this.nativeOwners.delete(route.nativeSessionId);
          }
        }
      }
    });
    transport.start();
    return runtime;
  }

  private async stopWorkspaceRuntime(runtime: RuntimeEntry): Promise<void> {
    runtime.stopping = true;
    if (this.workspaceRuntimes.get(runtime.key) === runtime) this.workspaceRuntimes.delete(runtime.key);
    await runtime.adapter.dispatch({ id: `internal-shutdown-${runtimeId(runtime.key)}`, method: 'shutdown', params: {} });
  }

  private requireInitialized(): void {
    if (this.initializationParams === null) {
      throw new ServiceError('NOT_INITIALIZED', 'initialize must be the first request.');
    }
  }
}

function holdKeyOf(params: Record<string, unknown>): string {
  return typeof params.sessionId === 'string' && params.sessionId !== '' ? `session:${params.sessionId}` : '*';
}

/** The sessions whose notifications a request must not overtake. */
function requestHoldKeys(request: WireRequest): string[] {
  const keys = new Set<string>();
  for (const field of ['sessionId', 'sourceSessionId']) {
    const value = request.params[field];
    if (typeof value === 'string' && value !== '') keys.add(`session:${value}`);
  }
  if (keys.size === 0) keys.add('*');
  return [...keys];
}

function runtimeId(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== 'string' || field.length === 0) {
    throw new ServiceError('INVALID_PARAMS', `params.${key} must be a non-empty string.`);
  }
  return field;
}

function normalizeServiceError(error: unknown): DispatchOutcome {
  if (error instanceof ServiceError) {
    return {
      ok: false,
      error: {
        code: error.domainCode === 'INVALID_PARAMS' ? -32602 : -32000,
        message: error.message,
        data: { domainCode: error.domainCode, retryable: error.retryable, details: {} },
      },
      notifications: [],
    };
  }
  return {
    ok: false,
    error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
    notifications: [],
  };
}
