/**
 * KimiProxyService — orchestration over the Kimi Code 2.7 local server API
 * (`kimi web --json` REST + `/api/v1/ws` conversation feed).
 *
 * Semantics: exclusive attach per native session, stream-scoped turn ledger
 * at the adapter, detach-only close, opaque sidechat resume refs, and honest
 * state mapping. A Gian turn is bound to native work only through the prompt
 * id in its native opener; nothing is attributed by arrival order.
 */

import { createHash } from 'node:crypto';

import { OpaqueSidechatResumeStore } from '@gian/proxy-protocol';

import { KimiCustomizationScanner, ScanTimeoutError } from './customization.js';
import { buildPromptInput, type OuterInputItem } from './input.js';
import type { KimiModelInfo, KimiSessionInfo } from './types.js';
import { KimiRuntime } from '../runtime/kimi-runtime.js';
import { KimiConversationTurn } from '../runtime/conversation-turn.js';
import { fetchConversationDiff } from '../runtime/conversation-diff.js';
import { conversationTurnError, kimiAuthRequiredMessage } from '../runtime/conversation-error.js';
import { fetchConversationHistory } from '../runtime/conversation-history.js';
import { buildConversationReplay, groupConversationTurns } from '../runtime/conversation-replay.js';
import { conversationInputMetadata } from '../runtime/conversation-input-metadata.js';
import { KimiApiError, KimiTransportError } from '../runtime/rest-client.js';
import { resolveKimiCodeHome } from '../runtime/home.js';
import { reclaimOrphanedKimiServers } from '../runtime/orphan-servers.js';
import { KimiProtocolError } from '../transport/protocol.js';

export type OuterNotification = { method: string; params: Record<string, unknown> };

export interface KimiServiceOptions {
  kimiBin: string;
  dataDir?: string | null;
  /** Test seam / externally managed endpoint: skips spawning `kimi web`. */
  endpoint?: { baseUrl: string; token: string };
  /** How long a Host re-attach waits for Kimi to settle an abandoned turn. */
  rebindIdleWaitMs?: number;
}

export interface SessionRecord {
  sessionId: string;
  /** A Host re-attach is stopping the turn of a stream the Host dropped:
   *  nothing of this session is sent meanwhile. */
  muted?: boolean;
  streamId: string;
  nativeSessionId: string;
  cwd: string;
  state: 'attaching' | 'idle' | 'running' | 'waiting_interaction' | 'stale';
  activeTurn: { gianTurnId: string; promptId: string; nativeTurnId: number | null; interruptAccepted: boolean } | null;
  lastCompleted: { gianTurnId: string; promptId: string; nativeTurnId: number | null } | null;
  conversationTurn: KimiConversationTurn | null;
  conversationSnapshots: Array<Record<string, unknown>>;
  conversationFailure: boolean;
  conversationResyncPending: boolean;
  isSidechat: boolean;
  parentSessionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TurnConfigMap {
  model?: string;
  thinking?: string;
  approval_mode?: string;
}

type ForkAnchor = { type: 'head' } | { type: 'turn'; turnId: string; sourceTurnId: string };

const INTERRUPT_SETTLE_MS = 15_000;
// kap-server validates page_size as integer 1..100 for the session list.
const NATIVE_SESSION_PAGE_SIZE = 100;
/** Best-effort native abort while fencing a turn must not hang. */
const FENCE_ABORT_TIMEOUT_MS = 3_000;
/** Native metadata that marks a Side Chat fork as a child of its parent,
 *  the same keys 2.6's POST /children wrote (agent-core sessionIndex). */
const PARENT_SESSION_ID_KEY = 'parent_session_id';
const CHILD_SESSION_KIND_KEY = 'child_session_kind';

function sha32(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Event IDs remembered per stream to keep them unique. */
const SENT_EVENT_ID_LIMIT = 100_000;

/** How long a Host re-attach waits for Kimi to settle an abandoned turn. */
const REBIND_IDLE_WAIT_MS = 10_000;

/** 2.7 replaced `busy` with `activity` (idle | turn | background). */
function nativeBusy(info: KimiSessionInfo): boolean {
  return (info.activity !== undefined && info.activity !== 'idle')
    || info.pending_interaction === 'approval' || info.pending_interaction === 'question';
}

/** 2.7 requires at least one content part even for native skill-only
 * activation. An empty text part carries no invented user instruction. */
function conversationPromptContent(built: ReturnType<typeof buildPromptInput>): ReturnType<typeof buildPromptInput>['content'] {
  return built.content.length ? built.content : [{ type: 'text', text: '' }];
}

export class KimiProxyService {
  private readonly runtime: KimiRuntime;
  private readonly records = new Map<string, SessionRecord>();
  private readonly byNative = new Map<string, string>();
  private readonly sequences = new Map<string, number>();
  private readonly sidechatStore: OpaqueSidechatResumeStore;
  private readonly customization = new KimiCustomizationScanner();
  private readonly interruptTimers = new Map<string, NodeJS.Timeout>();
  private readonly reconnectTimers = new Map<string, NodeJS.Timeout>();
  private emitSink: (notification: OuterNotification) => void = () => undefined;
  /** Event IDs already sent, per stream, with how often each was sent. */
  private readonly sentEventIds = new Map<string, Map<string, number>>();
  private stopped = false;

  constructor(private readonly options: KimiServiceOptions) {
    this.runtime = new KimiRuntime({
      kimiBin: options.kimiBin,
      ...(options.endpoint !== undefined ? { endpoint: options.endpoint } : {}),
    });
    this.sidechatStore = new OpaqueSidechatResumeStore(options.dataDir ?? null);
    this.runtime.on('conversation-event', (frame) => this.handleConversationFrame(frame));
    this.runtime.on('resync', (sessionId) => this.handleResync(sessionId));
    this.runtime.on('down', () => this.handleRuntimeDown());
  }

  setEmitSink(sink: (notification: OuterNotification) => void): void {
    // A stream the Host replaced (a re-attach) is over for it: the Host
    // validates every later event against the new stream and faults the
    // session on any old-stream event. Nothing is sent on a stale stream.
    this.emitSink = notification => {
      const params = notification.params;
      const sessionId = typeof params.sessionId === 'string' ? params.sessionId : null;
      const streamId = typeof params.streamId === 'string' ? params.streamId : null;
      const record = sessionId === null ? undefined : this.records.get(sessionId);
      if (record !== undefined && (record.muted === true || (streamId !== null && streamId !== record.streamId))) return;
      sink(this.uniqueEventId(notification, streamId));
    };
  }

  /** An event ID is never sent twice on a stream. Event IDs derive from
   *  their content, so a state that repeats inside a turn (Kimi retrying the
   *  same attempt again, an update back to an earlier value) would repeat
   *  one; the Host treats a repeated ID as a resend that does not advance
   *  the sequence, and faults on every later event. A repeat is sent under a
   *  numbered ID instead; the first keeps the ID replay matches. */
  private uniqueEventId(notification: OuterNotification, streamId: string | null): OuterNotification {
    const eventId = notification.params.eventId;
    if (streamId === null || typeof eventId !== 'string') return notification;
    let sent = this.sentEventIds.get(streamId);
    if (sent === undefined) { sent = new Map(); this.sentEventIds.set(streamId, sent); }
    const count = sent.get(eventId) ?? 0;
    sent.set(eventId, count + 1);
    if (sent.size > SENT_EVENT_ID_LIMIT) {
      for (const id of sent.keys()) { sent.delete(id); if (sent.size <= SENT_EVENT_ID_LIMIT / 2) break; }
    }
    if (count === 0) return notification;
    return { ...notification, params: { ...notification.params, eventId: `${eventId}~${count + 1}` } };
  }

  private nextSequence(sessionId: string): number {
    const next = (this.sequences.get(sessionId) ?? 0) + 1;
    this.sequences.set(sessionId, next);
    return next;
  }

  private async ensureStarted(): Promise<void> {
    if (this.stopped) throw new KimiProtocolError('SESSION_CLOSED', 'The proxy service is shutting down.');
    await this.runtime.start();
  }

  // ---- registry ----

  private register(record: Pick<SessionRecord, 'sessionId' | 'nativeSessionId' | 'cwd' | 'isSidechat' | 'parentSessionId'>): SessionRecord {
    const attached = this.byNative.get(record.nativeSessionId);
    if (attached !== undefined && attached !== record.sessionId) {
      // Exclusive attach: one native session belongs to one Gian session.
      throw new KimiProtocolError('CONFLICT', `Kimi session ${record.nativeSessionId} is already attached to session ${attached}.`);
    }
    const now = nowIso();
    const full: SessionRecord = {
      ...record,
      state: 'idle',
      activeTurn: null,
      streamId: `stream-${sha32([record.sessionId, now])}`,
      lastCompleted: null,
      conversationTurn: null,
      conversationSnapshots: [],
      conversationFailure: false,
      conversationResyncPending: false,
      createdAt: now,
      updatedAt: now,
    };
    this.sequences.set(record.sessionId, 0);
    this.records.set(record.sessionId, full);
    this.byNative.set(record.nativeSessionId, record.sessionId);
    return full;
  }

  get(sessionId: string): SessionRecord | undefined {
    return this.records.get(sessionId);
  }

  requireSession(sessionId: string): SessionRecord {
    const record = this.records.get(sessionId);
    if (record === undefined) {
      throw new KimiProtocolError('SESSION_NOT_FOUND', `Session ${sessionId} is not attached.`);
    }
    return record;
  }

  requireStream(sessionId: string, streamId: string): SessionRecord {
    const record = this.requireSession(sessionId);
    if (record.streamId !== streamId) {
      throw new KimiProtocolError('SESSION_STALE', `Stream ${streamId} is no longer active.`);
    }
    return record;
  }

  private touch(record: SessionRecord): void {
    record.updatedAt = nowIso();
  }

  private setState(record: SessionRecord, state: SessionRecord['state']): void {
    record.state = state;
    this.touch(record);
  }

  /** waiting_interaction when interactions are pending on a running turn. */
  private reconcileState(record: SessionRecord): void {
    if (record.state === 'stale' || record.state === 'attaching') return;
    if (record.activeTurn !== null) {
      const pending = record.conversationTurn?.hasPendingInteractions() === true;
      this.setState(record, pending ? 'waiting_interaction' : 'running');
    } else {
      this.setState(record, 'idle');
    }
  }

  private onTurnFinalizedById(sessionId: string, gianTurnId: string): void {
    const record = this.records.get(sessionId);
    if (record === undefined || record.activeTurn?.gianTurnId !== gianTurnId) return;
    record.lastCompleted = {
      gianTurnId: record.activeTurn.gianTurnId,
      promptId: record.activeTurn.promptId,
      nativeTurnId: record.activeTurn.nativeTurnId,
    };
    record.activeTurn = null;
    this.clearInterruptTimer(record.sessionId);
    this.reconcileState(record);
    this.emitSessionUpdated(record);
  }

  // ---- runtime events ----

  private handleConversationFrame(frame: Record<string, unknown>): void {
    if (process.env.GIAN_KIMI_TRACE_FRAMES === '1') process.stderr.write(`[kimi-frame] ${JSON.stringify(frame).slice(0, 2000)}\n`);
    const nativeId = typeof frame.session_id === 'string' ? frame.session_id : '';
    const gianId = this.byNative.get(nativeId);
    const record = gianId === undefined ? undefined : this.records.get(gianId);
    if (!record || (frame.type !== 'session' && frame.agent_id !== 'main')) return;
    if (frame.type === 'task.list' || frame.type === 'agent' || frame.type === 'session') {
      record.conversationSnapshots = record.conversationSnapshots.filter(value => value.type !== frame.type);
      record.conversationSnapshots.push(frame);
    } else if (frame.type === 'task' && typeof frame.task_id === 'string') {
      const snapshot = record.conversationSnapshots.find(value => value.type === 'task.list');
      if (snapshot && Array.isArray(snapshot.tasks)) {
        const tasks = snapshot.tasks.filter(value => value && typeof value === 'object'
          && (value as Record<string, unknown>).task_id !== frame.task_id);
        if (frame.status === 'running') tasks.push(frame);
        snapshot.tasks = tasks;
      }
    }
    if (!record.conversationTurn) {
      if (record.conversationResyncPending && frame.type === 'turns') {
        record.conversationResyncPending = false; this.clearReconnectWatchdog(record.sessionId);
        this.setState(record, 'idle'); this.emitSessionUpdated(record);
      }
      return;
    }
    try {
      record.conversationTurn.receive(frame);
      this.reconcileState(record);
    } catch {
      if (record.activeTurn) void this.fenceActiveTurn(record, record.activeTurn.gianTurnId,
        'The Kimi conversation feed could not be reconciled safely.');
      else record.conversationFailure = true;
    }
  }

  private handleResync(nativeSessionId: string): void {
    const gianId = this.byNative.get(nativeSessionId);
    if (gianId === undefined) return;
    const record = this.records.get(gianId);
    if (record === undefined) return;
    record.conversationSnapshots = [];
    record.conversationResyncPending = true;
    record.conversationTurn?.disconnected();
    this.setState(record, 'stale'); this.emitSessionUpdated(record);
    this.clearReconnectWatchdog(record.sessionId);
    this.armReconnectWatchdog(record);
  }

  private handleRuntimeDown(): void {
    for (const record of this.records.values()) {
      const downTurnId = record.activeTurn?.gianTurnId ?? null;
      if (downTurnId !== null) {
        void this.fenceActiveTurn(record, downTurnId, 'The Kimi server exited while the turn was running.');
      }
      this.clearInterruptTimer(record.sessionId);
      this.setState(record, 'stale');
      this.emitSink({
        method: 'runtime.error',
        params: {
          eventId: `runtime-down-${sha32([record.sessionId, Date.now()])}`,
          sessionId: record.sessionId,
          streamId: record.streamId,
          sequence: this.nextSequence(record.sessionId),
          emittedAt: nowIso(),
          data: {
            domainCode: 'RUNTIME_ERROR',
            message: 'The Kimi server process exited; the session is stale and recovers on the next request.',
            retryable: true,
            details: {},
          },
        },
      });
    }
  }

  // ---- session lifecycle ----

  private async readNativeSession(nativeSessionId: string): Promise<KimiSessionInfo> {
    return this.runtime.rest.request<KimiSessionInfo>('GET', `/api/v1/sessions/${encodeURIComponent(nativeSessionId)}`)
      .catch((error: unknown) => {
        if (error instanceof KimiApiError && error.code === 40401) {
          throw new KimiProtocolError('NATIVE_SESSION_NOT_FOUND', `Kimi session ${nativeSessionId} does not exist.`);
        }
        throw error;
      });
  }

  async createSession(params: {
    sessionId: string;
    cwd: string;
    nativeSessionId?: string;
    history?: 'none' | 'replay';
  }): Promise<{ snapshot: Record<string, unknown> }> {
    await this.ensureStarted();
    const existing = this.records.get(params.sessionId);
    if (existing !== undefined) {
      // Rebind path: the native identity must match.
      if (params.nativeSessionId !== undefined && params.nativeSessionId !== existing.nativeSessionId) {
        throw new KimiProtocolError('CONFLICT', 'Session id names a different native session.');
      }
      // The Host re-attaches a session it still had here only after it
      // stopped following that stream: its recovery of a stuck or orphaned
      // turn, a session fault, a lost stream. A turn the old stream still
      // owned is abandoned, so it is stopped natively (with any question or
      // approval it waits on) instead of refusing the Host, which left the
      // conversation unable to continue.
      // The Host has dropped the old stream, and it validates any event of
      // this session against the stream this re-attach returns. Stopping the
      // abandoned turn therefore sends nothing at all; the new stream starts
      // afterwards at sequence 1.
      existing.muted = true;
      let info: KimiSessionInfo;
      try {
        if (existing.activeTurn !== null) await this.abandonActiveTurn(existing);
        info = await this.waitForNativeIdle(existing.nativeSessionId);
      } finally {
        existing.muted = false;
      }
      if (nativeBusy(info)) {
        throw new KimiProtocolError('SESSION_BUSY', 'Kimi is still running other work in this session (another Kimi client or a background task); try again when it finishes.', true);
      }
      existing.streamId = `stream-${sha32([params.sessionId, nowIso()])}`;
      this.sequences.set(params.sessionId, 0);
      this.setState(existing, 'idle');
      await this.subscribeNative(existing, { retainOnFailure: true });
      // History arrives via the host's own session.replay pull; no push here.
      return { snapshot: this.snapshot(existing) };
    }

    if (params.nativeSessionId !== undefined) {
      const info = await this.readNativeSession(params.nativeSessionId);
      if (nativeBusy(info)) {
        throw new KimiProtocolError('SESSION_BUSY', 'The native session is busy; refusing to attach.');
      }
      const record = this.register({
        sessionId: params.sessionId,
        nativeSessionId: info.id,
        cwd: info.cwd ?? params.cwd,
        isSidechat: false,
        parentSessionId: null,
      });
      await this.subscribeNative(record);
      return { snapshot: this.snapshot(record) };
    }

    // Fresh native session. 2.7 places it in the workspace bucket for `cwd`
    // (created on first use), so no separate workspace registration.
    const info = await this.runtime.rest.request<KimiSessionInfo>('POST', '/api/v1/sessions', {
      json: { cwd: params.cwd },
    });
    const record = this.register({
      sessionId: params.sessionId,
      nativeSessionId: info.id,
      cwd: info.cwd ?? params.cwd,
      isSidechat: false,
      parentSessionId: null,
    });
    await this.subscribeNative(record);
    return { snapshot: this.snapshot(record) };
  }

  /** Subscribe (or refresh) the native conversation feed. 2.7's WebSocket
   *  subscribe resumes a cold session itself, so a fork or a session from an
   *  earlier server run needs no separate REST resume. */
  private async subscribeNative(record: SessionRecord, options: { retainOnFailure?: boolean } = {}): Promise<void> {
    try {
      await this.runtime.subscribe(record.nativeSessionId);
    } catch (error) {
      if (options.retainOnFailure === true) {
        this.setState(record, 'stale');
        this.emitSessionUpdated(record);
      } else {
        this.dropRecord(record);
      }
      throw error instanceof KimiProtocolError
        ? error
        : new KimiProtocolError('RUNTIME_ERROR', `Kimi event subscription failed: ${error instanceof Error ? error.message : String(error)}`, true);
    }
  }

  private dropRecord(record: SessionRecord): void {
    this.clearReconnectWatchdog(record.sessionId);
    this.records.delete(record.sessionId);
    this.sequences.delete(record.sessionId);
    if (this.byNative.get(record.nativeSessionId) === record.sessionId) {
      this.byNative.delete(record.nativeSessionId);
    }
    this.runtime.forgetSession(record.nativeSessionId);
  }

  snapshot(record: SessionRecord): Record<string, unknown> {
    return {
      id: record.sessionId,
      nativeSession: { id: record.nativeSessionId },
      streamId: record.streamId,
      state: record.state === 'attaching' ? 'idle' : record.state,
      sessionConfig: {},
      availableActions: this.availableActions(record),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  describeSession(sessionId: string): Record<string, unknown> {
    return this.snapshot(this.requireSession(sessionId));
  }

  /** Fork, turn fork and side chat share one gate. Unsupported actions
   *  belong only in Catalog, never in availableActions. */
  private availableActions(record: SessionRecord): Record<string, { enabled: boolean; reason?: string }> {
    const busy = record.activeTurn !== null
      || record.state === 'running'
      || record.state === 'waiting_interaction';
    const ready = !busy && record.state !== 'stale' && record.state !== 'attaching' && record.lastCompleted !== null;
    const gate = ready
      ? { enabled: true }
      : {
          enabled: false,
          reason: busy
            ? 'Wait for the active turn to finish.'
            : 'No completed turn is available to fork from.',
        };
    return {
      'sidechat.create': { ...gate },
      'session.fork': { ...gate },
      'session.fork.atTurn': { ...gate },
    };
  }

  private emitSessionUpdated(record: SessionRecord): void {
    const state = record.state === 'attaching' ? 'idle' : record.state;
    this.emitSink({
      method: 'session.updated',
      params: {
        eventId: `evt-${sha32([record.sessionId, 'session.updated', state, record.updatedAt]).slice(0, 16)}`,
        sessionId: record.sessionId,
        streamId: record.streamId,
        sequence: this.nextSequence(record.sessionId),
        emittedAt: nowIso(),
        data: {
          state,
          availableActions: this.availableActions(record),
          updatedAt: record.updatedAt,
        },
      },
    });
  }

  async closeSession(sessionId: string, streamId: string): Promise<void> {
    const record = this.requireStream(sessionId, streamId);
    if (record.activeTurn !== null) {
      throw new KimiProtocolError('SESSION_BUSY', 'Cannot close while a turn is active.');
    }
    this.dropRecord(record);
    // Detach only: the Kimi session and its history stay in the store.
  }

  // ---- native list / rename / delete ----

  async listNativeSessions(params: {
    cwd?: string;
    cursor?: string | null;
    limit?: number;
  }): Promise<{ sessions: Array<Record<string, unknown>>; nextCursor: string | null }> {
    await this.ensureStarted();
    const limit = params.limit ?? 100;
    let beforeId: string | undefined = undefined;
    if (params.cursor !== null && params.cursor !== undefined && params.cursor !== '') {
      try {
        const parsed = JSON.parse(Buffer.from(params.cursor, 'base64url').toString('utf8')) as { before?: unknown; after?: unknown };
        const pivot = parsed.before ?? parsed.after; // Retain readability of older opaque cursors.
        if (typeof pivot === 'string') beforeId = pivot;
      } catch {
        throw new KimiProtocolError('INVALID_PARAMS', 'cursor is not a valid native list cursor.');
      }
    }
    const page = await this.runtime.rest.request<{ items: KimiSessionInfo[]; has_more?: boolean }>(
      'GET',
      '/api/v1/sessions',
      {
        query: {
          page_size: Math.min(limit, NATIVE_SESSION_PAGE_SIZE),
          busy: false,
          archived: 'false',
          ...(beforeId !== undefined ? { before_id: beforeId } : {}),
        },
      },
    );
    const items = page.items.filter((session) => {
      if (this.byNative.has(session.id)) return false;
      // Side Chat forks are children of their parent, not resumable sessions.
      if (session.metadata?.[CHILD_SESSION_KIND_KEY] === 'child') return false;
      if (params.cwd !== undefined && session.cwd !== params.cwd) return false;
      return true;
    });
    const nextCursor = page.has_more === true && page.items.length > 0
      ? Buffer.from(JSON.stringify({ before: page.items.at(-1)!.id }), 'utf8').toString('base64url')
      : null;
    return {
      sessions: items.map((session) => ({
        id: session.id,
        ...(session.title ? { displayName: session.title } : {}),
        ...(session.cwd ? { cwd: session.cwd } : {}),
        ...(session.updated_at ? { updatedAt: session.updated_at } : {}),
      })),
      nextCursor,
    };
  }

  async renameSession(sessionId: string, streamId: string, name: string): Promise<void> {
    const record = this.requireStream(sessionId, streamId);
    await this.runtime.rest.request('POST', `/api/v1/sessions/${encodeURIComponent(record.nativeSessionId)}/profile`, {
      json: { title: name },
    });
  }

  async deleteNativeSession(nativeSessionId: string): Promise<void> {
    await this.ensureStarted();
    if (this.byNative.has(nativeSessionId)) {
      throw new KimiProtocolError('SESSION_BUSY', 'The native session is attached; close it before deleting.');
    }
    await this.runtime.rest.request('POST', `/api/v1/sessions/${encodeURIComponent(nativeSessionId)}:delete`, { json: {} });
  }

  // ---- turns ----

  async startTurn(params: {
    sessionId: string;
    streamId: string;
    turnId: string;
    input: OuterInputItem[];
    config: TurnConfigMap;
  }): Promise<void> {
    const record = this.requireStream(params.sessionId, params.streamId);
    // Validate the payload BEFORE the busy check: a malformed input must be
    // INVALID_PARAMS regardless of session state, and no prompt is submitted.
    const built = buildPromptInput(params.input);
    if (record.activeTurn !== null) {
      throw new KimiProtocolError('SESSION_BUSY', 'A turn is already active.');
    }
    // An attach-time ACK is no longer proof after a socket/server restart:
    // confirm the current subscription before submitting any prompt.
    await this.ensureStarted();
    await this.subscribeNative(record, { retainOnFailure: true });
    if (record.state === 'stale') this.setState(record, 'idle');
    const promptId = `gian-${sha32([record.nativeSessionId, params.turnId, built])}`;
    await this.startConversationTurn(record, params, built, promptId);
  }

  private async startConversationTurn(
    record: SessionRecord,
    params: { sessionId: string; streamId: string; turnId: string; input: OuterInputItem[]; config: TurnConfigMap },
    built: ReturnType<typeof buildPromptInput>,
    promptId: string,
  ): Promise<void> {
    let admitting = true, finalizedDuringAdmission = false, bufferedBytes = 0;
    const buffered: OuterNotification[] = [];
    record.conversationFailure = false;
    const complete = () => {
      if (admitting) { finalizedDuringAdmission = true; return; }
      if (record.conversationTurn !== turn) return;
      if (record.activeTurn) record.activeTurn.nativeTurnId = turn.getNativeTurnNumber();
      this.onTurnFinalizedById(record.sessionId, params.turnId);
      record.conversationTurn = null;
    };
    const turn = new KimiConversationTurn({
      sessionId: record.sessionId, nativeSessionId: record.nativeSessionId, streamId: record.streamId,
      turnId: params.turnId, promptId, nextSequence: () => admitting ? 0 : this.nextSequence(record.sessionId),
      emit: notification => {
        if (!admitting) { this.emitSink(notification); return; }
        const bytes = Buffer.byteLength(JSON.stringify(notification), 'utf8');
        if (buffered.length >= 4_096 || bufferedBytes + bytes > 32 * 1024 * 1024) { record.conversationFailure = true; return; }
        buffered.push(notification); bufferedBytes += bytes;
      },
      onFinalized: complete,
      onResynced: () => {
        if (record.conversationTurn !== turn) return;
        record.conversationResyncPending = false; this.clearReconnectWatchdog(record.sessionId);
        if (!record.activeTurn) return;
        this.setState(record, turn.hasPendingInteractions() ? 'waiting_interaction' : 'running');
        this.emitSessionUpdated(record);
      },
      holdUntilAdmitted: true,
      fetchDiff: number => fetchConversationDiff((path, query, timeoutMs) => this.runtime.rest.request('GET', path, { query, timeoutMs }), record.nativeSessionId, number),
    });
    record.conversationTurn = turn;
    try {
      for (const snapshot of record.conversationSnapshots) turn.receive(snapshot);
      const promptBody = { content: conversationPromptContent(built), prompt_id: promptId, metadata: conversationInputMetadata(promptId, params.input),
        ...(built.skills.length > 0 ? { skills: built.skills } : {}),
        ...(params.config.model !== undefined ? { model: params.config.model } : {}),
        ...(params.config.thinking !== undefined ? { thinking: params.config.thinking } : {}),
        ...(params.config.approval_mode !== undefined ? { permission_mode: params.config.approval_mode } : {}) };
      const response = await this.runtime.rest.request<{ prompt_id: string; status: string }>(
        'POST', `/api/v1/sessions/${encodeURIComponent(record.nativeSessionId)}/prompts`, { json: promptBody },
      ).catch(async (error: unknown) => {
        if (error instanceof KimiApiError && error.code === 40927) {
          throw new KimiProtocolError('CONFLICT', 'The Kimi server already accepted this turn (prompt id conflict).');
        }
        // 40931: another Kimi server holds this session's lock. A server left
        // behind by a Proxy that was killed is stopped and the same prompt is
        // sent once more; Kimi refused it, so it never started.
        if (error instanceof KimiApiError && error.code === 40931
          && (await this.reclaimSessionLock(record.nativeSessionId)).length > 0) {
          return this.runtime.rest.request<{ prompt_id: string; status: string }>(
            'POST', `/api/v1/sessions/${encodeURIComponent(record.nativeSessionId)}/prompts`, { json: promptBody },
          );
        }
        throw error;
      });
      if (response.prompt_id !== promptId || !['running', 'queued', 'blocked', 'failed'].includes(response.status)) {
        await this.abortNativePrompt(record, promptId);
        this.setState(record, 'stale');
        throw new KimiProtocolError('RUNTIME_ERROR', 'Kimi returned an unexpected prompt identity or status.', true);
      }
      if (response.status === 'failed') throw await this.promptFailure(record, promptId);
      // A queued prompt (2.7.1: another native turn is finishing first) is
      // this Gian turn: it binds when its own opener appears.
      if (response.status === 'queued') turn.markQueued();
      record.activeTurn = { gianTurnId: params.turnId, promptId, nativeTurnId: null, interruptAccepted: false };
      this.emitSink({ method: 'turn.started', params: {
        eventId: `evt-${sha32([record.nativeSessionId, promptId, 'turn.started']).slice(0, 16)}`,
        sessionId: record.sessionId, streamId: record.streamId, sequence: this.nextSequence(record.sessionId),
        turnId: params.turnId, sourceTurnId: promptId, emittedAt: nowIso(), data: {},
      } });
      admitting = false;
      for (const notification of buffered) {
        notification.params.sequence = this.nextSequence(record.sessionId);
        this.emitSink(notification);
      }
      if (record.conversationFailure) void this.fenceActiveTurn(record, params.turnId, 'Kimi conversation admission could not be reconciled safely.');
      else {
        turn.admit();
        if (finalizedDuringAdmission) complete();
        else {
          if (record.conversationResyncPending) this.armReconnectWatchdog(record);
          else if (record.state === 'stale') this.setState(record, 'idle');
          this.reconcileState(record); this.emitSessionUpdated(record);
        }
      }
    } catch (error) {
      if (error instanceof KimiTransportError) {
        const aborted = await this.abortNativePrompt(record, promptId);
        if (!aborted) this.setState(record, 'stale');
      }
      if (record.conversationTurn === turn) record.conversationTurn = null;
      throw error;
    }
  }

  /** A prompt that failed before admission: report the native turn error
   *  when history has one, never a generic rejection when Kimi said why. */
  private async promptFailure(record: SessionRecord, promptId: string): Promise<KimiProtocolError> {
    try {
      const page = await this.runtime.rest.request<{ turns?: Array<Record<string, unknown>> }>('GET',
        `/api/v1/sessions/${encodeURIComponent(record.nativeSessionId)}/agents/main/turns`, { query: { page_size: 5 }, timeoutMs: 5_000 });
      const turn = (page.turns ?? []).find(candidate => Array.isArray(candidate.items) && candidate.items.some(item =>
        typeof item === 'object' && item !== null && (item as Record<string, unknown>).placement === 'opener'
        && Array.isArray((item as Record<string, unknown>).prompt_ids)
        && ((item as Record<string, unknown>).prompt_ids as unknown[]).includes(promptId)));
      if (turn !== undefined && (turn.error !== undefined || turn.end_reason !== undefined)) {
        const failure = conversationTurnError(turn.error, typeof turn.end_reason === 'string' ? turn.end_reason : undefined);
        return new KimiProtocolError(failure.domainCode, failure.message, failure.retryable, failure.details);
      }
    } catch { /* the generic rejection below still reports the native status */ }
    return new KimiProtocolError('RUNTIME_ERROR', 'Kimi rejected the submitted prompt (native status `failed`).', true,
      { nativeStatus: 'failed' });
  }

  async steerTurn(params: {
    sessionId: string;
    streamId: string;
    turnId: string;
    input: OuterInputItem[];
  }): Promise<void> {
    const record = this.requireStream(params.sessionId, params.streamId);
    const turn = record.activeTurn;
    if (turn === null || turn.gianTurnId !== params.turnId) {
      throw new KimiProtocolError('TURN_NOT_FOUND', 'No active turn to steer; steering applies to a running turn only.');
    }
    const built = buildPromptInput(params.input);
    const promptId = `gian-${sha32(['steer', record.nativeSessionId, params.turnId, built])}`;
    // Registered before it is sent: Kimi may end the running native turn at
    // its next step boundary and run the steer as the next native turn, which
    // then belongs to this Gian turn.
    const conversation = record.conversationTurn;
    conversation?.addSteer(promptId);
    const withdraw = () => { if (record.conversationTurn === conversation) conversation?.dropSteer(promptId); };
    const submitted = await this.runtime.rest.request<{ status: 'running' | 'queued' | 'blocked' | 'failed' }>(
      'POST',
      `/api/v1/sessions/${encodeURIComponent(record.nativeSessionId)}/prompts`,
      { json: { content: conversationPromptContent(built), prompt_id: promptId,
        metadata: conversationInputMetadata(promptId, params.input),
        ...(built.skills.length > 0 ? { skills: built.skills } : {}) } },
    ).catch((error: unknown) => {
      if (error instanceof KimiApiError && error.code === 40927) {
        // Identical steer replay: the queued prompt already exists.
        return { status: 'queued' as const };
      }
      withdraw();
      throw error;
    });
    if (submitted.status !== 'queued') {
      withdraw();
      // The native loop was idle, so the steer would run as a turn of its
      // own that no Gian turn owns: withdraw it.
      if (submitted.status === 'running') await this.abortNativePrompt(record, promptId);
      throw new KimiProtocolError('SESSION_ERROR', 'The Kimi session has no active prompt to steer into.');
    }
    await this.runtime.rest.request<{ steered: boolean }>(
      'POST',
      `/api/v1/sessions/${encodeURIComponent(record.nativeSessionId)}/prompts:steer`,
      { json: { prompt_ids: [promptId] } },
    ).catch(async (error: unknown) => {
      // Not steered: the queued prompt would run as a turn of its own.
      await this.abortNativePrompt(record, promptId);
      withdraw();
      if (error instanceof KimiApiError && (error.code === 40402 || error.code === 40401)) {
        throw new KimiProtocolError('TURN_NOT_FOUND', 'The Kimi session has no active turn to steer into.');
      }
      throw error;
    });
    // No terminal of our own: the running turn keeps its identity and ends
    // through its own turn.ended event.
  }

  async interruptTurn(params: { sessionId: string; streamId: string; turnId: string }): Promise<void> {
    const record = this.requireStream(params.sessionId, params.streamId);
    const turn = record.activeTurn;
    if (turn === null || turn.gianTurnId !== params.turnId || !record.conversationTurn) {
      throw new KimiProtocolError('TURN_NOT_FOUND', `Turn ${params.turnId} is not active.`);
    }
    const active = record.conversationTurn;
    try { active.beginInterrupt(); } catch { throw new KimiProtocolError('CONFLICT', 'A Kimi interrupt is already being resolved.', true); }
    try {
      const result = await this.runtime.rest.request<{ aborted: boolean }>('POST',
        `/api/v1/sessions/${encodeURIComponent(record.nativeSessionId)}/prompts/${encodeURIComponent(turn.promptId)}:abort`, { json: {} });
      // A steer this turn owns may be the native turn that is running now.
      let aborted = result.aborted === true;
      for (const steerId of active.steerPromptIds()) {
        if (await this.abortNativePrompt(record, steerId)) aborted = true;
        if (record.conversationTurn === active) active.dropSteer(steerId);
      }
      if (record.conversationTurn !== active || record.activeTurn !== turn) {
        throw new KimiProtocolError('CONFLICT', 'Kimi continued while interruption was being acknowledged.', true);
      }
      active.finishInterrupt(aborted);
      if (!aborted) throw new KimiProtocolError('CONFLICT', 'Kimi did not confirm interruption; native work may still be running.', true);
      turn.interruptAccepted = true;
    } catch (error) {
      if (record.conversationTurn === active && record.activeTurn === turn) {
        try { active.finishInterrupt(false); } catch { /* already settled */ }
      }
      throw error;
    }
    if (active.isQueued() && !(await this.promptIsActive(record, turn.promptId))) {
      // The aborted prompt was still queued: no native turn will ever start.
      if (active.finishQueuedInterrupt(nowIso())) return;
    }
    this.armInterruptWatchdog(record, params.turnId);
  }

  /** Stop a leftover Kimi server (from a Proxy that was killed) that still
   *  holds this session's lock. Returns the pids stopped. */
  private async reclaimSessionLock(nativeSessionId: string): Promise<number[]> {
    const own = this.runtime.serverPid;
    return reclaimOrphanedKimiServers(resolveKimiCodeHome(process.env), {
      nativeSessionIds: [nativeSessionId],
      ...(own !== null ? { keep: [own] } : {}),
      debug: message => { process.stderr.write(`${message}\n`); },
    }).catch(() => []);
  }

  /** Stop the turn of a stream the Host no longer follows and release it. */
  private async abandonActiveTurn(record: SessionRecord): Promise<void> {
    const turn = record.activeTurn;
    if (turn === null) return;
    this.clearInterruptTimer(record.sessionId);
    await this.fenceActiveTurn(record, turn.gianTurnId, 'The Host re-attached this session and no longer follows this turn.');
    if (record.activeTurn?.gianTurnId !== turn.gianTurnId) return;
    // A fence or interrupt was already settling this turn: abort it here and
    // release it without waiting for a terminal nobody reads any more.
    await this.abortNativePrompt(record, turn.promptId);
    if (record.activeTurn?.gianTurnId === turn.gianTurnId) {
      this.onTurnFinalizedById(record.sessionId, turn.gianTurnId);
      record.conversationTurn = null;
    }
  }

  /** Native activity can lag an abort by a moment; wait for it briefly. */
  private async waitForNativeIdle(nativeSessionId: string): Promise<KimiSessionInfo> {
    const deadline = Date.now() + (this.options.rebindIdleWaitMs ?? REBIND_IDLE_WAIT_MS);
    for (;;) {
      const info = await this.readNativeSession(nativeSessionId);
      if (!nativeBusy(info) || Date.now() >= deadline) return info;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }

  private async promptIsActive(record: SessionRecord, promptId: string): Promise<boolean> {
    try {
      const prompts = await this.runtime.rest.request<{ active?: { prompt_id?: string } | null }>('GET',
        `/api/v1/sessions/${encodeURIComponent(record.nativeSessionId)}/prompts`, { timeoutMs: FENCE_ABORT_TIMEOUT_MS });
      return prompts.active?.prompt_id === promptId;
    } catch {
      return true; // Unknown: let the native terminal or the watchdog decide.
    }
  }

  private armInterruptWatchdog(record: SessionRecord, gianTurnId: string): void {
    this.clearInterruptTimer(record.sessionId);
    const timer = setTimeout(() => {
      this.interruptTimers.delete(record.sessionId);
      if (record.activeTurn !== null && record.activeTurn.gianTurnId === gianTurnId) {
        void this.fenceActiveTurn(
          record,
          gianTurnId,
          'The interrupted turn did not settle after the Kimi abort request.',
        );
      }
    }, INTERRUPT_SETTLE_MS);
    timer.unref();
    this.interruptTimers.set(record.sessionId, timer);
  }

  /** An abort request is only confirmed when the native response accepts it. */
  private async abortNativePrompt(record: SessionRecord, promptId: string): Promise<boolean> {
    try {
      const result = await this.runtime.rest.request<{ aborted: boolean }>(
        'POST',
        `/api/v1/sessions/${encodeURIComponent(record.nativeSessionId)}/prompts/${encodeURIComponent(promptId)}:abort`,
        { json: {}, timeoutMs: FENCE_ABORT_TIMEOUT_MS },
      );
      return result.aborted === true;
    } catch {
      return false;
    }
  }

  /** Fence one specific turn. The bounded abort wait can let that turn
   *  finalize and a fresh turn bind in the meantime, so the turn identity is
   *  re-verified after the wait: a fence never fails a turn it did not set
   *  out to fence. */
  private async fenceActiveTurn(record: SessionRecord, gianTurnId: string, message: string): Promise<void> {
    if (record.activeTurn?.gianTurnId !== gianTurnId || !record.conversationTurn) return;
    const conversation = record.conversationTurn;
    const promptId = record.activeTurn.promptId;
    if (!conversation.beginFence()) return;
    let aborted = await this.abortNativePrompt(record, promptId);
    for (const steerId of conversation.steerPromptIds()) {
      if (await this.abortNativePrompt(record, steerId)) aborted = true;
    }
    if (record.conversationTurn !== conversation || record.activeTurn?.gianTurnId !== gianTurnId) return;
    this.setState(record, 'stale');
    conversation.fail(`${message} ${aborted ? 'The native abort was accepted, but containment was not confirmed.'
      : 'The native abort was not confirmed; native work may still be running.'}`, true);
  }

  private clearInterruptTimer(sessionId: string): void {
    const timer = this.interruptTimers.get(sessionId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.interruptTimers.delete(sessionId);
    }
  }

  private clearReconnectWatchdog(sessionId: string): void {
    const timer = this.reconnectTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.reconnectTimers.delete(sessionId);
  }

  private armReconnectWatchdog(record: SessionRecord): void {
    this.clearReconnectWatchdog(record.sessionId);
    if (!record.activeTurn) return;
    const turnId = record.activeTurn.gianTurnId;
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(record.sessionId);
      if (record.conversationResyncPending && record.activeTurn?.gianTurnId === turnId) {
        void this.fenceActiveTurn(record, turnId, 'Kimi conversation could not be resynchronized after disconnect.');
      }
    }, 15_000);
    timer.unref(); this.reconnectTimers.set(record.sessionId, timer);
  }

  // ---- interactions ----

  async respondInteraction(params: {
    sessionId: string;
    streamId: string;
    turnId: string;
    interactionId: string;
    actionId: string;
    values: Record<string, unknown>;
  }): Promise<void> {
    const record = this.requireStream(params.sessionId, params.streamId);
    const turn = record.conversationTurn;
    if (!turn) throw new KimiProtocolError('INTERACTION_NOT_FOUND', `Interaction ${params.interactionId} is not pending.`);
    if (record.conversationResyncPending) throw new KimiProtocolError('SESSION_STALE', 'Kimi is resynchronizing the conversation.');
    if (record.activeTurn?.gianTurnId !== params.turnId) throw new KimiProtocolError('INTERACTION_NOT_FOUND', 'Interaction belongs to a different turn.');
    const kind = turn.pendingInteractionKind(params.interactionId);
    if (!kind) throw new KimiProtocolError('INTERACTION_NOT_FOUND', 'The Kimi interaction is not pending.');
    if (!(kind === 'approval' ? ['approved', 'rejected'] : ['accept', 'decline']).includes(params.actionId)) {
      throw new KimiProtocolError('INTERACTION_ACTION_NOT_FOUND', `Action ${params.actionId} was not advertised.`);
    }
    let request: { path: string; json: Record<string, unknown> };
    try { request = turn.response(params.interactionId, params.actionId, params.values); }
    catch (error) { throw new KimiProtocolError('INVALID_PARAMS', error instanceof Error ? error.message : 'Invalid Kimi interaction response.'); }
    try { await this.runtime.rest.request('POST', request.path, { json: request.json }); }
    catch (error) { turn.rejectResponse(params.interactionId); throw error; }
    turn.acknowledge(params.interactionId, params.actionId, nowIso());
    this.reconcileState(record);
    this.emitSessionUpdated(record);
  }

  // ---- fork & side chat ----

  /** Native turn number that ends the Gian turn named by `sourceTurnId`.
   *  2.7's `:fork` `turn_index` is that persisted turn number (agent-core
   *  sliceMainRecordsAtTurn matches the wire turnId, which the conversation
   *  feed exposes as `turn_number`), not a positional index. A Gian turn
   *  that spans background continuations forks after its last native turn. */
  private async forkTurnNumber(record: SessionRecord, sourceTurnId: string): Promise<number> {
    const last = record.lastCompleted;
    if (last !== null && last.promptId === sourceTurnId && last.nativeTurnId !== null) return last.nativeTurnId;
    let groups: ReturnType<typeof groupConversationTurns>;
    try {
      const turns = await fetchConversationHistory((path, query) => this.runtime.rest.request('GET', path, { query }), record.nativeSessionId);
      groups = groupConversationTurns(turns);
    } catch (error) {
      if (error instanceof KimiApiError || error instanceof KimiTransportError) throw error;
      throw new KimiProtocolError('FORK_BOUNDARY_UNAVAILABLE', 'Kimi history cannot identify the selected turn boundary.');
    }
    const group = groups.find(candidate => candidate.promptId === sourceTurnId);
    const numbers = (group?.turns ?? []).map(turn => turn.turn_number).filter((value): value is number => Number.isSafeInteger(value));
    if (!group || numbers.length !== group.turns.length || numbers.length === 0
      || group.turns.some(turn => turn.status !== 'ended')) {
      throw new KimiProtocolError('FORK_BOUNDARY_UNAVAILABLE', `Kimi has no completed native turn for ${sourceTurnId}.`);
    }
    return Math.max(...numbers);
  }

  private async nativeFork(record: SessionRecord, body: Record<string, unknown>): Promise<KimiSessionInfo> {
    return this.runtime.rest.request<KimiSessionInfo>(
      'POST', `/api/v1/sessions/${encodeURIComponent(record.nativeSessionId)}:fork`, { json: body },
    ).catch((error: unknown) => {
      if (error instanceof KimiApiError && (error.code === 40001 || error.code === 40930)) {
        throw new KimiProtocolError('FORK_BOUNDARY_UNAVAILABLE', `Kimi refused the fork boundary: ${error.message}`);
      }
      throw error;
    });
  }

  async forkSession(params: {
    sourceSessionId: string;
    sourceStreamId: string;
    sessionId: string;
    anchor: ForkAnchor;
  }): Promise<{ session: Record<string, unknown>; origin: Record<string, unknown> }> {
    const source = this.requireStream(params.sourceSessionId, params.sourceStreamId);
    if (source.activeTurn !== null) {
      throw new KimiProtocolError('SESSION_BUSY', 'Refusing to fork while a turn is active.');
    }
    if (params.anchor.type === 'head' && source.lastCompleted === null) {
      throw new KimiProtocolError('FORK_BOUNDARY_UNAVAILABLE', 'The source session has no completed turn to fork from.');
    }
    await this.ensureStarted();
    const origin = params.anchor.type === 'turn'
      ? { kind: 'fork', sessionId: params.sourceSessionId, turnId: params.anchor.turnId, sourceTurnId: params.anchor.sourceTurnId }
      : { kind: 'fork', sessionId: params.sourceSessionId, turnId: source.lastCompleted!.gianTurnId, sourceTurnId: source.lastCompleted!.promptId };
    const body = params.anchor.type === 'turn'
      ? { turn_index: await this.forkTurnNumber(source, params.anchor.sourceTurnId) }
      : {};
    const child = await this.nativeFork(source, body);
    const record = this.register({
      sessionId: params.sessionId,
      nativeSessionId: child.id,
      cwd: child.cwd ?? source.cwd,
      isSidechat: false,
      parentSessionId: source.sessionId,
    });
    await this.subscribeNative(record);
    return { session: this.snapshot(record), origin };
  }

  async createSidechat(params: {
    parentSessionId: string;
    parentStreamId: string;
    sidechatId: string;
  }): Promise<Record<string, unknown>> {
    const parent = this.requireStream(params.parentSessionId, params.parentStreamId);
    if (parent.activeTurn !== null) {
      throw new KimiProtocolError('SESSION_BUSY', 'Refusing to open a Side Chat while a turn is active.');
    }
    const anchor = parent.lastCompleted === null
      ? { type: 'empty' as const }
      : {
          type: 'turn' as const,
          turnId: parent.lastCompleted.gianTurnId,
          sourceTurnId: parent.lastCompleted.promptId,
        };
    await this.ensureStarted();
    const child = await this.nativeFork(parent, {
      metadata: { [PARENT_SESSION_ID_KEY]: parent.nativeSessionId, [CHILD_SESSION_KIND_KEY]: 'child' },
    });
    const record = this.register({
      sessionId: params.sidechatId,
      nativeSessionId: child.id,
      cwd: child.cwd ?? parent.cwd,
      isSidechat: true,
      parentSessionId: parent.sessionId,
    });
    await this.subscribeNative(record);
    const resumeRef = this.sidechatStore.seal({
      sidechatId: params.sidechatId,
      parentSessionId: params.parentSessionId,
      nativeSessionId: child.id,
      anchor,
      sessionConfig: {},
      createdAt: nowIso(),
    });
    return this.sidechatSnapshot(record, resumeRef.id, anchor);
  }

  async resumeSidechat(params: {
    sidechatId: string;
    parentSessionId: string;
    resumeRef: { id: string };
  }): Promise<Record<string, unknown>> {
    const tombstone = this.sidechatStore.closed(params.resumeRef.id);
    if (tombstone !== null) {
      throw new KimiProtocolError('SIDECHAT_UNAVAILABLE', 'This Side Chat was closed permanently.');
    }
    const payload = this.sidechatStore.open(params.resumeRef.id);
    if (payload === null) {
      throw new KimiProtocolError('SIDECHAT_UNAVAILABLE', 'The resume reference is not readable.');
    }
    const existing = this.records.get(params.sidechatId);
    if (existing !== undefined && existing.activeTurn !== null) {
      throw new KimiProtocolError('SESSION_BUSY', 'Cannot resume while the Side Chat turn is still settling.');
    }
    await this.ensureStarted();
    const info = await this.readNativeSession(payload.nativeSessionId);
    if (nativeBusy(info)) {
      throw new KimiProtocolError('SESSION_BUSY', 'The Side Chat native session is busy.');
    }
    if (existing !== undefined) this.dropRecord(existing);
    const record = this.register({
      sessionId: params.sidechatId,
      nativeSessionId: payload.nativeSessionId,
      cwd: info.cwd ?? '',
      isSidechat: true,
      parentSessionId: params.parentSessionId,
    });
    await this.subscribeNative(record);
    return this.sidechatSnapshot(record, params.resumeRef.id, payload.anchor);
  }

  async closeSidechat(params: { sidechatId: string; streamId?: string; resumeRef: { id: string } }): Promise<void> {
    const record = this.requireSession(params.sidechatId);
    if (record.isSidechat !== true) {
      throw new KimiProtocolError('SESSION_STALE', `${params.sidechatId} is not a Side Chat.`);
    }
    if (record.activeTurn !== null) {
      throw new KimiProtocolError('SESSION_BUSY', 'Cannot close while a turn is active.');
    }
    if (params.streamId !== undefined) this.requireStream(params.sidechatId, params.streamId);
    this.dropRecord(record);
    // Kimi's :delete permanence is not verified for child sessions; the
    // tombstone invalidates the resume ref and reports history honestly.
    this.sidechatStore.rememberClosed(params.resumeRef.id, {
      sidechatId: params.sidechatId,
      providerDataDeleted: false,
    });
  }

  private sidechatSnapshot(
    record: SessionRecord,
    resumeRefId: string,
    anchor: { type: 'empty' } | { type: 'turn' | 'activeInput'; turnId: string; sourceTurnId: string },
  ): Record<string, unknown> {
    return {
      id: record.sessionId,
      parentSessionId: record.parentSessionId ?? '',
      streamId: record.streamId,
      state: record.state === 'attaching' ? 'idle' : record.state,
      resumeRef: { id: resumeRefId },
      anchor,
      sessionConfig: {},
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  // ---- replay ----

  /** Full replay snapshot; the adapter owns cursor pagination over it. */
  async replay(params: {
    sessionId: string;
    streamId: string;
  }): Promise<{ replayStreamId: string; events: Array<Record<string, unknown>> }> {
    const record = this.requireStream(params.sessionId, params.streamId);
    const turns = await fetchConversationHistory((path, query) => this.runtime.rest.request('GET', path, { query }), record.nativeSessionId);
    const revision = sha32(turns);
    const replayStreamId = `replay:kimi:${record.nativeSessionId}:${revision}:v4`;
    let events: ReturnType<typeof buildConversationReplay>;
    try {
      events = buildConversationReplay({ sessionId: record.sessionId, nativeSessionId: record.nativeSessionId, replayStreamId, turns });
    } catch (error) {
      throw new KimiProtocolError('CAPABILITY_NOT_SUPPORTED', error instanceof Error ? error.message : 'Kimi history cannot be represented faithfully.');
    }
    return { replayStreamId, events: events as unknown as Array<Record<string, unknown>> };
  }

  async readOfficialQuota(params: import('@gian/proxy-protocol').OfficialQuotaReadParams) {
    const { queryKimiOfficialQuota } = await import('./official-quota.js');
    return queryKimiOfficialQuota(async path => {
      await this.ensureStarted();
      return this.runtime.rest.request('GET', path, { timeoutMs: 8_000 });
    }, params);
  }

  // ---- catalog facts ----

  async catalogFacts(): Promise<{ models: KimiModelInfo[]; defaultModel: string | null }> {
    await this.ensureStarted();
    const models = await this.runtime.rest.request<{ items: KimiModelInfo[] }>('GET', '/api/v1/models');
    let defaultModel: string | null = null;
    try {
      const config = await this.runtime.rest.request<{ default_model?: string }>('GET', '/api/v1/config');
      defaultModel = typeof config.default_model === 'string' && config.default_model !== '' ? config.default_model : null;
    } catch {
      defaultModel = null;
    }
    return { models: models.items, defaultModel };
  }

  // ---- customization ----

  async inspectCustomizations(params: {
    kind: import('@gian/proxy-protocol').CustomizationKind;
    cwd?: string;
  }): Promise<import('@gian/proxy-protocol').CustomizationListResult> {
    try {
      return await this.customization.list(params.kind, params.cwd ?? null);
    } catch (error) {
      if (error instanceof ScanTimeoutError) {
        return {
          kind: params.kind,
          status: 'unavailable',
          completeness: 'none',
          observedAt: nowIso(),
          items: [],
          truncated: false,
          diagnostics: [{
            code: 'PROVIDER_INSPECTION_FAILED',
            message: `Kimi ${params.kind} scan exceeded its inspection bound.`,
          }],
        };
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
          observedAt: nowIso(),
          text: '',
          truncated: false,
          diagnostics: [{ code: 'PROVIDER_INSPECTION_FAILED', message: 'Kimi detail scan exceeded its inspection bound.' }],
        };
      }
      throw error;
    }
  }

  // ---- shutdown ----

  async shutdown(): Promise<void> {
    this.stopped = true;
    for (const timer of this.interruptTimers.values()) clearTimeout(timer);
    this.interruptTimers.clear();
    for (const timer of this.reconnectTimers.values()) clearTimeout(timer);
    this.reconnectTimers.clear();
    await this.runtime.stop();
  }
}

/** Kimi transport/API errors → gian domain errors (shared with the adapter). */
export function normalizeKimiError(error: unknown): KimiProtocolError {
  if (error instanceof KimiProtocolError) return error;
  if (error instanceof KimiApiError) {
    const mapped = mapApiError(error.code);
    const details = { nativeCode: error.code, ...(error.httpStatus !== null ? { httpStatus: error.httpStatus } : {}) };
    return new KimiProtocolError(mapped.domain,
      mapped.domain === 'RUNTIME_AUTH_REQUIRED' ? kimiAuthRequiredMessage(error.message) : error.message,
      mapped.retryable, details);
  }
  if (error instanceof KimiTransportError) {
    return new KimiProtocolError('RUNTIME_ERROR', error.message, true);
  }
  return new KimiProtocolError('INTERNAL', error instanceof Error ? error.message : String(error));
}

function mapApiError(code: number): { domain: import('../transport/protocol.js').DomainCode; retryable: boolean } {
  switch (code) {
    case 40001:
    case 40002:
    case 40409:
    case 41301:
      return { domain: 'INVALID_PARAMS', retryable: false };
    case 40401:
      return { domain: 'SESSION_NOT_FOUND', retryable: false };
    case 40931: // Another native process holds this session's lock.
    case 40901:
      return { domain: 'SESSION_BUSY', retryable: false };
    case 40402:
      return { domain: 'TURN_NOT_FOUND', retryable: false };
    case 40404:
    case 40405:
    case 40902:
    case 40909:
    case 41001:
    case 41002:
      return { domain: 'INTERACTION_NOT_FOUND', retryable: false };
    case 40932: // Native undo reloaded newer history; require a fresh user decision.
    case 40927:
      return { domain: 'CONFLICT', retryable: false };
    case 40110: // AUTH_PROVISIONING_REQUIRED
    case 40111: // AUTH_TOKEN_MISSING
    case 40112: // AUTH_TOKEN_UNAUTHORIZED
    case 40113: // AUTH_MODEL_NOT_RESOLVED
      return { domain: 'RUNTIME_AUTH_REQUIRED', retryable: false };
    case 40926:
      return { domain: 'RUNTIME_ERROR', retryable: true };
    default:
      return { domain: 'RUNTIME_ERROR', retryable: false };
  }
}
