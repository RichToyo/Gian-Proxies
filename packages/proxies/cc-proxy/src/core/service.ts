import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';

import type { TokenUsageUpdate } from '@gian/shared';
import { createAppError } from './errors.js';
import {
  ClaudeCustomizationScanner,
  ScanTimeoutError,
} from './customization.js';
import { normalizeInputItems } from './input.js';
import { listAllSlashCommands } from './slash.js';
import type {
  ApprovalResponseParams,
  CapabilitiesPayload,
  CloseSessionParams,
  CreateSessionParams,
  GetSessionParams,
  InputItem,
  InitializePayload,
  InterruptTurnParams,
  PendingApproval,
  SessionRecord,
  SessionSnapshotParams,
  StartTurnParams,
} from './types.js';
import { nowIso, randomId } from './utils.js';
import type { ClaudeAgentTaskUpdate, ClaudeRuntime } from '../runtime/types.js';

type ProxyEventSink = (method: string, params: Record<string, unknown>) => void;

function customizationUnavailable(
  kind: import('@gian/proxy-protocol').CustomizationKind,
  diagnostics: import('@gian/proxy-protocol').CustomizationDiagnostic[],
): import('@gian/proxy-protocol').CustomizationListResult {
  return {
    kind,
    status: 'unavailable',
    completeness: 'none',
    observedAt: new Date().toISOString(),
    items: [],
    truncated: false,
    diagnostics,
  };
}

interface ServiceOptions {
  runtime: ClaudeRuntime;
  emitEvent?: ProxyEventSink;
}

interface UnpublishedProcessExit {
  code: number | null;
  signal: string | null;
  errorDetail?: string;
  streamedLength: number;
}

/** Provider text stays the user-facing message. A process that died without
 *  one is retryable: the user can send the turn again. Exit facts always
 *  ride along in details, matching the other proxies' error.details record. */
function claudeProcessExitFailure(
  code: number | null,
  signal: string | null,
  streamedLength: number,
  errorDetail?: string,
): { message: string; retryable: boolean; details: Record<string, unknown> } {
  const detail = errorDetail?.trim() ?? '';
  const facts = `Claude Code process exited (code=${code}, signal=${signal}, streamed=${streamedLength})`;
  return {
    message: detail || facts,
    retryable: detail.length === 0,
    details: {
      exitCode: code,
      signal,
      streamedLength,
    },
  };
}

function normalizeNonEmptyString(value: unknown, field: string) {
  if (typeof value !== 'string' || !value.trim()) {
    throw createAppError(400, 'INVALID_REQUEST', `${field} is required.`);
  }
  return value.trim();
}

// exported for tests
export function buildPrompt(input: InputItem[]): string {
  const parts: string[] = [];
  for (const item of input) {
    if (item.type === 'text' && typeof item.text === 'string' && item.text.length > 0) {
      parts.push(item.text);
    } else if (item.type === 'localImage' && typeof item.path === 'string' && item.path.length > 0) {
      parts.push(`[Attached image: ${item.path}]`);
    } else if (item.type === 'localFile' && typeof item.path === 'string' && item.path.length > 0) {
      parts.push(`[Attached file: ${item.path}]`);
    }
  }
  return parts.join('\n\n');
}

/** Tools whose permission card carries their entire UX (structured question
 *  picker / plan review), so their generic tool.use/tool.result events are
 *  suppressed. This matches the host's JSONL replay path, which never renders
 *  generic tool cards for them. */
const APPROVAL_BRIDGED_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

/** Older Claude CLI builds may omit `contextWindow`; only infer it when the
 * detected model id carries an explicit capacity marker. */
function inferContextWindow(modelId: string | null): number | undefined {
  return modelId?.includes('[1m]') ? 1_000_000 : undefined;
}

export class CcProxyService {
  private readonly runtime: ClaudeRuntime;
  private readonly customization: ClaudeCustomizationScanner;
  private emitEvent: ProxyEventSink;
  private readonly sessionsById = new Map<string, SessionRecord>();
  private readonly approvalsById = new Map<string, PendingApproval>();
  private readonly approvalsBySessionId = new Map<string, Map<string, PendingApproval>>();
  /** Tracks the current turn and upstream requestId per session. */
  private readonly activeTurns = new Map<string, {
    turnId: string;
    requestId: number | string | undefined;
    isCompact: boolean;
  }>();
  /** `${sessionId}:${callId}` → toolName, recorded on toolUse so toolResult
   *  can apply the same per-tool handling (approval-bridged tools suppress
   *  both events). Entries are deleted on result / turn end / session end. */
  private readonly toolCallNames = new Map<string, string>();
  /** CLI exits that arrive after activeTurns is set but before startTurn
   *  publishes activeTurnId. Replayed once the turn is visible. */
  private readonly unpublishedExits = new Map<string, UnpublishedProcessExit>();

  constructor(options: ServiceOptions) {
    this.runtime = options.runtime;
    this.emitEvent = options.emitEvent ?? (() => undefined);
    this.customization = new ClaudeCustomizationScanner();
  }

  async initialize() {
    // Wire up runtime events. The proxy is fully stateless across restarts —
    // sessions live in-memory only; the host re-creates them on reconnect.
    this.runtime.on('channelReply', (sessionId, text) => {
      this.handleChannelReply(sessionId, text);
    });

    this.runtime.on('assistantText', (sessionId, text, itemId) => {
      this.handleAssistantText(sessionId, text, itemId);
    });

    this.runtime.on('assistantReasoning', (sessionId, text, itemId) => {
      this.handleAssistantReasoning(sessionId, text, itemId);
    });

    this.runtime.on('turnFailed', (sessionId, errorDetail, streamedLength) => {
      this.handleTurnFailed(sessionId, errorDetail, streamedLength);
    });

    this.runtime.on('permissionRequest', (sessionId, requestId, toolName, description, inputPreview) => {
      this.handlePermissionRequest(sessionId, requestId, toolName, description, inputPreview);
    });

    this.runtime.on('permissionCancelled', (sessionId, requestId) => {
      this.handlePermissionCancelled(sessionId, requestId);
    });

    this.runtime.on('toolUse', (sessionId, toolName, input, callId) => {
      this.handleToolUse(sessionId, toolName, input, callId);
    });

    this.runtime.on('toolResult', (sessionId, callId, output, isError) => {
      this.handleToolResult(sessionId, callId, output, isError);
    });

    this.runtime.on('agentTask', (sessionId, update) => {
      this.handleAgentTask(sessionId, update);
    });

    this.runtime.on('autoClassifierDenied', (sessionId, action, reason, consecutive, total) => {
      this.handleAutoClassifierDenied(sessionId, action, reason, consecutive, total);
    });

    this.runtime.on('autoCircuitBreaker', (sessionId, trigger, consecutive, total) => {
      this.handleAutoCircuitBreaker(sessionId, trigger, consecutive, total);
    });

    this.runtime.on('tokenUsage', (sessionId, usage) => {
      this.handleTokenUsage(sessionId, usage);
    });

    this.runtime.on('unknownClaudeEvent', (sessionId, event) => {
      this.handleUnknownClaudeEvent(sessionId, event);
    });

    this.runtime.on('processExited', (sessionId, code, signal, errorDetail, streamedLength) => {
      this.handleProcessExited(sessionId, code, signal, errorDetail, streamedLength);
    });

    this.runtime.on('debug', (message) => {
      this.emitEvent('debug', { message });
    });

    this.runtime.on('defaultModelLabeled', () => {
      this.emitEvent('catalog.refresh', {});
    });

    // Start capability discovery.
    await this.runtime.start();
  }

  setEventSink(handler: ProxyEventSink) {
    this.emitEvent = handler;
  }

  async readOfficialQuota(params: import('@gian/proxy-protocol').OfficialQuotaReadParams): Promise<import('@gian/proxy-protocol').ProxyOfficialQuotaReadResult> {
    return this.runtime.readOfficialQuota ? this.runtime.readOfficialQuota(params)
      : { status: 'unsupported', authRevision: null, error: null, windows: [], balances: [] };
  }

  async inspectCustomizations(params: {
    kind: import('@gian/proxy-protocol').CustomizationKind;
    cwd?: string;
  }): Promise<import('@gian/proxy-protocol').CustomizationListResult> {
    try {
      return await this.customization.list(params.kind, params.cwd ?? null);
    } catch (error) {
      if (error instanceof ScanTimeoutError) {
        return customizationUnavailable(params.kind, [{
          code: 'PROVIDER_INSPECTION_FAILED',
          message: error.message,
        }]);
      }
      throw error;
    }
  }

  async customizationDetail(params: {
    kind: import('@gian/proxy-protocol').CustomizationKind;
    id: string;
    cwd?: string;
  }): Promise<import('@gian/proxy-protocol').CustomizationDetailResult> {
    try {
      return await this.customization.detail(params.kind, params.id, params.cwd ?? null);
    } catch (error) {
      if (error instanceof ScanTimeoutError) {
        return {
          kind: params.kind,
          id: params.id,
          status: 'unavailable',
          observedAt: new Date().toISOString(),
          text: '',
          truncated: false,
          diagnostics: [{ code: 'PROVIDER_INSPECTION_FAILED', message: error.message }],
        };
      }
      throw error;
    }
  }

  async close() {
    await this.runtime.stop();
  }

  initializePayload(): InitializePayload {
    return {
      mode: 'spawn',
      protocolVersion: '0.1.0',
      methods: [
        'initialize',
        'capabilities.list',
        'slash.list',
        'session.create',
        'session.get',
        'turn.start',
        'turn.interrupt',
        'approval.respond',
        'session.snapshot',
        'session.close',
        'shutdown',
      ],
    };
  }

  async listCapabilities(): Promise<CapabilitiesPayload> {
    // start() kicks off billing-safe capability discovery in the background
    // (Claude help + local command files only). Do not run `claude -p` from
    // capabilities: a stray probe turn would count against Agent SDK credit.
    await this.runtime.awaitModelDiscovery();
    return {
      protocolVersion: '0.1.0',
      models: this.runtime.getModels(),
      modes: [
        { id: 'plan', label: 'Plan', description: 'Explore and plan without making changes.', isDefault: false },
        { id: 'ask', label: 'Ask', description: 'Ask before risky actions.', isDefault: true },
        { id: 'auto', label: 'Auto', description: 'Let the Proxy review actions automatically.', isDefault: false },
      ],
      slashCommands: await listAllSlashCommands(),
    };
  }

  /** Native permission modes reported by the configured Claude CLI help.
   *  Empty when the optional runtime probe is unavailable. */
  getPermissionModes(): string[] {
    return this.runtime.getPermissionModes?.() ?? [];
  }

  async listSlashCommands(cwd?: string): Promise<{ commands: import('@gian/shared').SlashCommand[] }> {
    return { commands: await listAllSlashCommands(cwd) };
  }

  // ---------------------------------------------------------------------------
  // Session lifecycle
  // ---------------------------------------------------------------------------

  async createSession(input: CreateSessionParams) {
    const cwd = resolve(normalizeNonEmptyString(input.cwd, 'cwd'));
    // If host passed a pre-existing claudeSessionId (adoption / reconnect),
    // use it so the next `claude -p --resume <id>` finds the existing on-disk
    // session. Otherwise generate fresh and the next spawn uses --session-id.
    const suppliedSessionId = typeof input.claudeSessionId === 'string' && input.claudeSessionId.trim()
      ? input.claudeSessionId.trim()
      : null;
    const wasResumed = suppliedSessionId !== null && input.resumeExisting !== false;
    const claudeSessionId = suppliedSessionId ?? randomUUID();
    const createdAt = nowIso();

    const session: SessionRecord = {
      id: randomId('sess'),
      cwd,
      claudeSessionId,
      wasResumed,
      model: typeof input.model === 'string' && input.model.trim() ? input.model.trim() : null,
      status: 'idle',
      activeTurnId: null,
      lastError: null,
      processAlive: false,
      mcpServers: structuredClone(input.mcpServers ?? []),
      createdAt,
      updatedAt: createdAt,
    };

    this.addSession(session);
    return { session: this.serializeSession(session) };
  }

  getSession(params: GetSessionParams) {
    const session = this.requireSessionById(normalizeNonEmptyString(params.sessionId, 'sessionId'));
    return { session: this.serializeSession(session) };
  }

  mcpServers(sessionId: string): SessionRecord['mcpServers'] {
    return structuredClone(this.requireSessionById(sessionId).mcpServers);
  }

  async startTurn(params: StartTurnParams, requestId?: number | string) {
    const session = this.requireSessionById(params.sessionId);
    if (session.status === 'closed') {
      throw createAppError(409, 'SESSION_CLOSED', 'This session is closed.');
    }
    if (session.activeTurnId) {
      throw createAppError(409, 'SESSION_BUSY', 'This session already has an active turn.');
    }

    const input = normalizeInputItems(params.input, session.cwd);
    const prompt = buildPrompt(input);

    // Gian-level `/clear` intercept. Instead of Claude's own `/clear` we
    // rotate the underlying claudeSessionId, so the next turn starts a new
    // process with `--session-id <new>` (fresh history) and the host can swap
    // its native session reference. The Gian session id is unchanged — only
    // the Claude-side persistence rotates.
    if (prompt.trim() === '/clear') {
      return this.handleClearIntercept(session, requestId);
    }

    // Only omission inherits the session model. An explicit null/empty value
    // means "use Claude's configured default" and must clear a prior override.
    const requestedModel = params.model === undefined
      ? session.model
      : typeof params.model === 'string' && params.model.trim()
        ? params.model.trim()
        : null;

    // Ensure Claude Code process is running for this session.
    await this.ensureProcess(session, requestedModel);
    // setSessionModel clears the init model id. Read it first so a Default
    // turn can still see the model Claude actually started.
    const detectedModelId = this.runtime.getDetectedModelId(session.id);
    // The runtime keeps one registered session across turns and applies the
    // model to its running process. Keep it synchronized even when
    // ensureProcess() finds the session already registered.
    this.runtime.setSessionModel(session.id, requestedModel);

    const turnId = randomId('turn');
    const isCompact = prompt.trim().split(/\s+/, 1)[0]?.toLowerCase() === '/compact';
    this.activeTurns.set(session.id, { turnId, requestId, isCompact });

    if (isCompact) {
      // The pre-compact numerator is now invalid. Clear it before Claude can
      // stream a post-compact assistant usage sample; never wait for a
      // transcript heuristic or reuse the stale value.
      this.emitEvent('token_usage.updated', {
        requestId,
        sessionId: session.id,
        turnId,
        data: { context: null, reason: 'compact_started' },
      });
    }

    // Send the user message. `thinking` is the host-side abstraction; Claude
    // CLI calls it `--effort`. Validate against the levels discovered from
    // Claude Code itself instead of carrying a Gian-side enum.
    let effort: import('./types.js').EffortLevel | null = null;
    if (typeof params.thinking === 'string' && params.thinking.trim()) {
      await this.runtime.awaitModelDiscovery();
      const requestedEffort = params.thinking.trim();
      const discoveredModels = this.runtime.getModels();
      // Default's runtime model is '' while an omitted selection is null, so
      // an exact match only applies to a concrete requested id. A matched
      // model, including one reported by init, uses only its own efforts.
      // With neither, any catalog entry may list the level.
      const concrete = requestedModel
        ? discoveredModels.find(model => model.model === requestedModel)
          ?? (discoveredModels.length === 1 ? discoveredModels[0] : null)
        : null;
      const detected = !concrete && detectedModelId
        ? discoveredModels.find(model => model.model === detectedModelId) ?? null
        : null;
      const effortSource = concrete ?? detected;
      const supportedEfforts = new Set(
        effortSource
          ? effortSource.supportedEfforts
          : discoveredModels.flatMap(model => model.supportedEfforts),
      );
      effort = supportedEfforts.has(requestedEffort) ? requestedEffort : null;
    }
    const additionalDirectories = [...new Set(
      input
        .filter((item): item is Extract<InputItem, { type: 'localFile' }> =>
          item.type === 'localFile')
        .map(item => dirname(item.path)),
    )];
    try {
      await this.runtime.sendMessage(session.id, prompt, {
        permissionMode: params.permissionMode ?? null,
        effort,
        displayName: params.displayName ?? null,
        additionalDirectories,
      });
    } catch (error) {
      this.activeTurns.delete(session.id);
      this.unpublishedExits.delete(session.id);
      throw error;
    }
    // The child can exit in the same task as spawn, before activeTurnId is
    // published. Take that exit synchronously — no await — so it cannot land
    // both as a stash and as a live failure.
    const pendingExit = this.unpublishedExits.get(session.id);
    this.unpublishedExits.delete(session.id);

    const updatedSession = this.updateSession(session, {
      activeTurnId: turnId,
      status: 'running',
      model: requestedModel,
      lastError: null,
    });

    this.emitEvent('turn.started', {
      requestId,
      sessionId: updatedSession.id,
      turnId,
      data: { turnId, status: 'running' },
    });

    if (pendingExit) {
      this.handleProcessExited(
        session.id,
        pendingExit.code,
        pendingExit.signal,
        pendingExit.errorDetail,
        pendingExit.streamedLength,
      );
    }
    const published = this.sessionsById.get(session.id) ?? updatedSession;

    return {
      session: this.serializeSession(published),
      turn: { id: turnId, status: published.activeTurnId ? 'running' : 'error' },
    };
  }

  async interruptTurn(params: InterruptTurnParams) {
    const session = this.requireSessionById(params.sessionId);
    if (!session.activeTurnId) {
      throw createAppError(409, 'INVALID_REQUEST', 'This session does not have an active turn.');
    }

    // Keep the registered session so the next turn continues it. killSession
    // would forget that Claude already created the native session, and the
    // replacement CLI would then pass --session-id for an existing id.
    if (this.runtime.interruptActiveProcess) {
      this.runtime.interruptActiveProcess(session.id);
    } else {
      this.runtime.killSession(session.id);
    }
    this.unpublishedExits.delete(session.id);
    this.activeTurns.delete(session.id);
    this.clearToolCallNames(session.id);

    const updated = this.updateSession(session, {
      activeTurnId: null,
      status: 'idle',
      lastError: null,
    });
    return { ok: true, session: this.serializeSession(updated) };
  }

  /** Add input to the active turn. Claude folds it in at its next step. */
  async steerTurn(params: { sessionId: string; input: InputItem[] }) {
    const session = this.requireSessionById(params.sessionId);
    if (!session.activeTurnId) {
      throw createAppError(409, 'INVALID_REQUEST', 'This session does not have an active turn.');
    }
    if (!this.runtime.steer) {
      throw createAppError(400, 'CAPABILITY_NOT_SUPPORTED', 'This runtime cannot steer a running turn.');
    }
    const prompt = buildPrompt(normalizeInputItems(params.input, session.cwd));
    if (!prompt.trim()) {
      throw createAppError(400, 'INVALID_REQUEST', 'Steer input is empty.');
    }
    await this.runtime.steer(session.id, prompt);
    return { ok: true, session: this.serializeSession(session) };
  }

  async respondApproval(params: ApprovalResponseParams) {
    const session = this.requireSessionById(params.sessionId);
    const approval = this.approvalsById.get(params.approvalId);
    if (!approval || approval.sessionId !== session.id) {
      throw createAppError(404, 'APPROVAL_NOT_FOUND', 'Approval not found.');
    }

    // Every approval — including ExitPlanMode and AskUserQuestion — is a
    // live `can_use_tool` request Claude waits on; without an answer the
    // turn would never continue. AskUserQuestion answers go back on the
    // allow, merged into the tool input, which is how Claude Code takes
    // answers from an SDK host.
    await this.runtime.respondPermission(
      session.id,
      approval.requestId,
      params.behavior,
      params.answers ? { answers: params.answers } : undefined,
    );

    this.removeApproval(approval);
    const updatedSession = this.updateSession(session, {
      status: session.activeTurnId ? 'running' : 'idle',
      lastError: null,
    });

    this.emitEvent('approval.resolved', {
      sessionId: updatedSession.id,
      turnId: updatedSession.activeTurnId ?? undefined,
      data: {
        approvalId: approval.approvalId,
        behavior: params.behavior,
        // Echo the picked answers so the web's resolved question card can
        // show "answered with …" without waiting for the JSONL replay.
        ...(params.answers ? { answers: params.answers } : {}),
      },
    });

    return { ok: true, session: this.serializeSession(updatedSession) };
  }

  sessionSnapshot(params: SessionSnapshotParams) {
    const session = this.requireSessionById(params.sessionId);
    return { session: this.serializeSession(session) };
  }

  async closeSession(params: CloseSessionParams) {
    const session = this.requireSessionById(params.sessionId);
    if (session.activeTurnId) {
      throw createAppError(409, 'SESSION_BUSY', 'Stop the active turn before closing the session.');
    }

    // Kill the Claude Code process if alive.
    this.runtime.killSession(session.id);
    this.removeSession(session);
    return { ok: true };
  }

  /**
   * Handle Gian's `/clear` command without invoking Claude. Rotate the
   * claudeSessionId, emit synthetic turn events plus a `session.rotated`
   * notification so the host can swap its nativeSessionId reference.
   * The internal session.id stays stable across rotations; only the
   * Claude-side persistence ID changes.
   */
  private async handleClearIntercept(
    session: SessionRecord,
    requestId?: number | string,
  ) {
    const turnId = randomId('turn');
    const oldClaudeSessionId = session.claudeSessionId;
    const newClaudeSessionId = randomUUID();
    const ackText = 'Conversation cleared. Next message starts a fresh context.';

    // Rotate the underlying Claude session id and reset runtime state so
    // `sendMessage` will use `--session-id` (fresh) instead of `--resume`.
    this.runtime.resetClaudeSessionId(session.id, newClaudeSessionId);
    const updated = this.updateSession(session, {
      claudeSessionId: newClaudeSessionId,
      // Fresh native session — first spawn will use --session-id, not --resume.
      wasResumed: false,
      lastError: null,
    });

    // Notify host of the native-session-id swap so it can update its own
    // bookkeeping. Internal session.id is unchanged so existing references
    // to it (e.g. WebSocket subscriptions) remain valid.
    this.emitEvent('session.rotated', {
      sessionId: updated.id,
      data: {
        oldNativeSessionId: oldClaudeSessionId,
        newNativeSessionId: newClaudeSessionId,
      },
    });

    // Emit the same trio of events a real turn produces, so transcript
    // rendering / token tracking treat this like a normal exchange.
    this.emitEvent('turn.started', {
      requestId,
      sessionId: updated.id,
      turnId,
      data: { turnId, status: 'running' },
    });
    this.emitEvent('output.text', {
      requestId,
      sessionId: updated.id,
      turnId,
      data: { text: ackText, itemId: turnId },
    });
    this.emitEvent('turn.completed', {
      requestId,
      sessionId: updated.id,
      turnId,
      data: { result: ackText },
    });

    return {
      session: this.serializeSession(updated),
      turn: { id: turnId, status: 'completed' },
    };
  }

  // ---------------------------------------------------------------------------
  // Runtime event handlers
  // ---------------------------------------------------------------------------

  /**
   * Intermediate assistant text block streamed from Claude. Emit as a
   * regular `output.text` notification carrying `itemId` so the web side can
   * render multiple distinct messages (one per block) interleaved with tool
   * calls. Crucially, this does NOT touch active-turn state — the turn
   * stays running until `channelReply` (turn end) or `processExited`.
   */
  private handleAssistantText(sessionId: string, text: string, itemId: string) {
    const session = this.sessionsById.get(sessionId);
    if (!session) return;
    const context = this.activeTurns.get(sessionId);
    const turnId = context?.turnId ?? session.activeTurnId;

    this.emitEvent('output.text', {
      requestId: context?.requestId,
      sessionId: session.id,
      turnId,
      data: { text, itemId },
    });
  }

  private handleAssistantReasoning(sessionId: string, text: string, itemId: string) {
    const session = this.sessionsById.get(sessionId);
    if (!session) return;
    const context = this.activeTurns.get(sessionId);
    this.emitEvent('output.reasoning', {
      requestId: context?.requestId,
      sessionId: session.id,
      turnId: context?.turnId ?? session.activeTurnId,
      data: { text, itemId },
    });
  }


  private handleChannelReply(sessionId: string, text: string) {
    const session = this.sessionsById.get(sessionId);
    if (!session) return;

    const context = this.activeTurns.get(sessionId);
    const turnId = context?.turnId ?? session.activeTurnId;

    // Empty text means the runtime already streamed each block via
    // `assistantText`; re-emitting `result` would duplicate the last block.
    // Only fire output.text when there's actually new text to surface.
    if (text.length > 0) {
      this.emitEvent('output.text', {
        requestId: context?.requestId,
        sessionId: session.id,
        turnId,
        data: { text },
      });
    }

    // Each reply call from Claude Code represents a complete response.
    // Mark the turn as completed.
    this.activeTurns.delete(sessionId);
    this.clearToolCallNames(sessionId);
    const updated = this.updateSession(session, {
      activeTurnId: null,
      status: 'idle',
      lastError: null,
    });

    this.emitEvent('turn.completed', {
      requestId: context?.requestId,
      sessionId: updated.id,
      turnId,
      data: { status: 'completed', result: text },
    });
  }

  private handleToolUse(
    sessionId: string,
    toolName: string,
    input: Record<string, unknown>,
    callId: string,
  ) {
    const session = this.sessionsById.get(sessionId);
    if (!session) return;

    this.toolCallNames.set(`${sessionId}:${callId}`, toolName);
    if (APPROVAL_BRIDGED_TOOLS.has(toolName)) return;

    const context = this.activeTurns.get(sessionId);
    const turnId = context?.turnId ?? session.activeTurnId;

    this.emitEvent('tool.use', {
      requestId: context?.requestId,
      sessionId: session.id,
      turnId,
      data: { callId, toolName, input },
    });
  }

  private handleToolResult(
    sessionId: string,
    callId: string,
    output: unknown,
    isError: boolean,
  ) {
    const session = this.sessionsById.get(sessionId);
    if (!session) return;
    const nameKey = `${sessionId}:${callId}`;
    const toolName = this.toolCallNames.get(nameKey);
    this.toolCallNames.delete(nameKey);
    // A result without a seen toolUse (e.g. replay boundary) still surfaces.
    if (toolName !== undefined && APPROVAL_BRIDGED_TOOLS.has(toolName)) return;
    const context = this.activeTurns.get(sessionId);
    this.emitEvent('tool.result', {
      requestId: context?.requestId,
      sessionId: session.id,
      turnId: context?.turnId ?? session.activeTurnId,
      data: { callId, output, isError },
    });
  }

  private handleAgentTask(sessionId: string, update: ClaudeAgentTaskUpdate) {
    const session = this.sessionsById.get(sessionId);
    if (!session) return;

    const context = this.activeTurns.get(sessionId);
    this.emitEvent('claude.task', {
      requestId: context?.requestId,
      sessionId: session.id,
      turnId: context?.turnId ?? session.activeTurnId,
      data: update,
    });
  }

  /**
   * Auto-mode classifier blocked an action. Forward to host as a non-blocking
   * notification so the UI can show the user what was blocked. Per Anthropic
   * docs, the agent receives the deny reason and tries an alternative — this
   * event is informational only.
   */
  private handleAutoClassifierDenied(
    sessionId: string,
    action: string,
    reason: string,
    consecutive: number,
    total: number,
  ) {
    const session = this.sessionsById.get(sessionId);
    if (!session) return;

    const context = this.activeTurns.get(sessionId);
    this.emitEvent('auto.classifier_denied', {
      requestId: context?.requestId,
      sessionId: session.id,
      turnId: context?.turnId ?? session.activeTurnId,
      data: { action, reason, consecutive, total },
    });
  }

  private handleTokenUsage(sessionId: string, usage: TokenUsageUpdate) {
    const session = this.sessionsById.get(sessionId);
    if (!session) return;

    const context = this.activeTurns.get(sessionId);
    const effectiveModelId = this.runtime.getDetectedModelId(sessionId) ?? session.model;
    // Claude may report the summarization request's large, pre-compact input
    // as an assistant usage sample. Keep its conversation delta, but never
    // let that sample refill the context numerator we just invalidated.
    const { context: reportedContext, ...usageWithoutContext } = usage;
    const contextSafeUsage: TokenUsageUpdate = context?.isCompact
      ? usageWithoutContext
      : {
          ...usageWithoutContext,
          ...(reportedContext === undefined ? {} : { context: reportedContext }),
        };
    const inferredContextWindow = contextSafeUsage.context?.window === undefined
      ? inferContextWindow(effectiveModelId)
      : undefined;
    const normalized: TokenUsageUpdate = {
      ...contextSafeUsage,
      ...(contextSafeUsage.context && inferredContextWindow !== undefined
        ? {
            context: {
              ...contextSafeUsage.context,
              window: inferredContextWindow,
            },
          }
        : {}),
    };
    if (normalized.context === undefined && normalized.conversation === undefined && normalized.reason === undefined) {
      return;
    }

    this.emitEvent('token_usage.updated', {
      requestId: context?.requestId,
      sessionId: session.id,
      turnId: context?.turnId ?? session.activeTurnId,
      data: normalized,
    });
  }

  /**
   * Auto-mode circuit breaker tripped (3 consecutive / 20 total). In `claude
   * -p` mode the session aborts; this event lets host show a recovery card.
   */
  private handleAutoCircuitBreaker(
    sessionId: string,
    trigger: 'consecutive' | 'total',
    consecutive: number,
    total: number,
  ) {
    const session = this.sessionsById.get(sessionId);
    if (!session) return;

    const context = this.activeTurns.get(sessionId);
    this.emitEvent('auto.circuit_breaker', {
      requestId: context?.requestId,
      sessionId: session.id,
      turnId: context?.turnId ?? session.activeTurnId,
      data: { trigger, consecutive, total },
    });
  }

  /** Unknown but visible Claude stream-json event. The v2 adapter converts
   *  this to a generic `activity.updated` so Provider additions never
   *  disappear silently. */
  private handleUnknownClaudeEvent(sessionId: string, event: Record<string, unknown>) {
    const session = this.sessionsById.get(sessionId);
    if (!session) return;

    const context = this.activeTurns.get(sessionId);
    this.emitEvent('claude.unknown_event', {
      requestId: context?.requestId,
      sessionId: session.id,
      turnId: context?.turnId ?? session.activeTurnId,
      data: { event },
    });
  }

  private handlePermissionRequest(sessionId: string, requestId: string, toolName: string, description: string, inputPreview: string) {
    const session = this.sessionsById.get(sessionId);
    if (!session) return;

    // ExitPlanMode gets a category tag so the host can pick a specialized UI
    // (plan card + 3-way decision) without re-deriving from toolName. Plain
    // permission requests carry no category.
    const isExitPlanMode = toolName === 'ExitPlanMode';
    const finalDescription = isExitPlanMode
      ? 'Claude has finished planning. Choose how to proceed.'
      : description;

    const context = this.activeTurns.get(sessionId);
    const approval: PendingApproval = {
      approvalId: randomId('appr'),
      sessionId: session.id,
      requestId,
      toolName,
      description: finalDescription,
      inputPreview,
      createdAt: nowIso(),
      ...(isExitPlanMode ? { category: 'exit_plan_mode' } : {}),
    };

    this.addApproval(approval);
    this.updateSession(session, { status: 'needs-approval' });

    this.emitEvent('approval.requested', {
      requestId: context?.requestId,
      sessionId: session.id,
      turnId: context?.turnId ?? session.activeTurnId,
      data: approval,
    });
  }

  private handleProcessExited(
    sessionId: string,
    code: number | null,
    signal: string | null,
    errorDetail?: string,
    streamedLength?: number,
  ) {
    const session = this.sessionsById.get(sessionId);
    if (!session) return;

    const context = this.activeTurns.get(sessionId);
    if (session.activeTurnId === null) {
      if (context) {
        this.unpublishedExits.set(sessionId, {
          code,
          signal,
          ...(errorDetail !== undefined ? { errorDetail } : {}),
          streamedLength: streamedLength ?? 0,
        });
      }
      return;
    }

    this.failActiveTurn(
      session,
      claudeProcessExitFailure(code, signal, streamedLength ?? 0, errorDetail),
      false,
    );
  }

  /** The turn ended with an error result; the process itself lives on. */
  private handleTurnFailed(sessionId: string, errorDetail: string, streamedLength: number) {
    const session = this.sessionsById.get(sessionId);
    if (!session || session.activeTurnId === null) return;
    this.failActiveTurn(session, {
      message: errorDetail,
      retryable: false,
      details: { streamedLength },
    }, true);
  }

  private failActiveTurn(
    session: SessionRecord,
    failure: { message: string; retryable: boolean; details: Record<string, unknown> },
    processAlive: boolean,
  ) {
    const context = this.activeTurns.get(session.id);
    this.activeTurns.delete(session.id);
    this.unpublishedExits.delete(session.id);
    this.clearToolCallNames(session.id);

    // Clear all pending approvals: the turn they belonged to is over.
    const approvals = this.approvalsBySessionId.get(session.id);
    if (approvals) {
      for (const id of approvals.keys()) {
        this.approvalsById.delete(id);
      }
      this.approvalsBySessionId.delete(session.id);
    }

    const updated = this.updateSession(session, {
      activeTurnId: null,
      processAlive,
      status: 'error',
      lastError: failure.message,
    });

    this.emitEvent('turn.failed', {
      requestId: context?.requestId,
      sessionId: updated.id,
      turnId: context?.turnId,
      data: {
        status: 'failed',
        error: {
          message: failure.message,
          retryable: failure.retryable,
          details: failure.details,
        },
      },
    });
  }

  /** Claude withdrew a pending approval (e.g. its turn was interrupted). */
  private handlePermissionCancelled(sessionId: string, requestId: string) {
    const session = this.sessionsById.get(sessionId);
    if (!session) return;
    const approval = [...(this.approvalsBySessionId.get(sessionId)?.values() ?? [])]
      .find((candidate) => candidate.requestId === requestId);
    if (!approval) return;
    this.removeApproval(approval);
    const updated = this.updateSession(session, {
      status: session.activeTurnId ? 'running' : 'idle',
    });
    const context = this.activeTurns.get(sessionId);
    // No behavior: the adapter resolves an unanswered interaction as cancelled.
    this.emitEvent('approval.resolved', {
      requestId: context?.requestId,
      sessionId: updated.id,
      turnId: context?.turnId ?? updated.activeTurnId ?? undefined,
      data: { approvalId: approval.approvalId },
    });
  }

  // ---------------------------------------------------------------------------
  // Process management
  // ---------------------------------------------------------------------------

  private async ensureProcess(session: SessionRecord, modelOverride?: string | null): Promise<void> {
    if (this.runtime.isSessionAlive(session.id)) {
      return;
    }

    // First spawn for this session in this proxy process. Use --resume only
    // if the host explicitly supplied a claudeSessionId at creation time
    // (adoption / reconnect — the JSONL exists on disk). Otherwise the
    // session was minted here so we use --session-id for a fresh start.
    // After the first spawn the runtime flips its internal hasHadFirstTurn,
    // so all subsequent spawns use --resume regardless of this flag.
    const isResume = session.wasResumed;
    const model = modelOverride === undefined ? session.model : modelOverride;

    try {
      await this.runtime.spawnSession({
        sessionId: session.id,
        claudeSessionId: session.claudeSessionId,
        cwd: session.cwd,
        model,
        isResume,
        mcpServers: session.mcpServers,
      });
      this.updateSession(session, { processAlive: true, lastError: null });
    } catch (error) {
      // If resume failed, try creating a new Claude session.
      if (isResume) {
        const oldClaudeSessionId = session.claudeSessionId;
        const newClaudeSessionId = randomUUID();
        try {
          await this.runtime.spawnSession({
            sessionId: session.id,
            claudeSessionId: newClaudeSessionId,
            cwd: session.cwd,
            model,
            isResume: false,
            mcpServers: session.mcpServers,
          });
          const updated = this.updateSession(session, {
            claudeSessionId: newClaudeSessionId,
            wasResumed: false,
            processAlive: true,
            lastError: null,
          });
          this.emitEvent('session.rotated', {
            sessionId: updated.id,
            data: {
              oldNativeSessionId: oldClaudeSessionId,
              newNativeSessionId: newClaudeSessionId,
            },
          });
        } catch (retryError) {
          throw createAppError(500, 'PROCESS_SPAWN_FAILED', retryError instanceof Error ? retryError.message : String(retryError));
        }
      } else {
        throw createAppError(500, 'PROCESS_SPAWN_FAILED', error instanceof Error ? error.message : String(error));
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Session bookkeeping
  // ---------------------------------------------------------------------------

  private addSession(session: SessionRecord) {
    this.sessionsById.set(session.id, session);
  }

  private removeSession(session: SessionRecord) {
    this.sessionsById.delete(session.id);
    this.activeTurns.delete(session.id);
    this.unpublishedExits.delete(session.id);
    this.clearToolCallNames(session.id);
    const approvals = this.approvalsBySessionId.get(session.id);
    if (approvals) {
      for (const id of approvals.keys()) {
        this.approvalsById.delete(id);
      }
      this.approvalsBySessionId.delete(session.id);
    }
  }

  private clearToolCallNames(sessionId: string) {
    const prefix = `${sessionId}:`;
    for (const key of this.toolCallNames.keys()) {
      if (key.startsWith(prefix)) this.toolCallNames.delete(key);
    }
  }

  private updateSession(session: SessionRecord, patch: Partial<SessionRecord>) {
    const next: SessionRecord = { ...session, ...patch, updatedAt: nowIso() };
    this.sessionsById.set(next.id, next);
    return next;
  }

  private serializeSession(session: SessionRecord) {
    return {
      id: session.id,
      cwd: session.cwd,
      claudeSessionId: session.claudeSessionId,
      model: session.model,
      status: session.status,
      processAlive: session.processAlive,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      lastError: session.lastError,
    };
  }

  private requireSessionById(sessionId: string) {
    const session = this.sessionsById.get(sessionId);
    if (!session) {
      throw createAppError(404, 'SESSION_NOT_FOUND', 'Session not found.');
    }
    return session;
  }

  private addApproval(approval: PendingApproval) {
    this.approvalsById.set(approval.approvalId, approval);
    let map = this.approvalsBySessionId.get(approval.sessionId);
    if (!map) {
      map = new Map();
      this.approvalsBySessionId.set(approval.sessionId, map);
    }
    map.set(approval.approvalId, approval);
  }

  private removeApproval(approval: PendingApproval) {
    this.approvalsById.delete(approval.approvalId);
    const map = this.approvalsBySessionId.get(approval.sessionId);
    map?.delete(approval.approvalId);
    if (map && map.size === 0) {
      this.approvalsBySessionId.delete(approval.sessionId);
    }
  }
}
