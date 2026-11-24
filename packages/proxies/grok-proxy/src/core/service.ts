import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { OfficialQuotaReadParams, ProxyOfficialQuotaReadResult } from '@gian/proxy-protocol';
import { quotaFailure } from '@gian/proxy-protocol/node';

import type {
  AvailableCommand,
  InitializeResponse,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from '@agentclientprotocol/sdk';

import {
  catalogFromModelState,
  commandsFromUnknown,
  effortIdsForModel,
  modelStateFromUnknown,
  type GrokModelState,
} from './catalog.js';
import {
  createAppError,
  GROK_SIGN_IN_HINT,
  GrokProxyError,
  isAcpAuthRequired,
  nativeErrorDetails,
  nativeErrorText,
} from './errors.js';
import { promptTurnUsage } from './events.js';
import { firstText, normalizeInputItems, toInterjectPayload, toPromptBlocks } from './input.js';
import {
  admitHostStreamableHttpServices,
  McpAdmissionError,
  mcpBoundaryProblem,
  mcpSpawnDenyRules,
  readMcpListPayload,
  scanDiskConfiguredMcpServers,
  type AdmittedHostMcp,
} from './mcp-isolation.js';
import {
  grokPermissionSpec,
  parseGrokPermissionMode,
  type GrokPermissionMode,
} from './permissions.js';
import { parseGrokSandboxProfile, type GrokSandboxProfile } from './sandbox.js';
import { firstSlashToken, isBlockedSlashCommand } from './slash-policy.js';
import type { GrokCustomizationRuntimeAccess } from './customization.js';
import type {
  ApprovalResponseParams,
  CloseSessionParams,
  CreateSessionParams,
  GetSessionParams,
  InterruptTurnParams,
  ListNativeSessionsParams,
  PendingApproval,
  PendingQuestion,
  QuestionOutcome,
  SessionRecord,
  SetConfigOptionParams,
  StartTurnParams,
} from './types.js';
import { nowIso, randomId } from './utils.js';
import { GrokExtBusinessError } from '../runtime/acp-wire.js';
import {
  GrokAcpClient,
  GROK_ORIGIN_CLIENT_ID,
  GrokExtMethodUnsupportedError,
  GrokRuntimeExitError,
  describeExit,
  isMethodNotFound,
  type GrokNativeForkResponse,
} from '../runtime/grok-acp-client.js';

interface SpawnBoundary {
  spawnDenyRules: readonly string[];
  sandboxProfile: GrokSandboxProfile;
  disallowMetaTools: boolean;
}

interface PermissionRow {
  draft: GrokPermissionMode;
  notified: GrokPermissionMode | null;
  turnSnapshot: GrokPermissionMode | null;
  /** Session `_meta.clientIdentifier`. The native permission matcher keys on this, not on sessionId. */
  audience: string;
}

type ProxyEventSink = (method: string, params: Record<string, unknown>) => void;

interface ActiveTurn {
  turnId: string;
  completed: boolean;
  generation: number;
  /** Resolves when the native prompt call returns, whether it succeeded or failed. */
  settled: Promise<void>;
  markSettled: () => void;
  /** Armed by an interrupt: forces the child down if the prompt never settles. */
  watchdog?: ReturnType<typeof setTimeout>;
}

/** How long an idle attached Grok child is kept before it is stopped; the
 *  next turn resumes the native session in a new child. The clock does not
 *  run while a turn, an interaction or a background task is in progress,
 *  and any native update starts it again. Override with
 *  `GIAN_GROK_IDLE_TIMEOUT_MS` (`0` keeps children until the session
 *  closes). */
export const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000;

/** Grok 1.0.92 reports a background task as `running` and then `completed`,
 *  `failed` or `stopped`. A task without a status, or in a waiting state, is
 *  still in progress. */
function backgroundTaskActive(status: unknown): boolean {
  if (status === undefined || status === null) return true;
  return ['running', 'pending', 'queued', 'starting'].includes(String(status).toLowerCase());
}
/** How long an interrupted prompt may take to settle before the child is
 *  stopped so the session can take a new turn. */
export const DEFAULT_INTERRUPT_DEADLINE_MS = 10_000;

function idleTimeoutFromEnv(): number {
  const raw = process.env.GIAN_GROK_IDLE_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_IDLE_TIMEOUT_MS;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : DEFAULT_IDLE_TIMEOUT_MS;
}

/** Child generation of a runtime. Minimal doubles without the counter are
 *  one long-lived child. */
function runtimeGeneration(runtime: GrokAcpClient): number {
  const value = (runtime as { generation?: unknown }).generation;
  return typeof value === 'number' ? value : 1;
}

function runtimeRunning(runtime: GrokAcpClient): boolean {
  const value = (runtime as { running?: unknown }).running;
  return typeof value === 'boolean' ? value : true;
}

/** One ACP SessionConfigOption, as Grok 1.0.92 sends it. */
interface NativeConfigOption {
  id: string;
  category?: string;
  currentValue?: unknown;
  options?: Array<{ value?: unknown; name?: unknown }>;
}

function nativeConfigOptions(value: unknown): NativeConfigOption[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((item): item is NativeConfigOption => (
    Boolean(item) && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string'
  ));
}

function nativeOption(options: readonly NativeConfigOption[], id: string, category: string) {
  return options.find((option) => option.id === id) ?? options.find((option) => option.category === category);
}

function optionValues(option: NativeConfigOption | undefined): string[] {
  return (option?.options ?? []).flatMap((item) => typeof item?.value === 'string' ? [item.value] : []);
}

export interface ServiceOptions {
  binaryPath: string;
  createRuntime?: (cwd: string, spawn: SpawnBoundary) => GrokAcpClient;
  emitEvent?: ProxyEventSink;
  /** How long cancel may take, and how long the prompt may take to finish, before the child is killed. */
  turnStopDeadlineMs?: number;
  /** This Proxy's version, sent as the ACP clientInfo version. */
  pluginVersion?: string;
  /** Idle stop delay for the attached child; 0 disables it. */
  idleTimeoutMs?: number;
  /** Interrupt watchdog deadline. */
  interruptDeadlineMs?: number;
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw createAppError(400, 'INVALID_REQUEST', `${field} is required.`);
  }
  return value.trim();
}

function recordField(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const raw = value[key];
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

function isStructuredNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { code?: unknown; status?: unknown; data?: unknown };
  if (value.status === 404 || value.code === 404 || value.code === -32001) return true;
  if (value.data && typeof value.data === 'object') {
    const data = value.data as { code?: unknown; domainCode?: unknown; error?: unknown };
    return data.code === 'SESSION_NOT_FOUND'
      || data.code === 'NATIVE_SESSION_NOT_FOUND'
      || data.code === 'not_found'
      || data.domainCode === 'NATIVE_SESSION_NOT_FOUND'
      || data.error === 'not_found';
  }
  return false;
}

async function nativeSessionListed(runtime: GrokAcpClient, nativeSessionId: string): Promise<boolean> {
  let cursor: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const listed = await runtime.listSessions({
      ...(cursor ? { cursor } : {}),
    }) as { sessions?: Array<{ sessionId?: string }>; nextCursor?: string | null };
    if ((listed.sessions ?? []).some((item) => item.sessionId === nativeSessionId)) return true;
    if (!listed.nextCursor) return false;
    cursor = listed.nextCursor;
  }
  return false;
}

interface PreparedTurn {
  session: SessionRecord;
  turnId: string;
  input: ReturnType<typeof normalizeInputItems>;
  generation: number;
}

/**
 * Maps a runtime failure to a Proxy error. Sign-in is decided by the ACP
 * auth code, never by words in the message: a BYOK provider's 401 is an
 * ordinary runtime error. The CLI's own text is kept, and its JSON-RPC code
 * travels in `details`.
 */
export function mapRuntimeError(error: unknown, binaryPath?: string): GrokProxyError {
  if (error instanceof GrokProxyError) return error;
  if (error instanceof GrokExtBusinessError) {
    return createAppError(502, 'RUNTIME_ERROR', error.message);
  }
  if (error instanceof GrokExtMethodUnsupportedError) {
    return createAppError(400, 'CAPABILITY_NOT_SUPPORTED', error.message);
  }
  if (error instanceof McpAdmissionError) {
    return createAppError(400, 'INVALID_REQUEST', error.message);
  }
  const native = nativeErrorText(error);
  const details = {
    ...nativeErrorDetails(error),
    ...(error instanceof GrokRuntimeExitError
      ? {
        exitCode: error.exit.code,
        ...(error.exit.signal ? { signal: error.exit.signal } : {}),
      }
      : {}),
  };
  if (isAcpAuthRequired(error)) {
    return createAppError(
      401,
      'AUTH_REQUIRED',
      `${GROK_SIGN_IN_HINT} (Grok: ${native}${binaryPath ? `; ${binaryPath}` : ''})`,
      details,
    );
  }
  return createAppError(502, 'RUNTIME_ERROR', native, details);
}

function isConnectionClosed(error: unknown): boolean {
  return error instanceof Error && /ACP connection closed/i.test(error.message);
}

/** Feature-detect newer GrokAcpClient surface so minimal runtime doubles keep working. */
function runtimeExtensionSupport(runtime: GrokAcpClient | null): {
  supports(method: string): boolean;
  mayAttempt?(method: string): boolean;
} | null {
  const candidate = runtime as {
    extensions?: { supports(method: string): boolean; mayAttempt?(method: string): boolean };
  } | null;
  return candidate?.extensions ?? null;
}

export class GrokProxyService {
  private readonly binaryPath: string;
  private readonly createRuntime: (cwd: string, spawn: SpawnBoundary) => GrokAcpClient;
  private emitEvent: ProxyEventSink;
  private runtime: GrokAcpClient | null = null;
  private runtimeCwd: string | null = null;
  private readonly sessionsById = new Map<string, SessionRecord>();
  private readonly proxyIdByNativeId = new Map<string, string>();
  private readonly unclaimedUpdates = new Map<string, SessionNotification[]>();
  private readonly replayCollectors = new Map<string, SessionNotification[]>();
  private modelState: GrokModelState = {};
  private capabilityInspection: Promise<InitializeResponse> | null = null;
  private stagedPermission: GrokPermissionMode = 'default';
  private sandboxProfile: GrokSandboxProfile = 'workspace';
  private readonly permissionBySession = new Map<string, PermissionRow>();
  private mcpBlockedReason: string | null = null;
  private slashCommands: AvailableCommand[] = [];
  private readonly activeTurns = new Map<string, ActiveTurn>();
  private readonly approvalsById = new Map<string, PendingApproval>();
  private readonly questionsById = new Map<string, PendingQuestion>();
  /** Bounded record of settled question responses for idempotent replays. */
  private readonly settledQuestionResponses = new Map<string, {
    actionId: string;
    values: Record<string, unknown>;
  }>();
  private promptGeneration = 0;
  private forkSupported = false;
  /** Remembered x.ai/session/fork support from the last runtime initialize. */
  private nativeForkSupported = false;
  /** Host-approved MCP servers admitted before the runtime spawns. */
  private admittedHostMcp: AdmittedHostMcp | null = null;
  private readonly turnStopDeadlineMs: number;
  /**
   * Sessions whose turn is being cancelled or closed. While listed, new
   * reverse permission/question requests settle as cancelled immediately
   * instead of becoming pending requests nobody will answer.
   */
  private readonly cancellingSessions = new Set<string>();
  /** How the attached child last died, for prompts that failed with it. */
  private lastUnexpectedExit: { message: string; details: Record<string, unknown> } | null = null;
  private readonly idleTimeoutMs: number;
  private readonly interruptDeadlineMs: number;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Background tasks still running in the attached child, as
   *  `<native session>:<task id>`. Grok ends the prompt that starts one at
   *  once, reports the task through x.ai notifications and, when it ends,
   *  runs a turn of its own. Stopping the child would kill both. */
  private readonly backgroundTasks = new Set<string>();
  /** In-flight re-attach of a native session into a new child, by session. */
  private readonly reattaching = new Map<string, Promise<GrokAcpClient>>();

  constructor(options: ServiceOptions) {
    this.binaryPath = options.binaryPath;
    this.turnStopDeadlineMs = options.turnStopDeadlineMs ?? 1000;
    this.idleTimeoutMs = options.idleTimeoutMs ?? idleTimeoutFromEnv();
    this.interruptDeadlineMs = options.interruptDeadlineMs ?? DEFAULT_INTERRUPT_DEADLINE_MS;
    this.createRuntime = options.createRuntime
      ?? ((cwd, spawn) => new GrokAcpClient({
        binaryPath: options.binaryPath,
        cwd,
        ...(options.pluginVersion ? { clientVersion: options.pluginVersion } : {}),
        spawnDenyRules: spawn.spawnDenyRules,
        sandboxProfile: spawn.sandboxProfile,
        disallowMetaTools: spawn.disallowMetaTools,
      }));
    this.emitEvent = options.emitEvent ?? (() => undefined);
  }

  setEventSink(handler: ProxyEventSink): void {
    this.emitEvent = handler;
  }

  private auxBoundary(): SpawnBoundary {
    return {
      spawnDenyRules: ['MCPTool(*)'],
      sandboxProfile: 'workspace',
      disallowMetaTools: true,
    };
  }

  private newPermissionAudience(): string {
    return `${GROK_ORIGIN_CLIENT_ID}:${randomId('aud')}`;
  }

  private permissionRow(sessionId: string): PermissionRow {
    const existing = this.permissionBySession.get(sessionId);
    if (existing) return existing;
    const created: PermissionRow = {
      draft: this.stagedPermission,
      notified: null,
      turnSnapshot: null,
      audience: this.newPermissionAudience(),
    };
    this.permissionBySession.set(sessionId, created);
    return created;
  }

  private catalogPermissionMode(): GrokPermissionMode {
    const sessions = [...this.sessionsById.values()];
    const only = sessions.length === 1 ? sessions[0] : undefined;
    if (only) return this.permissionRow(only.id).draft;
    return this.stagedPermission;
  }

  private displayedPermission(session: SessionRecord): GrokPermissionMode {
    const row = this.permissionBySession.get(session.id);
    if (!row) return this.stagedPermission;
    if (session.activeTurnId && row.turnSnapshot) return row.turnSnapshot;
    return row.draft;
  }

  /** Same-binary probe used at initialize. Aux processes stay on workspace. */
  async probeInterjectSupport(): Promise<boolean> {
    const aux = this.createRuntime(resolve(tmpdir()), this.auxBoundary());
    try {
      const probe = (aux as { probeInterjectRegistered?: () => Promise<'confirmed' | 'refuted' | 'unknown'> }).probeInterjectRegistered;
      if (typeof probe !== 'function') return false;
      return await probe.call(aux) === 'confirmed';
    } catch {
      return false;
    } finally {
      await aux.stop();
    }
  }

  async listCapabilities() {
    const inspection = this.capabilityInspection ??= this.inspectCapabilities();
    try {
      const initialized = await inspection;
      // An empty model snapshot can be transient; do not make it sticky.
      if ((this.modelState.availableModels?.length ?? 0) === 0
        && this.capabilityInspection === inspection) {
        this.capabilityInspection = null;
      }
      const catalog = catalogFromModelState(this.modelState, this.catalogPermissionMode(), this.sandboxProfile);
      return {
        ...initialized,
        ...catalog,
        slashCommands: this.slashCommands,
      };
    } catch (error) {
      if (this.capabilityInspection === inspection) this.capabilityInspection = null;
      throw error;
    }
  }

  async readOfficialQuota(params: OfficialQuotaReadParams): Promise<ProxyOfficialQuotaReadResult> {
    const aux = this.createRuntime(resolve(tmpdir()), this.auxBoundary());
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        aux.readOfficialQuota(params),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 25_000); }),
      ]);
    } catch (error) {
      return quotaFailure(error, null);
    } finally {
      if (timer) clearTimeout(timer);
      // This is a disposable inspection child, never an attached session.
      await aux.stop({ force: true });
    }
  }

  /** One process-local metadata snapshot; never shared across Agent HOME profiles. */
  private async inspectCapabilities(): Promise<InitializeResponse> {
    const aux = this.createRuntime(resolve(tmpdir()), this.auxBoundary());
    try {
      const initialized = await aux.ensureStarted();
      this.forkSupported = initialized.agentCapabilities?.sessionCapabilities?.fork != null;
      const auxExtensions = runtimeExtensionSupport(aux);
      this.nativeForkSupported = auxExtensions?.supports('x.ai/session/fork') === true;
      const meta = (initialized as { _meta?: Record<string, unknown> })._meta ?? {};
      this.modelState = modelStateFromUnknown(meta.modelState);
      this.slashCommands = commandsFromUnknown(meta.availableCommands) as AvailableCommand[];
      return initialized;
    } catch (error) {
      throw mapRuntimeError(error, this.binaryPath);
    } finally {
      await aux.stop({ force: true });
    }
  }

  supportsFork(): boolean {
    // Native x.ai/session/fork is preferred; the standard ACP fork capability
    // remains a fallback for runtimes that advertise it.
    const extensions = runtimeExtensionSupport(this.runtime);
    if (extensions?.supports('x.ai/session/fork') === true) return true;
    return this.forkSupported
      || this.runtime?.negotiated?.agentCapabilities?.sessionCapabilities?.fork != null;
  }

  /** Whether exact-turn forks (targetPromptIndex) are available natively. */
  supportsAtTurnFork(): boolean {
    const extensions = runtimeExtensionSupport(this.runtime);
    if (extensions) return extensions.supports('x.ai/session/fork') === true;
    return this.nativeForkSupported;
  }

  /**
   * True while a real fork request may double as the confirming call: the
   * runtime is the stdio grok agent and `x.ai/session/fork` is not refuted on
   * this attach. The Proxy never probes the method — it creates sessions on
   * disk — so only a user-requested fork can confirm it.
   */
  mayAttemptNativeFork(): boolean {
    return runtimeExtensionSupport(this.runtime)?.mayAttempt?.('x.ai/session/fork') === true;
  }

  /**
   * Admit Host Streamable HTTP MCP services before the runtime spawns. The
   * admitted list also selects the spawn-time MCP deny rules (see
   * mcp-isolation.ts), so it is immutable once the runtime has started.
   */
  setHostMcpServices(hostServices: unknown): void {
    if (this.runtime) {
      throw createAppError(
        409,
        'CONFLICT',
        'Host MCP services must be provided before the Grok runtime starts; the MCP isolation boundary is fixed at spawn.',
      );
    }
    if (hostServices === undefined || hostServices === null) {
      this.admittedHostMcp = null;
      return;
    }
    this.admittedHostMcp = admitHostStreamableHttpServices(hostServices);
  }

  get hostMcpServerNames(): readonly string[] {
    return this.admittedHostMcp?.names ?? [];
  }

  get hostMcpServers(): Array<Record<string, unknown>> {
    return this.admittedHostMcp?.servers ?? [];
  }

  async listNativeSessions(params: ListNativeSessionsParams) {
    const cwd = params.cwd ? resolve(params.cwd) : resolve(tmpdir());
    const aux = this.createRuntime(cwd, this.auxBoundary());
    try {
      await aux.ensureStarted();
      return await aux.listSessions({
        cwd,
        ...(params.cursor ? { cursor: params.cursor } : {}),
      });
    } catch (error) {
      throw mapRuntimeError(error, this.binaryPath);
    } finally {
      await aux.stop();
    }
  }

  async createSession(input: CreateSessionParams) {
    if (this.sessionsById.size > 0 && input.allowAdditional !== true) {
      throw createAppError(409, 'NATIVE_SESSION_ATTACHED', 'This Grok Proxy already has an attached session.');
    }
    const cwd = resolve(nonEmptyString(input.cwd, 'cwd'));
    if (input.mcpServers && input.mcpServers.length > 0 && !this.admittedHostMcp) {
      throw createAppError(400, 'CAPABILITY_NOT_SUPPORTED', 'Only admitted Host Streamable HTTP MCP servers are supported.');
    }
    if (input.sandboxProfile) this.setSandboxProfile(input.sandboxProfile);
    const runtime = await this.ensureRuntime(cwd);
    const importHistory = Boolean(input.nativeSessionId?.trim()) && input.resumeMode !== 'resume';
    const nativeId = input.nativeSessionId?.trim() || null;
    if (importHistory && nativeId) this.replayCollectors.set(nativeId, []);
    try {
      // An idle-stopped child is started again before another session (a
      // Side Chat or fork) is attached to it.
      const initialized = runtime.negotiated ?? await runtime.ensureStarted();
      const meta = (initialized as { _meta?: Record<string, unknown> } | null)?._meta ?? {};
      if (this.modelState.availableModels == null) {
        this.modelState = modelStateFromUnknown(meta.modelState);
      }
      this.slashCommands = commandsFromUnknown(meta.availableCommands) as AvailableCommand[];
      const mode = input.permissionMode ?? this.stagedPermission;
      this.stagedPermission = mode;
      const permission = grokPermissionSpec(mode);
      const audience = this.newPermissionAudience();
      const sessionMeta = {
        mode: 'agent',
        clientIdentifier: audience,
        ...permission.createMeta,
      };
      const hostMcp = this.hostMcpServers as never[];
      const response = nativeId
        ? input.resumeMode === 'resume'
          ? await runtime.resumeSession({ sessionId: nativeId, cwd, mcpServers: hostMcp, _meta: sessionMeta })
          : await runtime.loadSession({ sessionId: nativeId, cwd, mcpServers: hostMcp, _meta: sessionMeta })
        : await runtime.newSession({
          cwd,
          mcpServers: hostMcp,
          _meta: sessionMeta,
        } as never);
      const sessionId = typeof (response as { sessionId?: unknown }).sessionId === 'string'
        ? (response as { sessionId: string }).sessionId
        : nativeId;
      if (!sessionId) throw createAppError(502, 'RUNTIME_ERROR', 'Grok did not return a session id.');
      if (this.proxyIdByNativeId.has(sessionId)) {
        throw createAppError(409, 'NATIVE_SESSION_ATTACHED', `Native Grok session ${sessionId} is already attached.`);
      }
      if (this.admittedHostMcp) await this.assertHostMcpBoundary(sessionId);
      const isNewNativeSession = !nativeId;
      this.adoptModelList(response, isNewNativeSession);
      const session: SessionRecord = {
        id: randomId('sess'),
        cwd,
        nativeSessionId: sessionId,
        status: 'idle',
        activeTurnId: null,
        configOptions: [],
        slashCommands: this.slashCommands,
        mcpServers: [...hostMcp] as SessionRecord['mcpServers'],
        attached: true,
        lastError: null,
        // A brand-new native session evidences the runtime's default model.
        // A loaded/resumed one only knows what a native update or the fork
        // parent proved — never the process-wide initialize default.
        model: isNewNativeSession
          ? this.modelState.currentModelId ?? null
          : input.initialModel ?? null,
        effort: isNewNativeSession
          ? this.defaultEffortForModel(this.modelState.currentModelId ?? null)
          : input.initialEffort ?? null,
        attachedGeneration: runtimeGeneration(runtime),
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      // The native session's own config (Grok 1.0.92 configOptions) is the
      // evidence for its model and effort, also after a load or resume.
      this.adoptNativeConfig(session, (response as { configOptions?: unknown }).configOptions);
      this.permissionBySession.set(session.id, {
        draft: mode,
        notified: mode,
        turnSnapshot: null,
        audience,
      });
      this.sessionsById.set(session.id, session);
      this.proxyIdByNativeId.set(session.nativeSessionId, session.id);
      const replayUpdates = this.replayCollectors.get(session.nativeSessionId)
        ?? this.unclaimedUpdates.get(session.nativeSessionId)
        ?? [];
      this.replayCollectors.delete(session.nativeSessionId);
      this.unclaimedUpdates.delete(session.nativeSessionId);
      if (!importHistory) {
        for (const notification of replayUpdates) this.handleSessionUpdate(notification);
      }
      this.scheduleIdleStop();
      return {
        session: this.serializeSession(session),
        replayUpdates: importHistory ? replayUpdates : [],
      };
    } catch (error) {
      if (nativeId) this.replayCollectors.delete(nativeId);
      if (this.sessionsById.size === 0) await this.stopRuntime();
      throw mapRuntimeError(error, this.binaryPath);
    }
  }

  /**
   * Fork a session. Prefers the native `x.ai/session/fork` (supports
   * `targetPromptIndex` for exact-turn forks); falls back to the standard ACP
   * fork when the runtime advertises it (head-only). The native fork copies
   * session files without starting them, so the forked native session is
   * attached through `resume` in the same runtime.
   */
  async forkSession(params: { sessionId: string; targetPromptIndex?: number }) {
    const source = this.requireSession(params.sessionId);
    if (source.activeTurnId) {
      throw createAppError(409, 'SESSION_BUSY', 'Stop the active turn before forking the session.');
    }
    const runtime = await this.ensureAttached(source);
    const runtimeExtensions = runtimeExtensionSupport(runtime);
    const nativeConfirmed = runtimeExtensions?.supports('x.ai/session/fork') === true;
    // An exact-turn fork only runs on a confirmed native method; a silent
    // boundary change would fork at the wrong prompt. A head fork may be the
    // one real call that confirms the method on this attach.
    const tryNative = nativeConfirmed
      || (params.targetPromptIndex === undefined && this.mayAttemptNativeFork());
    if (!tryNative && !this.supportsFork()) {
      throw createAppError(400, 'CAPABILITY_NOT_SUPPORTED', 'Grok ACP does not advertise session/fork.');
    }

    let forked: { sessionId: string; configOptions?: unknown };
    let parentChildIsolation = false;
    let nativeResponse: GrokNativeForkResponse | null = null;
    if (tryNative) {
      try {
        nativeResponse = await runtime.nativeForkSession({
          sourceSessionId: source.nativeSessionId,
          sourceCwd: source.cwd,
          newCwd: source.cwd,
          ...(params.targetPromptIndex !== undefined
            ? { targetPromptIndex: params.targetPromptIndex }
            : {}),
        });
      } catch (error) {
        if (!(error instanceof GrokExtMethodUnsupportedError)) {
          // A real fork failure keeps its attribution; never rewrite it into
          // a semantically different operation.
          throw mapRuntimeError(error, this.binaryPath);
        }
        // Live refutation on the confirming call. Exact-turn forks have no
        // fallback; head forks may still use the standard ACP capability.
        if (params.targetPromptIndex !== undefined || !this.supportsFork()) {
          throw createAppError(400, 'CAPABILITY_NOT_SUPPORTED', error.message);
        }
      }
    }
    if (nativeResponse) {
      const response = nativeResponse;
      // The fork exists on disk only; attach it in this runtime via resume so
      // parent and child remain separate native sessions with stable ids. The
      // child inherits the parent's model/effort at fork time — proven by
      // newModelId when the runtime reports it, inherited otherwise.
      const attached = await this.createSession({
        cwd: source.cwd,
        nativeSessionId: response.newSessionId,
        resumeMode: 'resume',
        mcpServers: [...source.mcpServers],
        allowAdditional: true,
        permissionMode: this.permissionRow(source.id).draft,
        ...(response.newModelId ?? source.model
          ? { initialModel: response.newModelId ?? source.model! }
          : {}),
        ...(source.effort ? { initialEffort: source.effort } : {}),
      });
      forked = {
        sessionId: attached.session.nativeSessionId,
        configOptions: attached.session.configOptions,
      };
      parentChildIsolation = true;
    } else {
      const response = await runtime.forkSession({
        sessionId: source.nativeSessionId,
        cwd: source.cwd,
        mcpServers: source.mcpServers,
      });
      forked = { sessionId: response.sessionId, configOptions: response.configOptions };
    }
    const createdAt = nowIso();
    const session: SessionRecord = {
      ...source,
      id: randomId('sess'),
      nativeSessionId: forked.sessionId,
      attachedGeneration: runtimeGeneration(runtime),
      configOptions: (forked.configOptions as SessionRecord['configOptions']) ?? source.configOptions,
      slashCommands: [...source.slashCommands],
      activeTurnId: null,
      status: 'idle',
      lastError: null,
      createdAt,
      updatedAt: createdAt,
    };
    if (parentChildIsolation) {
      // createSession already registered the resumed fork; reuse that record
      // so native-id mapping stays 1:1 and both rows never claim one id.
      const existingId = this.proxyIdByNativeId.get(session.nativeSessionId);
      if (existingId) {
        const existing = this.sessionsById.get(existingId)!;
        return { session: this.serializeSession(existing) };
      }
    }
    const sourceRow = this.permissionRow(source.id);
    // Standard ACP fork does not take session `_meta`, so the child keeps the
    // parent's origin. Sharing the audience makes a divergent notify refuse
    // instead of widening both sessions.
    this.permissionBySession.set(session.id, {
      draft: sourceRow.draft,
      notified: sourceRow.notified,
      turnSnapshot: null,
      audience: sourceRow.audience,
    });
    this.sessionsById.set(session.id, session);
    this.proxyIdByNativeId.set(session.nativeSessionId, session.id);
    return { session: this.serializeSession(session) };
  }

  async listSlashCommands() {
    return { commands: [...this.slashCommands] };
  }

  currentCatalog(sessionId?: string) {
    const session = sessionId ? this.sessionsById.get(sessionId) : undefined;
    // Without a session the catalog reports the runtime default model; with
    // one it reports that session's own evidenced model/effort.
    const model = session ? session.model : this.modelState.currentModelId ?? null;
    const effort = session ? session.effort : this.defaultEffortForModel(model);
    const catalog = catalogFromModelState(
      this.modelState,
      this.catalogPermissionMode(),
      this.sandboxProfile,
    );
    // models[].isDefault feeds catalog.resolve when no model is requested:
    // a session catalog must default to the session's own model/effort, not
    // the process default its sessionOptions already moved away from.
    const models = session?.model
      ? catalog.models.map((entry) => {
        if (entry.id !== session.model) return { ...entry, isDefault: false };
        return {
          ...entry,
          isDefault: true,
          efforts: session.effort
            ? entry.efforts.map((item) => ({ ...item, isDefault: item.id === session.effort }))
            : entry.efforts,
        };
      })
      : catalog.models;
    return {
      ...catalog,
      models,
      sessionOptions: catalog.sessionOptions.map(option => {
        if (option.id === 'model') {
          return { ...option, currentValue: model ?? option.currentValue };
        }
        if (option.id === 'reasoning_effort') {
          return { ...option, currentValue: effort ?? option.currentValue };
        }
        if (option.id === 'permission_mode') {
          return { ...option, currentValue: this.catalogPermissionMode() };
        }
        if (option.id === 'sandbox_profile') {
          return { ...option, currentValue: this.sandboxProfile };
        }
        return option;
      }),
    };
  }

  async startTurn(params: StartTurnParams) {
    const prepared = await this.openTurn(params);
    const { response } = await this.dispatchPreparedTurn(prepared);
    await this.runPreparedTurn(prepared, response);
    return { session: this.serializeSession(prepared.session), turn: { id: prepared.turnId } };
  }

  async beginTurn(params: StartTurnParams, onDispatched?: () => void) {
    const prepared = await this.openTurn(params);
    // Await the dispatch point: a rejection here means no native prompt exists
    // (missing image, dead runtime), so the caller never counts this turn as
    // a dispatched native prompt. The prompt response settles in background.
    const { response } = await this.dispatchPreparedTurn(prepared);
    // Record the Host's native prompt position before a fast response can
    // emit turn.completed. Failed local dispatches never invoke this hook.
    onDispatched?.();
    void this.runPreparedTurn(prepared, response).catch(() => undefined);
    return { turn: { id: prepared.turnId } };
  }

  private async openTurn(params: StartTurnParams): Promise<PreparedTurn> {
    const session = this.requireSession(params.sessionId);
    if (this.mcpBlockedReason) {
      throw createAppError(409, 'CONFLICT', this.mcpBlockedReason);
    }
    this.requireRuntime();
    if (session.activeTurnId) {
      throw createAppError(409, 'SESSION_BUSY', 'This session already has an active turn.');
    }
    this.clearIdleStop();
    // A session whose child stopped (idle stop, crash, forced interrupt) is
    // resumed into a new child before its prompt; it is never prompted in a
    // child that has not loaded it.
    await this.ensureAttached(session);
    if (session.activeTurnId) {
      throw createAppError(409, 'SESSION_BUSY', 'This session already has an active turn.');
    }
    const input = normalizeInputItems(params.input, session.cwd);
    const command = firstSlashToken(firstText(input));
    if (command && isBlockedSlashCommand(command)) {
      throw createAppError(400, 'CAPABILITY_NOT_SUPPORTED', `Grok command ${command} is not available in Gian.`);
    }
    await this.applyPermissionDraft(session);
    const turnId = randomId('turn');
    session.activeTurnId = turnId;
    session.status = 'running';
    const generation = ++this.promptGeneration;
    let markSettled = () => {};
    const settled = new Promise<void>((resolve) => {
      markSettled = () => resolve();
    });
    this.activeTurns.set(session.id, { turnId, completed: false, generation, settled, markSettled });
    this.permissionRow(session.id).turnSnapshot = this.permissionRow(session.id).draft;
    this.emitEvent('turn.started', this.envelope(session, { turnId, status: 'running' }, turnId));
    return { session, turnId, input, generation };
  }

  /**
   * Resolve the input locally, then hand the prompt to the native runtime.
   * Resolves at the dispatch point: a rejection means no native prompt exists
   * yet (local input failure, dead runtime), so the turn must fail without
   * minting a native prompt slot. A resolution means the native session owns
   * the prompt even if the prompt response later fails.
   */
  private async dispatchPreparedTurn(prepared: PreparedTurn): Promise<{ response: Promise<PromptResponse> }> {
    try {
      const runtime = this.requireRuntime();
      const prompt = await toPromptBlocks(prepared.input);
      const request = {
        sessionId: prepared.session.nativeSessionId,
        prompt,
        _meta: { mode: 'agent' },
      } as never;
      // Minimal runtime doubles dispatch synchronously inside prompt().
      const dispatcher = runtime as unknown as {
        dispatchPrompt?: (params: never) => Promise<{ response: Promise<PromptResponse> }>;
      };
      if (typeof dispatcher.dispatchPrompt === 'function') {
        return dispatcher.dispatchPrompt(request);
      }
      return { response: runtime.prompt(request) };
    } catch (error) {
      this.failTurn(prepared.session, prepared.turnId, error);
      this.markTurnSettled(prepared.session.id, prepared.generation);
      throw mapRuntimeError(error, this.binaryPath);
    }
  }

  private async runPreparedTurn(prepared: PreparedTurn, response: Promise<PromptResponse>) {
    try {
      const promptResponse = await response;
      if (this.activeTurns.get(prepared.session.id)?.generation === prepared.generation) {
        if (this.mcpBlockedReason) {
          this.failTurn(
            prepared.session,
            prepared.turnId,
            createAppError(409, 'CONFLICT', this.mcpBlockedReason),
          );
        } else {
          this.emitPromptUsage(prepared.session, prepared.turnId, promptResponse);
          this.completeTurn(prepared.session, prepared.turnId, this.promptStopReason(promptResponse));
        }
      }
    } catch (error) {
      if (isConnectionClosed(error)) await this.awaitRuntimeExit(this.runtime, 1_000);
      if (this.activeTurns.get(prepared.session.id)?.generation === prepared.generation) {
        this.failTurn(prepared.session, prepared.turnId, error);
      }
      throw mapRuntimeError(error, this.binaryPath);
    } finally {
      this.markTurnSettled(prepared.session.id, prepared.generation);
    }
  }

  private markTurnSettled(sessionId: string, generation: number): void {
    const active = this.activeTurns.get(sessionId);
    if (active?.generation === generation) active.markSettled();
  }

  private promptStopReason(response: PromptResponse): string {
    return typeof response.stopReason === 'string' && response.stopReason.length > 0
      ? response.stopReason
      : 'completed';
  }

  async steerTurn(params: { sessionId: string; input: unknown }) {
    const session = this.requireSession(params.sessionId);
    if (this.mcpBlockedReason) {
      throw createAppError(409, 'CONFLICT', this.mcpBlockedReason);
    }
    const runtime = this.requireRuntime();
    if (!session.activeTurnId) {
      throw createAppError(404, 'TURN_NOT_FOUND', 'No active Grok turn to steer.');
    }
    const input = normalizeInputItems(params.input, session.cwd);
    const command = firstSlashToken(firstText(input));
    if (command && isBlockedSlashCommand(command)) {
      throw createAppError(400, 'CAPABILITY_NOT_SUPPORTED', `Grok command ${command} is not available in Gian.`);
    }
    const payload = await toInterjectPayload(input);
    let result: unknown;
    try {
      result = await runtime.interject({
        sessionId: session.nativeSessionId,
        text: payload.text,
        interjectionId: randomId('interject'),
        content: payload.content,
      });
    } catch (error) {
      throw mapRuntimeError(error, this.binaryPath);
    }
    const status = result && typeof result === 'object' ? (result as { status?: unknown }).status : undefined;
    if (status !== 'queued') {
      throw createAppError(502, 'RUNTIME_ERROR', 'Grok did not queue the steer.');
    }
    return { ok: true as const, turnId: session.activeTurnId };
  }

  async interruptTurn(params: InterruptTurnParams) {
    const session = this.requireSession(params.sessionId);
    if (!session.activeTurnId) return;
    // Block new pending interactions for this turn, then settle the ones
    // already waiting so the agent's blocked reverse requests resolve before
    // the cancel notification arrives.
    this.cancellingSessions.add(session.id);
    this.settlePendingInteractions(session.id);
    const active = this.activeTurns.get(session.id);
    const runtime = this.requireRuntime();
    try {
      await Promise.race([
        runtime.cancel(session.nativeSessionId),
        delay(this.interruptDeadlineMs).then(() => { throw new Error('session/cancel was not sent in time.'); }),
      ]);
    } finally {
      // Whether or not the cancel went out, the turn must end: a prompt that
      // has not settled by the deadline takes the child down with it.
      if (active) this.armInterruptWatchdog(session, active, runtime);
    }
  }

  private armInterruptWatchdog(session: SessionRecord, active: ActiveTurn, runtime: GrokAcpClient): void {
    if (active.watchdog || active.completed) return;
    const deadline = this.interruptDeadlineMs;
    active.watchdog = setTimeout(() => {
      void this.forceStopInterruptedTurn(session, active, runtime, deadline);
    }, deadline);
    active.watchdog.unref?.();
    void active.settled.then(() => {
      if (active.watchdog) clearTimeout(active.watchdog);
    });
  }

  private async forceStopInterruptedTurn(
    session: SessionRecord,
    active: ActiveTurn,
    runtime: GrokAcpClient,
    deadlineMs: number,
  ): Promise<void> {
    if (active.completed || this.activeTurns.get(session.id) !== active || this.runtime !== runtime) return;
    const reason = `Grok did not stop the interrupted turn within ${Math.round(deadlineMs / 1000)} s, so its process was stopped.`;
    this.lastUnexpectedExit = { message: reason, details: { reason: 'interrupt-timeout' } };
    // End the interrupted turn first: the prompt's own rejection must not
    // turn it into a failure.
    this.completeTurn(session, active.turnId, 'cancelled');
    try {
      await runtime.stop({ force: true });
    } catch {
      // The child is unusable either way; the next turn starts a new one.
    }
    // Other sessions shared that child; their turns ended with it.
    for (const other of this.sessionsById.values()) {
      other.attachedGeneration = null;
      if (other.id !== session.id && other.activeTurnId) {
        this.failTurn(other, other.activeTurnId, createAppError(502, 'RUNTIME_ERROR', reason, { reason: 'interrupt-timeout' }));
      }
    }
  }

  async respondApproval(params: ApprovalResponseParams) {
    const approval = this.approvalsById.get(params.approvalId);
    if (!approval) throw createAppError(404, 'APPROVAL_NOT_FOUND', 'Approval not found.');
    const optionId = params.nativeOptionId;
    if (!optionId || !approval.options.some(option => option.optionId === optionId)) {
      throw createAppError(400, 'INVALID_APPROVAL_OPTION', 'Unknown native approval option.');
    }
    approval.resolve({ outcome: { outcome: 'selected', optionId } });
    this.approvalsById.delete(params.approvalId);
    return { ok: true };
  }

  /**
   * Respond to a pending structured question (x.ai/ask_user_question),
   * plan-approval (x.ai/exit_plan_mode), or MCP elicit request mapped to a
   * Gian interaction. Repeated identical responses are idempotent; a repeated
   * responseId with a different payload is a conflict.
   */
  async respondQuestion(params: {
    questionId: string;
    responseId: string;
    actionId: string;
    values?: Record<string, unknown>;
  }) {
    const values = params.values ?? {};
    const replayKey = `${params.questionId}\u0000${params.responseId}`;
    const settled = this.settledQuestionResponses.get(replayKey);
    if (settled) {
      if (settled.actionId !== params.actionId
        || JSON.stringify(settled.values) !== JSON.stringify(values)) {
        throw createAppError(409, 'CONFLICT', 'responseId was reused with a different payload.');
      }
      return { ok: true as const };
    }
    const question = this.questionsById.get(params.questionId);
    if (!question) {
      throw createAppError(404, 'APPROVAL_NOT_FOUND', 'Interaction not found.');
    }
    if (!question.actionIds.includes(params.actionId)) {
      throw createAppError(400, 'INVALID_APPROVAL_OPTION', 'Interaction action is not available.');
    }
    const previous = question.responses.get(params.responseId);
    if (previous) {
      if (previous.actionId !== params.actionId
        || JSON.stringify(previous.values) !== JSON.stringify(values)) {
        throw createAppError(409, 'CONFLICT', 'responseId was reused with a different payload.');
      }
      return { ok: true as const };
    }
    question.responses.set(params.responseId, { actionId: params.actionId, values });
    const outcome = this.questionOutcomeFromAction(question.kind, params.actionId, values);
    question.resolve(outcome);
    this.rememberSettledQuestion(replayKey, { actionId: params.actionId, values });
    this.questionsById.delete(params.questionId);
    const session = this.sessionsById.get(question.sessionId);
    if (session) {
      this.emitEvent('question.resolved', this.envelope(session, {
        questionId: params.questionId,
        actionId: params.actionId,
      }, question.turnId ?? undefined));
    }
    return { ok: true as const };
  }

  private rememberSettledQuestion(
    replayKey: string,
    record: { actionId: string; values: Record<string, unknown> },
  ): void {
    if (this.settledQuestionResponses.size >= 256) {
      const oldest = this.settledQuestionResponses.keys().next().value;
      if (oldest !== undefined) this.settledQuestionResponses.delete(oldest);
    }
    this.settledQuestionResponses.set(replayKey, record);
  }

  private questionOutcomeFromAction(
    kind: PendingQuestion['kind'],
    actionId: string,
    values: Record<string, unknown>,
  ): QuestionOutcome {
    if (kind === 'plan') {
      if (actionId === 'submit' || actionId === 'approve') {
        return { kind: 'plan_approved' };
      }
      const feedback = typeof values.feedback === 'string' ? values.feedback : undefined;
      return {
        kind: 'plan_cancelled',
        ...(feedback !== undefined ? { feedback } : {}),
      };
    }
    if (actionId === 'cancel') return { kind: 'cancelled' };
    if (kind === 'elicit') {
      if (actionId === 'submit') {
        // The Adapter rebuilds flat protocol values into the native content
        // object; anything else cannot become an honest ElicitResult.
        const content = values.content;
        if (!content || typeof content !== 'object' || Array.isArray(content)) {
          return { kind: 'elicit_decline' };
        }
        return { kind: 'elicit_accept', content };
      }
      if (actionId === 'decline') return { kind: 'elicit_decline' };
      return { kind: 'cancelled' };
    }
    // ask_user_question
    if (actionId === 'submit') {
      const answers: Record<string, string[]> = {};
      const annotations: Record<string, { preview?: string; notes?: string }> = {};
      for (const [key, value] of Object.entries(values)) {
        if (typeof value === 'string') answers[key] = [value];
        else if (Array.isArray(value) && value.every(item => typeof item === 'string')) {
          answers[key] = value as string[];
        }
      }
      const notes = recordField(values, 'annotations');
      for (const [key, value] of Object.entries(notes)) {
        if (value && typeof value === 'object') {
          const annotation = value as Record<string, unknown>;
          annotations[key] = {
            ...(typeof annotation.preview === 'string' ? { preview: annotation.preview } : {}),
            ...(typeof annotation.notes === 'string' ? { notes: annotation.notes } : {}),
          };
        }
      }
      return { kind: 'submitted', answers, ...(Object.keys(annotations).length > 0 ? { annotations } : {}) };
    }
    if (actionId === 'chat_about_this' || actionId === 'skip_interview') {
      const partial: Record<string, string> = {};
      for (const [key, value] of Object.entries(values)) {
        if (typeof value === 'string') partial[key] = value;
        else if (Array.isArray(value) && value.every(item => typeof item === 'string') && value.length > 0) {
          partial[key] = (value as string[])[0]!;
        }
      }
      return { kind: actionId, partialAnswers: partial };
    }
    return { kind: 'cancelled' };
  }

  /** Handle reverse x.ai/* requests from the agent. Never fabricates success. */
  private async handleRuntimeExtMethod(method: string, params: unknown): Promise<unknown> {
    const payload = params && typeof params === 'object'
      ? params as Record<string, unknown>
      : {};
    if (method === 'x.ai/ask_user_question') {
      return this.handleAskUserQuestion(payload);
    }
    if (method === 'x.ai/exit_plan_mode') {
      return this.handleExitPlanMode(payload);
    }
    if (method === 'x.ai/mcp/elicit') {
      return this.handleMcpElicit(payload);
    }
    throw new Error(`Method not found: ${method}`);
  }

  private async handleAskUserQuestion(payload: Record<string, unknown>): Promise<unknown> {
    const nativeSessionId = typeof payload.sessionId === 'string' ? payload.sessionId : '';
    const proxySessionId = this.proxyIdByNativeId.get(nativeSessionId);
    const session = proxySessionId ? this.sessionsById.get(proxySessionId) : undefined;
    if (!session || this.cancellingSessions.has(session.id) || !session.activeTurnId) {
      return { outcome: 'cancelled' };
    }
    const questionId = randomId('iq');
    const turnId = session.activeTurnId;
    const response = await new Promise<QuestionOutcome>((resolve) => {
      this.questionsById.set(questionId, {
        questionId,
        kind: 'question',
        sessionId: session.id,
        turnId,
        nativeRequestId: typeof payload.toolCallId === 'string' ? payload.toolCallId : questionId,
        mode: payload.mode === 'plan' ? 'plan' : 'default',
        questions: Array.isArray(payload.questions) ? payload.questions : [],
        actionIds: ['submit', 'cancel', ...(payload.mode === 'plan' ? ['chat_about_this', 'skip_interview'] : [])],
        responses: new Map(),
        resolve,
      });
      this.emitEvent('question.requested', this.envelope(session, {
        questionId,
        toolCallId: typeof payload.toolCallId === 'string' ? payload.toolCallId : null,
        questions: payload.questions ?? [],
        mode: payload.mode === 'plan' ? 'plan' : 'default',
      }, turnId ?? undefined));
    });
    if (this.questionsById.has(questionId)) {
      // Resolved externally (turn end/cancel) — the map entry is cleaned by the resolver path.
      this.questionsById.delete(questionId);
    }
    switch (response.kind) {
      case 'submitted':
        return {
          outcome: 'accepted',
          answers: response.answers,
          ...(response.annotations ? { annotations: response.annotations } : {}),
        };
      case 'chat_about_this':
        return { outcome: 'chat_about_this', partial_answers: response.partialAnswers };
      case 'skip_interview':
        return { outcome: 'skip_interview', partial_answers: response.partialAnswers };
      default:
        return { outcome: 'cancelled' };
    }
  }

  private async handleExitPlanMode(payload: Record<string, unknown>): Promise<unknown> {
    const nativeSessionId = typeof payload.sessionId === 'string' ? payload.sessionId : '';
    const proxySessionId = this.proxyIdByNativeId.get(nativeSessionId);
    const session = proxySessionId ? this.sessionsById.get(proxySessionId) : undefined;
    if (!session || this.cancellingSessions.has(session.id) || !session.activeTurnId) {
      return { outcome: 'cancelled', feedback: undefined };
    }
    const questionId = randomId('iq');
    const turnId = session.activeTurnId;
    const response = await new Promise<QuestionOutcome>((resolve) => {
      this.questionsById.set(questionId, {
        questionId,
        kind: 'plan',
        sessionId: session.id,
        turnId,
        nativeRequestId: typeof payload.toolCallId === 'string' ? payload.toolCallId : questionId,
        mode: 'plan',
        questions: [],
        actionIds: ['approve', 'cancel'],
        responses: new Map(),
        resolve,
      });
      this.emitEvent('question.requested', this.envelope(session, {
        questionId,
        toolCallId: typeof payload.toolCallId === 'string' ? payload.toolCallId : null,
        plan: typeof payload.planContent === 'string' ? payload.planContent : null,
        mode: 'plan',
        kind: 'exit_plan_mode',
      }, turnId ?? undefined));
    });
    if (this.questionsById.has(questionId)) this.questionsById.delete(questionId);
    if (response.kind === 'plan_approved') return { outcome: 'approved' };
    return {
      outcome: 'cancelled',
      ...(response.kind === 'plan_cancelled' && response.feedback
        ? { feedback: response.feedback }
        : {}),
    };
  }

  private async handleMcpElicit(payload: Record<string, unknown>): Promise<unknown> {
    const nativeSessionId = typeof payload.sessionId === 'string' ? payload.sessionId : '';
    const proxySessionId = this.proxyIdByNativeId.get(nativeSessionId);
    const session = proxySessionId ? this.sessionsById.get(proxySessionId) : undefined;
    // The runtime parses the response as the MCP ElicitResult
    // ({ action: 'accept' | 'decline' | 'cancel', content? }); anything else
    // is malformed and cancels the request natively.
    if (!session || this.cancellingSessions.has(session.id) || !session.activeTurnId) {
      return { action: 'decline' };
    }
    const questionId = randomId('iq');
    const turnId = session.activeTurnId;
    const response = await new Promise<QuestionOutcome>((resolve) => {
      this.questionsById.set(questionId, {
        questionId,
        kind: 'elicit',
        sessionId: session.id,
        turnId,
        nativeRequestId: typeof payload.serverName === 'string' ? payload.serverName : questionId,
        mode: 'default',
        questions: Array.isArray(payload.questions) ? payload.questions : [],
        actionIds: ['submit', 'decline', 'cancel'],
        responses: new Map(),
        resolve,
      });
      this.emitEvent('question.requested', this.envelope(session, {
        questionId,
        toolCallId: typeof payload.serverName === 'string' ? payload.serverName : null,
        serverName: typeof payload.serverName === 'string' ? payload.serverName : null,
        message: typeof payload.message === 'string' ? payload.message : null,
        requestedSchema: payload.requestedSchema ?? null,
        kind: 'mcp_elicit',
      }, turnId ?? undefined));
    });
    if (this.questionsById.has(questionId)) this.questionsById.delete(questionId);
    if (response.kind === 'elicit_accept') {
      return { action: 'accept', content: response.content };
    }
    if (response.kind === 'elicit_decline') {
      return { action: 'decline' };
    }
    return { action: 'cancel' };
  }

  /** Resolve every pending question for a session (turn end, cancel, close). */
  private resolveQuestionsForSession(sessionId: string, outcome: QuestionOutcome['kind'] = 'cancelled'): void {
    for (const [questionId, question] of [...this.questionsById]) {
      if (question.sessionId !== sessionId) continue;
      this.questionsById.delete(questionId);
      question.resolve({ kind: outcome } as QuestionOutcome);
      const session = this.sessionsById.get(question.sessionId);
      if (session) {
        this.emitEvent('question.resolved', this.envelope(session, {
          questionId,
          actionId: null,
        }, question.turnId ?? undefined));
      }
    }
  }

  /**
   * Resolve every pending permission request for a session. Equivalent to the
   * question path: the blocked native prompt must settle exactly once with
   * `cancelled`, never hang until the stop deadline. The resolved event itself
   * is emitted by the handlePermissionRequest continuation.
   */
  private resolveApprovalsForSession(sessionId: string): void {
    for (const [approvalId, approval] of [...this.approvalsById]) {
      if (approval.sessionId !== sessionId) continue;
      this.approvalsById.delete(approvalId);
      approval.resolve({ outcome: { outcome: 'cancelled' } });
    }
  }

  /** One settlement path for turn end, interrupt, close, and runtime exit. */
  private settlePendingInteractions(sessionId: string, outcome: QuestionOutcome['kind'] = 'cancelled'): void {
    this.resolveQuestionsForSession(sessionId, outcome);
    this.resolveApprovalsForSession(sessionId);
  }

  /** The model's own default effort, or null when the runtime did not say. */
  private defaultEffortForModel(modelId: string | null): string | null {
    if (!modelId) return null;
    const model = this.modelState.availableModels?.find((item) => item.modelId === modelId);
    const efforts = model?._meta?.reasoningEfforts ?? [];
    return efforts.find((effort) => effort.default === true)?.value
      ?? model?._meta?.reasoningEffort
      ?? efforts[0]?.value
      ?? null;
  }

  async setConfigOption(params: SetConfigOptionParams) {
    const session = this.requireSession(params.sessionId);
    this.requireRuntime();
    if (params.configId === 'model' || params.configId === 'reasoning_effort') {
      this.clearIdleStop();
      const runtime = await this.ensureAttached(session);
      await this.applyModelConfig(session, runtime, params.configId, String(params.value));
      this.scheduleIdleStop();
    } else if (params.configId === 'permission_mode') {
      const mode = parseGrokPermissionMode(String(params.value));
      if (!mode) throw createAppError(400, 'INVALID_REQUEST', 'Unknown Grok permission mode.');
      this.permissionRow(session.id).draft = mode;
      this.stagedPermission = mode;
    } else if (params.configId === 'sandbox_profile') {
      this.setSandboxProfile(String(params.value));
    } else {
      throw createAppError(400, 'INVALID_REQUEST', `Unknown Grok config ${params.configId}.`);
    }
    session.updatedAt = nowIso();
    return { session: this.serializeSession(session) };
  }

  /**
   * Model and effort go through the standard `session/set_config_option`
   * (Grok 1.0.92 `model` and `reasoning_effort`); the response is the
   * session's complete option list. A runtime that never reported config
   * options falls back to `session/set_model`.
   */
  private async applyModelConfig(
    session: SessionRecord,
    runtime: GrokAcpClient,
    configId: 'model' | 'reasoning_effort',
    value: string,
  ): Promise<void> {
    const native = nativeConfigOptions(session.configOptions) ?? [];
    const nativeModel = nativeOption(native, 'model', 'model');
    const nativeEffort = nativeOption(native, 'reasoning_effort', 'thought_level');
    const setNative = typeof (runtime as { setSessionConfigOption?: unknown }).setSessionConfigOption === 'function'
      && nativeModel !== undefined;
    if (configId === 'model') {
      const known = this.modelState.availableModels?.some(model => model.modelId === value)
        || optionValues(nativeModel).includes(value);
      if (!known) throw createAppError(400, 'INVALID_REQUEST', `Unknown Grok model ${value}.`);
      if (setNative) {
        if (nativeModel?.currentValue === value) return;
        const response = await runtime.setSessionConfigOption({
          sessionId: session.nativeSessionId,
          configId: nativeModel!.id,
          value,
        });
        session.model = value;
        session.effort = this.defaultEffortForModel(value);
        this.adoptNativeConfig(session, response?.configOptions);
        return;
      }
      await runtime.setSessionModel({ sessionId: session.nativeSessionId, modelId: value });
      // Model state is per session: another attached session keeps its own.
      session.model = value;
      session.effort = this.defaultEffortForModel(value);
      return;
    }
    if (setNative) {
      if (!nativeEffort) {
        throw createAppError(
          400,
          'INVALID_REQUEST',
          `The current Grok model ${session.model ?? ''} does not offer a thinking level.`.replace('  ', ' '),
        );
      }
      if (!optionValues(nativeEffort).includes(value)) {
        throw createAppError(400, 'INVALID_REQUEST', `Unknown Grok reasoning effort ${value}.`);
      }
      if (nativeEffort.currentValue === value) return;
      const response = await runtime.setSessionConfigOption({
        sessionId: session.nativeSessionId,
        configId: nativeEffort.id,
        value,
      });
      session.effort = value;
      this.adoptNativeConfig(session, response?.configOptions);
      return;
    }
    // Legacy runtimes: the native request is model-scoped, so only this
    // session's own evidenced model may be sent. Borrowing the process
    // default could silently switch a resumed session to a model it never ran.
    const modelId = session.model;
    if (!modelId) {
      throw createAppError(
        400,
        'INVALID_REQUEST',
        'Select a Grok model for this session before adjusting thinking.',
      );
    }
    if (!effortIdsForModel(this.modelState, modelId).includes(value)) {
      throw createAppError(400, 'INVALID_REQUEST', `Unknown Grok reasoning effort ${value}.`);
    }
    await runtime.setSessionModel({
      sessionId: session.nativeSessionId,
      modelId,
      _meta: { reasoningEffort: value },
    });
    session.effort = value;
  }

  /**
   * Adopts the session's native option list (from session/new, load,
   * resume, set_config_option or a config_option_update). Returns true when
   * the session's model or effort changed.
   */
  private adoptNativeConfig(session: SessionRecord, value: unknown): boolean {
    const options = nativeConfigOptions(value);
    if (!options) return false;
    session.configOptions = options as unknown as SessionRecord['configOptions'];
    const model = nativeOption(options, 'model', 'model');
    const effort = nativeOption(options, 'reasoning_effort', 'thought_level');
    let changed = false;
    if (typeof model?.currentValue === 'string' && model.currentValue && model.currentValue !== session.model) {
      session.model = model.currentValue;
      changed = true;
    }
    // No effort option means the current model takes none (a BYOK model).
    const nextEffort = typeof effort?.currentValue === 'string' && effort.currentValue
      ? effort.currentValue
      : model ? null : session.effort;
    if (nextEffort !== session.effort) {
      session.effort = nextEffort;
      changed = true;
    }
    return changed;
  }

  /** Session responses carry the live model list (`models`); it is fresher
   *  than the initialize snapshot, e.g. after a model was removed. */
  private adoptModelList(response: unknown, adoptCurrent: boolean): void {
    const models = (response as { models?: unknown } | null)?.models;
    if (!models || typeof models !== 'object') return;
    const state = modelStateFromUnknown(models);
    if (!state.availableModels || state.availableModels.length === 0) return;
    this.modelState = {
      ...this.modelState,
      availableModels: state.availableModels,
      ...(adoptCurrent && state.currentModelId ? { currentModelId: state.currentModelId } : {}),
    };
  }

  /**
   * The live runtime with this native session loaded into its current
   * child. After an idle stop, a crash or a forced interrupt the session is
   * resumed (`session/resume`, else `session/load` with its replay
   * discarded) into a new child, its model and effort are re-applied, and a
   * stale session becomes idle again.
   */
  private async ensureAttached(session: SessionRecord): Promise<GrokAcpClient> {
    const runtime = this.requireRuntime();
    if (session.status !== 'stale'
      && runtimeRunning(runtime)
      && session.attachedGeneration === runtimeGeneration(runtime)) {
      return runtime;
    }
    const pending = this.reattaching.get(session.id);
    if (pending) return pending;
    const attach = this.reattach(session, runtime).finally(() => {
      this.reattaching.delete(session.id);
    });
    this.reattaching.set(session.id, attach);
    return attach;
  }

  private async reattach(session: SessionRecord, runtime: GrokAcpClient): Promise<GrokAcpClient> {
    const wasStale = session.status === 'stale';
    const want = { model: session.model, effort: session.effort };
    try {
      const initialized = await runtime.ensureStarted();
      if (session.attachedGeneration === runtimeGeneration(runtime) && !wasStale) return runtime;
      this.lastUnexpectedExit = null;
      const row = this.permissionRow(session.id);
      const meta = { mode: 'agent', clientIdentifier: row.audience, ...grokPermissionSpec(row.draft).createMeta };
      const request = {
        sessionId: session.nativeSessionId,
        cwd: session.cwd,
        mcpServers: this.hostMcpServers as never[],
        _meta: meta,
      };
      let response: unknown;
      if (initialized.agentCapabilities?.sessionCapabilities?.resume != null) {
        response = await runtime.resumeSession(request);
      } else {
        // session/load replays history; the Host already has it.
        this.replayCollectors.set(session.nativeSessionId, []);
        try {
          response = await runtime.loadSession(request);
        } finally {
          this.replayCollectors.delete(session.nativeSessionId);
        }
      }
      row.notified = row.draft;
      if (this.admittedHostMcp) await this.assertHostMcpBoundary(session.nativeSessionId);
      session.attachedGeneration = runtimeGeneration(runtime);
      this.adoptModelList(response, false);
      this.adoptNativeConfig(session, (response as { configOptions?: unknown } | null)?.configOptions);
      // The new child must run what the Host selected, not a persisted default.
      if (want.model && want.model !== session.model) {
        await this.applyModelConfig(session, runtime, 'model', want.model);
      }
      if (want.effort && want.effort !== session.effort) {
        await this.applyModelConfig(session, runtime, 'reasoning_effort', want.effort).catch(() => undefined);
      }
      if (wasStale) {
        session.status = 'idle';
        session.lastError = null;
        this.emitEvent('session.updated', this.envelope(session, { status: 'idle', recovered: true }));
      }
      return runtime;
    } catch (error) {
      throw mapRuntimeError(error, this.binaryPath);
    }
  }

  /** Native work that does not need a Gian turn: background-task
   *  bookkeeping, and the updates of a turn Grok runs on its own after a
   *  background task ends. Running tasks keep the child; any native update
   *  starts the idle clock again. */
  private observeNativeActivity(nativeSessionId: string, update: unknown): void {
    const fields = update !== null && typeof update === 'object' ? update as Record<string, unknown> : {};
    const kind = String(fields.sessionUpdate ?? '');
    const key = (taskId: unknown) => (typeof taskId === 'string' && taskId ? `${nativeSessionId}:${taskId}` : null);
    if (kind === 'background_tasks' && Array.isArray(fields.tasks)) {
      // The full list for this session: it replaces what was known.
      for (const known of [...this.backgroundTasks]) {
        if (known.startsWith(`${nativeSessionId}:`)) this.backgroundTasks.delete(known);
      }
      for (const task of fields.tasks) {
        const entry = task !== null && typeof task === 'object' ? task as Record<string, unknown> : {};
        const taskKey = key(entry.task_id);
        if (taskKey && backgroundTaskActive(entry.status)) this.backgroundTasks.add(taskKey);
      }
    } else if (kind === 'task_backgrounded') {
      const taskKey = key(fields.task_id);
      if (taskKey) this.backgroundTasks.add(taskKey);
    } else if (kind === 'task_completed') {
      const snapshot = fields.task_snapshot !== null && typeof fields.task_snapshot === 'object'
        ? fields.task_snapshot as Record<string, unknown>
        : {};
      const taskKey = key(fields.task_id ?? snapshot.task_id);
      if (taskKey) this.backgroundTasks.delete(taskKey);
    }
    this.scheduleIdleStop();
  }

  /** Arms the idle stop when nothing runs in the attached child. */
  private scheduleIdleStop(): void {
    this.clearIdleStop();
    const runtime = this.runtime;
    if (this.idleTimeoutMs <= 0 || !runtime || !this.childIdle()) return;
    const timer = setTimeout(() => {
      if (this.idleTimer !== timer) return;
      this.idleTimer = null;
      void this.stopIdleChild(runtime);
    }, this.idleTimeoutMs);
    timer.unref?.();
    this.idleTimer = timer;
  }

  private clearIdleStop(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private childIdle(): boolean {
    if (this.reattaching.size > 0 || this.approvalsById.size > 0 || this.questionsById.size > 0) return false;
    if (this.backgroundTasks.size > 0) return false;
    return [...this.sessionsById.values()].every((session) => !session.activeTurnId);
  }

  /** Stops an idle child (an expected stop: sessions stay idle for the
   *  Host). The next turn resumes each session into a new child. */
  private async stopIdleChild(runtime: GrokAcpClient): Promise<void> {
    if (this.runtime !== runtime || !this.childIdle() || !runtimeRunning(runtime)) return;
    for (const session of this.sessionsById.values()) session.attachedGeneration = null;
    try {
      await runtime.stop();
    } catch {
      // A child that does not stop cleanly is replaced on the next turn.
    }
  }

  async renameSession(params: { sessionId: string; name: string }) {
    const session = this.requireSession(params.sessionId);
    // Upstream enforces a 100-scalar title limit; reject early rather than
    // relying on the runtime's sanitized rejection.
    if ([...params.name].length > 100) {
      throw createAppError(400, 'INVALID_REQUEST', 'Grok session names are limited to 100 Unicode code points.');
    }
    try {
      const runtime = await this.ensureAttached(session);
      await runtime.renameSession(session.nativeSessionId, params.name, session.cwd);
    } catch (error) {
      if (isMethodNotFound(error)) {
        throw createAppError(
          400,
          'CAPABILITY_NOT_SUPPORTED',
          `Grok runtime does not support x.ai/session/rename: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      throw mapRuntimeError(error, this.binaryPath);
    }
    session.updatedAt = nowIso();
    return { ok: true as const };
  }

  async deleteNativeSession(nativeSessionId: string) {
    // Guard 1: never delete a native session this Proxy still has attached.
    if (this.proxyIdByNativeId.has(nativeSessionId)) {
      throw createAppError(409, 'CONFLICT', 'Cannot delete an attached Grok session.');
    }
    // Guard 2: ownership must be provable — the session has to appear in the
    // native directory listing before a destructive call is issued.
    const scopedCwd = this.sessionsById.values().next().value?.cwd ?? null;
    const aux = this.createRuntime(scopedCwd ?? resolve(tmpdir()), this.auxBoundary());
    try {
      await aux.ensureStarted();
      if (!await nativeSessionListed(aux, nativeSessionId)) {
        throw createAppError(404, 'NATIVE_SESSION_NOT_FOUND', `Grok native session ${nativeSessionId} was not found.`);
      }
      await aux.deleteSession(nativeSessionId, scopedCwd ?? undefined);
      return { ok: true as const };
    } catch (error) {
      if (error instanceof GrokProxyError) throw error;
      if (error instanceof GrokExtMethodUnsupportedError) {
        throw createAppError(400, 'CAPABILITY_NOT_SUPPORTED', error.message);
      }
      if (isStructuredNotFound(error)) {
        throw createAppError(404, 'NATIVE_SESSION_NOT_FOUND', `Grok native session ${nativeSessionId} was not found.`);
      }
      throw mapRuntimeError(error, this.binaryPath);
    } finally {
      await aux.stop();
    }
  }

  getSession(params: GetSessionParams) {
    return { session: this.serializeSession(this.requireSession(params.sessionId)) };
  }

  async closeSession(params: CloseSessionParams) {
    const session = this.requireSession(params.sessionId);
    // Settle blocked reverse requests first so the native prompt can unwind;
    // local cleanup must finish even when native cancel/close fails.
    this.cancellingSessions.add(session.id);
    this.settlePendingInteractions(session.id);
    try {
      // Only a child that has this session loaded is asked to close it; a
      // stopped child is never restarted just to close.
      if (this.runtime && runtimeRunning(this.runtime)
        && session.attachedGeneration === runtimeGeneration(this.runtime)) {
        await this.runtime.cancel(session.nativeSessionId).catch(() => undefined);
        await this.runtime.closeSession({ sessionId: session.nativeSessionId }).catch(() => undefined);
      }
    } finally {
      this.sessionsById.delete(session.id);
      this.proxyIdByNativeId.delete(session.nativeSessionId);
      this.activeTurns.delete(session.id);
      this.permissionBySession.delete(session.id);
      this.cancellingSessions.delete(session.id);
      if (this.sessionsById.size === 0) await this.stopRuntime();
    }
  }

  async close() {
    for (const session of [...this.sessionsById.values()]) {
      await this.closeSession({ sessionId: session.id });
    }
    await this.stopRuntime();
  }

  setPermissionMode(mode: GrokPermissionMode) {
    this.stagedPermission = mode;
  }

  /** Runtime access for the read-only customization inspector. */
  customizationAccess(): GrokCustomizationRuntimeAccess {
    return {
      createAuxRuntime: (cwd: string) => this.createRuntime(cwd, this.auxBoundary()),
      attachedRuntime: () => {
        const session = this.sessionsById.values().next().value;
        if (!session || !this.runtime || this.runtimeCwd !== session.cwd) return null;
        // An idle-stopped child has no session loaded; never restart it for
        // a read-only listing.
        if (!runtimeRunning(this.runtime) || session.attachedGeneration !== runtimeGeneration(this.runtime)) return null;
        return {
          runtime: this.runtime,
          nativeSessionId: session.nativeSessionId,
          cwd: session.cwd,
        };
      },
    };
  }

  private async ensureRuntime(cwd: string): Promise<GrokAcpClient> {
    if (this.runtime) {
      if (this.runtimeCwd !== cwd) {
        throw createAppError(409, 'NATIVE_SESSION_ATTACHED', 'Forked Grok sessions must share the parent cwd.');
      }
      return this.runtime;
    }
    // Disk names only choose spawn-time denies. They are not the effective
    // MCP set. With Host MCP, search_tool/use_tool stay closed until
    // x.ai/mcp/list proves the admitted HTTP servers.
    const diskScan = await scanDiskConfiguredMcpServers(cwd);
    const denyRules = mcpSpawnDenyRules(this.admittedHostMcp, diskScan.names);
    const runtime = this.createRuntime(cwd, {
      spawnDenyRules: denyRules,
      sandboxProfile: this.sandboxProfile,
      disallowMetaTools: this.admittedHostMcp == null,
    });
    runtime.setPermissionHandler(request => this.handlePermissionRequest(request));
    if (typeof (runtime as { setExtMethodHandler?: unknown }).setExtMethodHandler === 'function') {
      runtime.setExtMethodHandler((method, params) => this.handleRuntimeExtMethod(method, params));
    }
    runtime.on('extensionNotification', (method, params) => {
      if (method === 'x.ai/mcp/servers_updated' || method === 'x.ai/mcp/tools_changed') {
        void this.onMcpCatalogChanged().catch(() => undefined);
      }
      const nativeSessionId = params && typeof params === 'object'
        ? String((params as Record<string, unknown>).sessionId ?? '')
        : '';
      if (nativeSessionId && (this.runtime === null || this.runtime === runtime)) {
        this.observeNativeActivity(nativeSessionId, (params as Record<string, unknown>).update);
      }
      const direct = nativeSessionId
        ? this.sessionsById.get(this.proxyIdByNativeId.get(nativeSessionId) ?? '')
        : undefined;
      const active = direct ?? [...this.sessionsById.values()].filter(session => session.activeTurnId).at(0);
      if (active) this.emitEvent('extension.notification', this.envelope(active, { method, params }));
    });
    runtime.on('sessionUpdate', notification => this.handleSessionUpdate(notification));
    runtime.on('runtimeStopped', (event) => {
      if (this.runtime === runtime) this.backgroundTasks.clear();
      if (event.expected) return;
      const message = describeExit(event, event.stderrTail ?? '', 'running');
      this.lastUnexpectedExit = {
        message,
        details: {
          exitCode: event.code,
          ...(event.signal ? { signal: event.signal } : {}),
        },
      };
      this.clearIdleStop();
      for (const session of this.sessionsById.values()) {
        this.settlePendingInteractions(session.id);
        session.attachedGeneration = null;
        session.status = 'stale';
        session.lastError = message;
        this.emitEvent('session.updated', this.envelope(session, { status: 'stale', lastError: message }));
      }
    });
    try {
      const initialized = await runtime.ensureStarted();
      this.runtime = runtime;
      this.runtimeCwd = cwd;
      this.lastUnexpectedExit = null;
      this.forkSupported = initialized.agentCapabilities?.sessionCapabilities?.fork != null;
      return runtime;
    } catch (error) {
      await runtime.stop();
      throw error;
    }
  }

  private async stopRuntime(): Promise<void> {
    this.clearIdleStop();
    this.backgroundTasks.clear();
    const runtime = this.runtime;
    this.runtime = null;
    this.runtimeCwd = null;
    this.mcpBlockedReason = null;
    this.permissionBySession.clear();
    if (runtime) await runtime.stop();
  }

  /** Retry while the catalog is unresolved. A miss fails the session. */
  private async readVerifiedMcpList(nativeSessionId?: string) {
    const runtime = this.requireRuntime();
    let last = 'Host MCP catalog could not be verified.';
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const reading = readMcpListPayload(
          nativeSessionId ? await runtime.mcpList(nativeSessionId) : await runtime.mcpList(),
        );
        if (reading.resolved === false || reading.initializing) {
          last = 'Host MCP catalog is still initializing.';
          if (attempt < 2) await delay(20);
          continue;
        }
        return reading;
      } catch (error) {
        if (error instanceof GrokProxyError) throw error;
        last = error instanceof Error ? error.message : String(error);
        if (attempt < 2) await delay(20);
      }
    }
    throw createAppError(409, 'CONFLICT', last);
  }

  /**
   * Prove the executable catalog matches the admitted Host HTTP set before
   * the session is inserted. Failure leaves no session and stops the child.
   */
  private async assertHostMcpBoundary(nativeSessionId: string): Promise<void> {
    const admitted = this.admittedHostMcp;
    if (!admitted) return;
    const reading = await this.readVerifiedMcpList(nativeSessionId);
    const problem = mcpBoundaryProblem(reading.servers, admitted);
    if (problem) throw createAppError(409, 'CONFLICT', problem);
  }

  /**
   * `x.ai/mcp/servers_updated` is the process-local and plugin catalog. It has
   * no session id and does not include Host MCP injected into a session, so
   * the body is not the session's executable set. Re-read `x.ai/mcp/list` for
   * every attached session. `x.ai/mcp/tools_changed` is only a refetch trigger.
   */
  private async onMcpCatalogChanged(): Promise<void> {
    if (!this.admittedHostMcp || !this.runtime || this.mcpBlockedReason) return;
    const live = this.runtime;
    const sessions = [...this.sessionsById.values()].filter((session) => (
      session.attachedGeneration === runtimeGeneration(live)
    ));
    if (sessions.length === 0) return;
    try {
      for (const session of sessions) {
        if (this.mcpBlockedReason) return;
        const reading = await this.readVerifiedMcpList(session.nativeSessionId);
        const problem = mcpBoundaryProblem(reading.servers, this.admittedHostMcp);
        if (problem) {
          await this.blockMcp(problem);
          return;
        }
      }
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : 'Host MCP catalog changed and could not be verified.';
      await this.blockMcp(message);
    }
  }

  /**
   * Mark the boundary, then confirm the native prompt has stopped. A local
   * `turn.failed` is sent only after that confirmation. Cancel that fails or
   * does not finish kills the child. `stopRuntime()` is not used here because
   * it would clear the block and allow another turn.
   */
  private async blockMcp(reason: string): Promise<void> {
    if (this.mcpBlockedReason) return;
    this.mcpBlockedReason = reason;
    const runtime = this.runtime;
    const active = [...this.sessionsById.values()].filter((session) => session.activeTurnId);
    // Settle blocked reverse requests up front: a prompt parked in
    // requestPermission can only finish once its promise resolves, and must
    // not hold this path until the stop deadline.
    for (const session of active) {
      this.cancellingSessions.add(session.id);
      this.settlePendingInteractions(session.id);
    }
    let detail = reason;
    if (runtime) {
      const stopError = await this.stopTurnForMcpBoundary(runtime, active);
      if (stopError) {
        detail = `${reason} The Grok process could not be stopped (${stopError}).`;
        this.mcpBlockedReason = detail;
      }
    }
    for (const session of active) {
      const turnId = session.activeTurnId;
      if (!turnId) continue;
      this.failTurn(session, turnId, createAppError(409, 'CONFLICT', detail));
    }
  }

  private async stopTurnForMcpBoundary(
    runtime: GrokAcpClient,
    sessions: SessionRecord[],
  ): Promise<string | null> {
    const pending = sessions.map((session) => this.activeTurns.get(session.id)?.settled ?? Promise.resolve());
    const cancelOk = await Promise.race([
      Promise.all(sessions.map((session) => runtime.cancel(session.nativeSessionId))).then(() => true, () => false),
      delay(this.turnStopDeadlineMs).then(() => false),
    ]);
    if (cancelOk) {
      const settled = await Promise.race([
        Promise.all(pending).then(() => true, () => true),
        delay(this.turnStopDeadlineMs).then(() => false),
      ]);
      if (settled) return null;
    }
    let stopError: string | null = null;
    try {
      await runtime.stop();
    } catch (error) {
      stopError = error instanceof Error ? error.message : String(error);
    }
    if (this.runtime === runtime) {
      this.runtime = null;
      this.runtimeCwd = null;
      this.backgroundTasks.clear();
    }
    return stopError;
  }

  private setSandboxProfile(value: string): void {
    const profile = parseGrokSandboxProfile(value);
    if (!profile) {
      throw createAppError(400, 'INVALID_REQUEST', `Unknown Grok sandbox profile ${value}.`);
    }
    if (this.runtime) {
      if (profile === this.sandboxProfile) return;
      throw createAppError(
        409,
        'CONFLICT',
        'The sandbox profile is fixed when the Grok process starts. Start a new session to change it.',
      );
    }
    this.sandboxProfile = profile;
  }

  /** Mode the runtime was last told, or the mode pinned to the active turn. */
  private effectivePermission(row: PermissionRow): GrokPermissionMode {
    return row.turnSnapshot ?? row.notified ?? row.draft;
  }

  /**
   * The native matcher updates every resident session with this origin. A
   * second session that still has the same origin must not be given a
   * different mode. Native fork and resume use a distinct origin instead.
   */
  private assertPermissionAudienceIsolated(session: SessionRecord, row: PermissionRow): void {
    for (const other of this.sessionsById.values()) {
      if (other.id === session.id) continue;
      const otherRow = this.permissionBySession.get(other.id);
      if (!otherRow || otherRow.audience !== row.audience) continue;
      if (this.effectivePermission(otherRow) !== row.draft) {
        throw createAppError(
          409,
          'CONFLICT',
          'Sessions that share one Grok origin cannot use different permission modes in the same process.',
        );
      }
    }
  }

  /** Re-apply this session's draft before its prompt. A send is not confirmation. */
  private async applyPermissionDraft(session: SessionRecord): Promise<void> {
    const runtime = this.requireRuntime();
    const row = this.permissionRow(session.id);
    this.assertPermissionAudienceIsolated(session, row);
    const spec = grokPermissionSpec(row.draft);
    await runtime.notifyPermissionMode({
      sessionId: session.nativeSessionId,
      clientIdentifier: row.audience,
      permission_mode: spec.runtime.permission_mode,
      yolo_mode: spec.runtime.yolo_mode,
      auto_mode: spec.runtime.auto_mode,
    });
    row.notified = row.draft;
  }

  private releaseTurnSnapshot(session: SessionRecord): void {
    const row = this.permissionBySession.get(session.id);
    if (row) row.turnSnapshot = null;
  }

  private requireSession(sessionId: string): SessionRecord {
    const session = this.sessionsById.get(sessionId);
    if (!session) throw createAppError(404, 'SESSION_NOT_FOUND', 'Session not found.');
    return session;
  }

  private requireRuntime(): GrokAcpClient {
    if (!this.runtime) throw createAppError(503, 'RUNTIME_UNAVAILABLE', 'Grok runtime is not started.');
    return this.runtime;
  }

  private serializeSession(session: SessionRecord) {
    return {
      ...session,
      model: session.model,
      mode: this.displayedPermission(session),
      sandboxProfile: this.sandboxProfile,
      effort: session.effort,
    };
  }

  private envelope(session: SessionRecord, data: Record<string, unknown>, turnId?: string) {
    return {
      sessionId: session.id,
      nativeSessionId: session.nativeSessionId,
      ...(turnId ? { turnId } : {}),
      data,
    };
  }

  private completeTurn(session: SessionRecord, turnId: string, stopReason: string) {
    const active = this.activeTurns.get(session.id);
    if (!active || active.turnId !== turnId || active.completed) return;
    active.completed = true;
    session.activeTurnId = null;
    this.releaseTurnSnapshot(session);
    session.status = 'idle';
    this.cancellingSessions.delete(session.id);
    this.settlePendingInteractions(session.id);
    if (active.watchdog) clearTimeout(active.watchdog);
    this.emitEvent('turn.completed', this.envelope(session, { stopReason }, turnId));
    this.scheduleIdleStop();
  }

  private failTurn(session: SessionRecord, turnId: string, error: unknown) {
    const active = this.activeTurns.get(session.id);
    if (!active || active.turnId !== turnId || active.completed) return;
    active.completed = true;
    session.activeTurnId = null;
    this.releaseTurnSnapshot(session);
    const mapped = this.turnFailure(error);
    session.status = 'error';
    session.lastError = mapped.message;
    this.cancellingSessions.delete(session.id);
    this.settlePendingInteractions(session.id);
    if (active.watchdog) clearTimeout(active.watchdog);
    this.emitEvent('turn.failed', this.envelope(session, {
      code: mapped.code === 'AUTH_REQUIRED' ? 'RUNTIME_AUTH_REQUIRED' : 'RUNTIME_ERROR',
      message: mapped.message,
      details: mapped.details,
    }, turnId));
    this.scheduleIdleStop();
  }

  /**
   * A prompt that died with the child (the SDK reports "ACP connection
   * closed") is described by the exit and the child's own stderr instead.
   */
  private turnFailure(error: unknown): GrokProxyError {
    if (isConnectionClosed(error)) {
      if (this.lastUnexpectedExit) {
        return createAppError(502, 'RUNTIME_ERROR', this.lastUnexpectedExit.message, this.lastUnexpectedExit.details);
      }
      const runtime = this.runtime as { stderrTail?: () => string } | null;
      const tail = typeof runtime?.stderrTail === 'function' ? runtime.stderrTail() : '';
      return createAppError(
        502,
        'RUNTIME_ERROR',
        `Grok stopped unexpectedly.${tail ? ` Grok reported: ${tail}` : ''}`,
        { connection: 'closed' },
      );
    }
    return mapRuntimeError(error, this.binaryPath);
  }

  /** The SDK can reject a prompt just before the child's exit is observed;
   *  give the exit (and its stderr) a moment to arrive. */
  private async awaitRuntimeExit(runtime: GrokAcpClient | null, timeoutMs: number): Promise<void> {
    if (!runtime || this.lastUnexpectedExit || typeof runtime.once !== 'function') return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, timeoutMs);
      timer.unref();
      function done() {
        clearTimeout(timer);
        runtime!.off('runtimeStopped', done);
        resolve();
      }
      runtime.once('runtimeStopped', done);
    });
  }

  /** One `usage.updated` conversation delta per turn. The turn's
   *  totalTokens is a turn count, never the context occupancy. */
  private emitPromptUsage(session: SessionRecord, turnId: string, response: PromptResponse) {
    const usage = promptTurnUsage(response);
    if (!usage) return;
    const conversation = {
      mode: 'delta' as const,
      ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
      ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
      ...(usage.cachedInputTokens !== undefined ? { cachedInputTokens: usage.cachedInputTokens } : {}),
      ...(usage.totalTokens !== undefined ? { totalTokens: usage.totalTokens } : {}),
    };
    if (Object.keys(conversation).length === 1) return;
    this.emitEvent('usage.updated', this.envelope(session, { conversation }, turnId));
  }

  private handleSessionUpdate(notification: SessionNotification) {
    const collecting = this.replayCollectors.get(notification.sessionId);
    if (collecting) {
      collecting.push(notification);
      return;
    }
    this.observeNativeActivity(notification.sessionId, notification.update);
    const proxySessionId = this.proxyIdByNativeId.get(notification.sessionId);
    const session = proxySessionId ? this.sessionsById.get(proxySessionId) : undefined;
    if (!session) {
      const pending = this.unclaimedUpdates.get(notification.sessionId) ?? [];
      pending.push(notification);
      this.unclaimedUpdates.set(notification.sessionId, pending.slice(-200));
      return;
    }
    const update = notification.update as { sessionUpdate?: string } & Record<string, unknown>;
    const kind = String(update.sessionUpdate ?? '');
    // Session-scoped updates matter outside a turn too: Grok switches a
    // session's model when that model leaves the list (1.0.90), and a
    // config_option_update mirrors every set_config_option.
    const sessionScoped = kind === 'available_commands_update'
      || kind === 'current_mode_update'
      || kind === 'current_model_update'
      || kind === 'config_option_update'
      || kind === 'session_info_update'
      || kind === 'usage_update';
    if (!sessionScoped && !session.activeTurnId) return;
    if (update.sessionUpdate === 'available_commands_update' && Array.isArray(update.availableCommands)) {
      this.slashCommands = update.availableCommands as AvailableCommand[];
      session.slashCommands = this.slashCommands;
      this.emitEvent('slash.updated', this.envelope(session, { commands: this.slashCommands }));
    }
    if (update.sessionUpdate === 'current_model_update' && typeof update.currentModelId === 'string') {
      // A model update belongs to the session that emitted it; other attached
      // sessions and the process default keep their own values.
      if (update.currentModelId !== session.model) {
        session.model = update.currentModelId;
        session.effort = this.defaultEffortForModel(update.currentModelId);
      }
      this.emitEvent('session.updated', this.envelope(session, {
        model: session.model,
        effort: session.effort,
        configChanged: true,
      }));
    }
    if (update.sessionUpdate === 'config_option_update' && this.adoptNativeConfig(session, update.configOptions)) {
      this.emitEvent('session.updated', this.envelope(session, {
        model: session.model,
        effort: session.effort,
        configChanged: true,
      }));
    }
    // usage_update (context `used`/`size`) is translated once, with the
    // other session updates, by the adapter.
    this.emitEvent('session.update', this.envelope(session, { update }, session.activeTurnId ?? undefined));
  }

  private async handlePermissionRequest(
    request: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const proxySessionId = this.proxyIdByNativeId.get(request.sessionId);
    const session = proxySessionId ? this.sessionsById.get(proxySessionId) : undefined;
    // A late permission request racing a cancel/close — or one arriving with
    // no active turn at all — settles immediately instead of parking a
    // promise nobody will resolve.
    if (!session || this.cancellingSessions.has(session.id) || !session.activeTurnId) {
      return { outcome: { outcome: 'cancelled' } };
    }
    const approvalId = randomId('appr');
    const turnId = session.activeTurnId;
    const response = await new Promise<RequestPermissionResponse>((resolve) => {
      this.approvalsById.set(approvalId, {
        approvalId,
        sessionId: session.id,
        turnId,
        options: request.options,
        resolve,
      });
      this.emitEvent('approval.requested', this.envelope(session, {
        approvalId,
        title: request.toolCall.title ?? request.toolCall.kind ?? 'Permission',
        options: request.options,
        payload: request.toolCall,
      }, turnId ?? undefined));
    });
    this.emitEvent('approval.resolved', this.envelope(session, {
      approvalId,
      optionId: 'outcome' in response.outcome && response.outcome.outcome === 'selected'
        ? response.outcome.optionId
        : null,
    }, turnId ?? undefined));
    return response;
  }
}
