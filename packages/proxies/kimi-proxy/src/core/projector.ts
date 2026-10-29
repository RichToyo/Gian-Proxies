/**
 * Live event projection: Kimi `/api/v1/ws` session-event frames → gian
 * notifications, for ONE session.
 *
 * Identity rules:
 * - Durable-fact events (turn.started, activities, terminal) derive their
 *   eventId from stable native identities (prompt_id, tool_call_id), so live
 *   and replay projections of the same fact share one identity.
 * - Kimi Code 2.1.1 volatile frames reuse the current durable journal seq
 *   and are not replayed. They must not advance `lastSeq`. `assistant.delta`
 *   and `thinking.delta` carry `offset` (length before append; reset when
 *   `turn.step.started` begins the next step).
 * - Assistant text and thinking each get a content id per step
 *   (`assistant:<promptId>:<step>` / `thinking:<promptId>:<step>`). Text stays
 *   kind `text`, so the host renders it as a message outside the Working
 *   basket. Thinking stays kind `reasoning` and remains inside that basket.
 * - A content.delta eventId includes the prompt, the step, the offset, and
 *   the delta: identical text at the same position in two turns stays
 *   distinct, frames that share a seq stay distinct, and an identical
 *   redelivery stays idempotent.
 * - Durable frames at or before the last delivered durable seq are dropped,
 *   so cursor-based reconnect replays stay idempotent. A volatile frame is
 *   dropped only when its seq is strictly older than that watermark.
 *
 * Main-agent filtering: only `agentId === "main"` frames project as turn
 * content/tools; subagent work arrives via the dedicated `subagent.*` /
 * `task.*` lifecycle frames and becomes agent activities.
 * Main-agent consumption is only `usage.total` from `agent.status.updated`.
 * In pinned Kimi Code 2.2.0 that total is the agent-space sum of durable
 * `usage.record` rows. `currentTurn` resets per native turn, and
 * `contextTokens` is occupancy. Neither is consumption.
 */

import { createHash } from 'node:crypto';

import { terminalEventIdFor } from './replay.js';
import type { KimiToolDisplay } from './types.js';

export interface OuterNotification {
  method: string;
  params: Record<string, unknown>;
}

/** One `/api/v1/ws` session-event frame. `volatile` and `offset` are envelope
 *  fields on Kimi Code 2.1.1, not payload fields. */
export interface KimiProjectedFrame {
  type: string;
  seq: number;
  volatile?: boolean;
  offset?: number;
  payload: Record<string, unknown>;
}

export interface KimiErrorLike {
  code?: string | undefined;
  message?: string | undefined;
  retryable?: boolean | undefined;
}

export interface KimiWorkSnapshot {
  lastSeq: number;
  busy: boolean;
  mainTurnActive: boolean;
  pendingInteraction: 'none' | 'approval' | 'question';
  tasks: Array<{ id: string; status: 'running' | 'completed' | 'failed' | 'cancelled' }>;
  questions: string[];
  approvals: string[];
}

export interface ProjectorServices {
  gianSessionId: string;
  nativeSessionId: string;
  nextSequence: () => number;
  emit: (notification: OuterNotification) => void;
  /** Called after every terminal finalization completes. */
  onFinalized?: (gianTurnId: string) => void;
  /** Turn-start buffer overflowed: the service must fence the turn (stop the
   *  native prompt, then fail it); a bare local failure would leave native
   *  work running unattributed. */
  onBindingOverflow?: (gianTurnId: string) => void;
  /** Async terminal hooks; failures skip the facet honestly (never fake). */
  /** Compatibility seam for fixtures. Never queried: plain session metadata
   * returns placeholder zeros, not a second authoritative usage counter. */
  finalUsage?: () => Promise<Record<string, unknown> | null>;
  fileDiff: (nativeTurnId: number) => Promise<{ diff: string; truncated: boolean; files: Array<Record<string, unknown>> } | null>;
  /** Read-only fallback when native work-state or task terminal events are missing. */
  reconcileWork?: (needs: { tasks: boolean; questions: boolean; approvals: boolean }) => Promise<KimiWorkSnapshot | null>;
  /** Deterministic fixture override; production uses the bounded default. */
  reconcileIntervalMs?: number;
}

function sha16(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

const PLAN_STATUS_MAP: Record<string, string> = {
  pending: 'pending',
  in_progress: 'in_progress',
  done: 'completed',
};

/** Hard cap on the optional terminal facets (final usage, file diff): they
 *  may enrich the terminal, never delay it beyond this budget. */
const FINAL_FACET_BUDGET_MS = 10_000;
/** Frames buffered between prompt submission and turn binding. */
const BINDING_BUFFER_LIMIT = 4_096;
const RECONCILE_BASE_MS = 5_000;
const RECONCILE_MAX_MS = 60_000;
const RECONCILE_FAILURE_LIMIT = 3;

interface ActiveTurn {
  gianTurnId: string;
  promptId: string;
  nativePromptId: string | null;
  nativeTurnId: number | null;
  nativeTurnIds: Set<number>;
  nativePromptIds: Set<string>;
  interruptAccepted: boolean;
}

interface OpenActivity {
  name: string;
  input: unknown;
  title?: string;
  presentation?: { type: string; data: Record<string, unknown> };
}

interface OpenContent {
  kind: 'text' | 'reasoning';
  text: string;
  /** Length of this step's text, matching the server offset cursor. */
  stepLength: number;
}

export interface PendingInteractionState {
  interactionId: string;
  kind: 'approval' | 'question';
  nativeId: string;
  turnId: string;
  toolCallId?: string;
  /** Question input ids/types at projection time; respondInteraction needs
   *  them to wrap raw UI values into the native kind-discriminated answers. */
  inputs?: Array<{ id: string; type: string }>;
}

export class KimiSessionProjector {
  private streamId = '';
  /** Last durable journal seq. Volatile frames reuse this value and must not move it. */
  private lastSeq = -1;
  /** Bumps on each main-agent `turn.step.started`. Each step owns its content ids. */
  private contentStep = 0;
  /** Identity for text deltas that arrive without an offset. */
  private unoffsetDelta = 0;
  private activeTurn: ActiveTurn | null = null;
  private stateRevision = 0;
  private nativeBusy: boolean | null = null;
  private idleSignalRequired = false;
  private acceptingNativeTurn = false;
  private nativeTurnGeneration = 0;
  private pendingEnd: { turn: ActiveTurn; reason: string } | null = null;
  private finalization: { turn: ActiveTurn; reason: string; resumable: boolean } | null = null;
  private endTimer: NodeJS.Timeout | null = null;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private reconciling = false;
  private reconcileFailures = 0;
  private reconcilePaused = false;
  private reconcileNoticeSent = false;
  private readonly baseReconcileMs: number;
  private reconcileDelayMs: number;
  private readonly taskOwners = new Map<string, string>();
  private readonly subagentOwners = new Map<string, string>();
  private readonly toolOwners = new Map<string, string>();
  private readonly ambiguousToolIds = new Set<string>();
  private readonly taskStates = new Map<string, 'running' | 'ended'>();
  private readonly taskInfo = new Map<string, Record<string, unknown>>();
  private readonly subagentStates = new Map<string, 'running' | 'suspended' | 'ended'>();
  private readonly ownedToolCalls = new Set<string>();
  private readonly toolActivities = new Map<string, string>();
  private readonly lastToolActivity = new Map<string, string>();
  private readonly toolStates = new Map<string, 'running' | 'ended'>();
  private readonly seenToolIds = new Set<string>();
  private readonly subagentParents = new Map<string, string>();
  private readonly openContent = new Map<string, OpenContent>();
  private readonly openActivities = new Map<string, OpenActivity>();
  readonly pendingInteractions = new Map<string, PendingInteractionState>();
  private lastPlanFingerprint: string | null = null;
  private lastUsageFingerprint: string | null = null;
  private lastError: KimiErrorLike | null = null;
  private terminalSent = false;
  private interruptPending = false;
  private fencePending = false;
  /** Set by failTurn while a finalization is already running: the optional
   *  REST facets are skipped so the terminal goes out immediately. */
  private facetsAborted = false;
  /** Turn-start binding window: frames that beat the prompt-submission
   *  response are buffered and flushed by bindTurn, never projected blind. */
  private binding = false;
  private bufferedFrames: KimiProjectedFrame[] = [];
  private bindingOverflowed = false;

  constructor(private readonly services: ProjectorServices) {
    const interval = services.reconcileIntervalMs;
    this.baseReconcileMs = typeof interval === 'number' && Number.isFinite(interval) && interval > 0
      ? interval : RECONCILE_BASE_MS;
    this.reconcileDelayMs = this.baseReconcileMs;
  }

  setStreamId(streamId: string): void {
    this.streamId = streamId;
  }

  /** Open the turn-start window. Until bindTurn or discardBinding, incoming
   *  frames are buffered in arrival order instead of being dropped for lack
   *  of an active turn. */
  beginBinding(): void {
    this.binding = true;
    this.bufferedFrames = [];
    this.bindingOverflowed = false;
  }

  discardBinding(): void {
    this.binding = false;
    this.bufferedFrames = [];
    this.bindingOverflowed = false;
  }

  bindTurn(turn: { gianTurnId: string; promptId: string }): void {
    this.stateRevision += 1;
    this.clearEndTimer();
    this.clearReconcileTimer();
    this.pendingEnd = null;
    this.finalization = null;
    this.nativeBusy = null;
    this.idleSignalRequired = false;
    this.acceptingNativeTurn = true;
    this.nativeTurnGeneration = 0;
    this.taskStates.clear();
    this.taskInfo.clear();
    this.subagentStates.clear();
    this.ownedToolCalls.clear();
    this.toolActivities.clear();
    this.lastToolActivity.clear();
    this.toolStates.clear();
    this.seenToolIds.clear();
    this.subagentParents.clear();
    this.openContent.clear();
    this.openActivities.clear();
    this.pendingInteractions.clear();
    this.activeTurn = {
      gianTurnId: turn.gianTurnId, promptId: turn.promptId, nativePromptId: turn.promptId,
      nativeTurnId: null, nativeTurnIds: new Set(), nativePromptIds: new Set([turn.promptId]),
      interruptAccepted: false,
    };
    this.terminalSent = false;
    this.interruptPending = false;
    this.fencePending = false;
    this.reconcileFailures = 0;
    this.reconcilePaused = false;
    this.reconcileNoticeSent = false;
    this.reconcileDelayMs = this.baseReconcileMs;
    this.lastError = null;
    this.lastUsageFingerprint = null;
    this.lastPlanFingerprint = null;
    this.contentStep = 0;
    this.unoffsetDelta = 0;
    this.facetsAborted = false;
    const buffered = this.bufferedFrames;
    const overflowed = this.bindingOverflowed;
    this.binding = false;
    this.bufferedFrames = [];
    this.bindingOverflowed = false;
    for (const frame of buffered) this.handleFrame(frame);
    if (overflowed) {
      // Fencing belongs to the service: it stops the native prompt before
      // failing the turn, so no native work keeps running unattributed.
      const onOverflow = this.services.onBindingOverflow;
      if (onOverflow !== undefined) {
        onOverflow(turn.gianTurnId);
      } else {
        void this.failTurn(
          'The Kimi event stream overflowed the turn-start buffer; the turn could not be projected completely.',
          true,
        );
      }
    }
  }

  beginInterrupt(gianTurnId: string): number | null {
    if (this.activeTurn?.gianTurnId !== gianTurnId || this.interruptPending) return null;
    this.interruptPending = true;
    this.stateRevision += 1;
    return this.nativeTurnGeneration;
  }

  finishInterrupt(gianTurnId: string, generation: number, accepted: boolean): boolean {
    if (this.activeTurn?.gianTurnId !== gianTurnId) return false;
    const sameNativeTurn = generation === this.nativeTurnGeneration;
    if (accepted && sameNativeTurn) this.activeTurn.interruptAccepted = true;
    this.interruptPending = false;
    this.stateRevision += 1;
    this.scheduleEnd();
    return sameNativeTurn;
  }

  beginFence(gianTurnId: string): boolean {
    if (this.activeTurn?.gianTurnId !== gianTurnId || this.fencePending) return false;
    this.resumeIdleFinalization();
    this.fencePending = true;
    this.stateRevision += 1;
    return true;
  }

  endFence(gianTurnId: string, resume: boolean): void {
    if (this.activeTurn?.gianTurnId !== gianTurnId) return;
    this.fencePending = false;
    this.stateRevision += 1;
    if (resume) this.scheduleEnd();
  }

  hasActiveTurn(): boolean {
    return this.activeTurn !== null;
  }

  activePromptId(): string | null {
    return this.activeTurn?.nativePromptId ?? null;
  }

  activeGianTurnId(): string | null {
    return this.activeTurn?.gianTurnId ?? null;
  }

  activeNativeGeneration(): number | null {
    return this.activeTurn === null ? null : this.nativeTurnGeneration;
  }

  /** Claim resolution through REST. A native WS resolution may already
   *  have won; only the caller that removes pending emits a terminal fact. */
  resolveInteraction(interactionId: string, questionOutcome: 'succeeded' | 'cancelled' = 'succeeded'): boolean {
    const pending = this.pendingInteractions.get(interactionId);
    const removed = this.pendingInteractions.delete(interactionId);
    if (removed) {
      this.stateRevision += 1;
      this.resetReconciliation();
      this.invalidateIdleSignal();
      if (pending?.kind === 'question') this.settleQuestionTask(pending, questionOutcome);
      this.scheduleEnd();
    }
    return removed;
  }

  private toolActivityId(toolCallId: string, turn: ActiveTurn): string {
    const key = `${turn.nativeTurnId}\0${toolCallId}`;
    const existing = this.toolActivities.get(key);
    if (existing !== undefined) return existing;
    const reused = this.seenToolIds.has(toolCallId);
    if (reused) this.ambiguousToolIds.add(toolCallId);
    const id = reused ? `native:${turn.nativeTurnId}:${toolCallId}` : toolCallId;
    this.seenToolIds.add(toolCallId);
    this.toolActivities.set(key, id);
    return id;
  }

  private invalidateIdleSignal(): void {
    if (this.nativeBusy === false) {
      this.nativeBusy = null;
      this.idleSignalRequired = true;
    }
  }

  private resetReconciliation(): void {
    this.reconcileFailures = 0;
    this.reconcilePaused = false;
    this.reconcileDelayMs = this.baseReconcileMs;
  }

  private resumeIdleFinalization(): void {
    const attempt = this.finalization;
    if (attempt === null || !attempt.resumable || this.activeTurn !== attempt.turn) return;
    this.finalization = null;
    this.pendingEnd = { turn: attempt.turn, reason: attempt.reason };
    this.nativeBusy = true;
    this.idleSignalRequired = false;
    this.facetsAborted = false;
  }

  private frameParams(source: unknown, turn: ActiveTurn | null): Record<string, unknown> {
    return {
      // Native activity/plan identifiers can repeat in a later turn. A live
      // fact belongs to its native prompt, not just to the whole session.
      eventId: `evt-${sha16(turn === null
        ? [this.services.nativeSessionId, source]
        : [this.services.nativeSessionId, turn.promptId, source])}`,
      sessionId: this.services.gianSessionId,
      streamId: this.streamId,
      sequence: this.services.nextSequence(),
      emittedAt: new Date().toISOString(),
      ...(turn !== null ? { turnId: turn.gianTurnId, sourceTurnId: turn.promptId } : {}),
    };
  }

  private emitTurn(method: string, source: unknown, data: Record<string, unknown>, turn: ActiveTurn | null): void {
    const params = this.frameParams(source, turn);
    params.data = data;
    this.services.emit({ method, params });
  }

  /** Feed one wire frame. Returns false when the seq guard drops it. */
  handleFrame(frame: KimiProjectedFrame): boolean {
    if (this.binding) {
      if (this.bufferedFrames.length >= BINDING_BUFFER_LIMIT) {
        this.bindingOverflowed = true;
        return true;
      }
      this.bufferedFrames.push(frame);
      return true;
    }
    if (frame.volatile === true) {
      if (frame.seq < this.lastSeq) return false;
    } else {
      if (frame.seq <= this.lastSeq) return false;
      this.lastSeq = frame.seq;
    }
    this.stateRevision += 1;
    const payload = frame.payload;
    const agentId = typeof payload.agentId === 'string' ? payload.agentId : 'main';
    const turn = this.activeTurn;
    if (frame.type === 'event.session.work_changed') {
      if (turn !== null && !this.terminalSent && typeof payload.busy === 'boolean') {
        if (payload.busy || payload.main_turn_active === true
          || payload.pending_interaction === 'approval' || payload.pending_interaction === 'question') {
          this.resumeIdleFinalization();
        }
        this.nativeBusy = payload.busy || payload.main_turn_active === true
          || payload.pending_interaction === 'approval' || payload.pending_interaction === 'question';
        this.idleSignalRequired = false;
        this.resetReconciliation();
        this.scheduleEnd();
      }
      return true;
    }
    // Session usage remains meaningful without an active turn, but no other
    // turn-scoped event may outlive the binding that owns it.
    if ((turn === null || this.terminalSent) && frame.type !== 'agent.status.updated') return true;
    const nativeTurnId = typeof payload.turnId === 'number' ? payload.turnId
      : typeof payload.turn_id === 'number' ? payload.turn_id : null;
    const nativePromptId = typeof payload.promptId === 'string' ? payload.promptId
      : typeof payload.prompt_id === 'string' ? payload.prompt_id : null;
    const lifecycle = /^(subagent\.|task\.|background\.task\.)/.test(frame.type);
    const interaction = /^event\.(approval|question)\./.test(frame.type);
    if (turn !== null && !this.terminalSent && frame.type !== 'turn.started') {
      if (lifecycle) {
        if (agentId !== 'main' && this.subagentOwners.get(agentId) !== turn.gianTurnId) return true;
        if (nativeTurnId !== null && !turn.nativeTurnIds.has(nativeTurnId)) return true;
      } else if (interaction) {
        if (nativeTurnId !== null && !turn.nativeTurnIds.has(nativeTurnId)) return true;
        const toolCallId = typeof payload.tool_call_id === 'string' ? payload.tool_call_id : null;
        if (toolCallId !== null && toolCallId !== '' && !this.ownedToolCalls.has(toolCallId)
          && nativeTurnId === null && (nativePromptId === null || !turn.nativePromptIds.has(nativePromptId))) return true;
        const approvalId = typeof payload.approval_id === 'string' ? `apr:${payload.approval_id}` : '';
        const questionId = typeof payload.question_id === 'string' ? `q:${payload.question_id}` : '';
        if (!this.acceptingNativeTurn && !this.pendingInteractions.has(approvalId)
          && !this.pendingInteractions.has(questionId)) return true;
      } else if (frame.type !== 'agent.status.updated') {
        if (!this.acceptingNativeTurn) return true;
        if (nativeTurnId !== null && turn.nativeTurnId !== null && nativeTurnId !== turn.nativeTurnId) return true;
        if (nativePromptId !== null && !turn.nativePromptIds.has(nativePromptId)) return true;
        if (nativeTurnId === null && nativePromptId !== null && this.nativeTurnGeneration > 0
          && nativePromptId !== turn.nativePromptId) return true;
      }
    }

    switch (frame.type) {
      case 'turn.started': {
        if (agentId !== 'main' || turn === null) return true;
        const origin = payload.origin as { kind?: unknown; taskId?: unknown } | undefined;
        if (origin?.kind === 'task') {
          const taskId = typeof origin.taskId === 'string' ? origin.taskId : '';
          if (this.taskOwners.get(taskId) !== turn.gianTurnId && this.subagentOwners.get(taskId) !== turn.gianTurnId) {
            this.acceptingNativeTurn = false;
            return true;
          }
          this.resumeIdleFinalization();
          this.clearEndTimer();
          this.clearReconcileTimer();
          this.pendingEnd = null;
          this.nativeBusy = true;
          this.idleSignalRequired = false;
          this.nativeTurnGeneration += 1;
          this.lastError = null;
          this.contentStep += 1;
          turn.nativePromptId = nativePromptId;
          if (nativePromptId !== null) turn.nativePromptIds.add(nativePromptId);
        } else if ((!this.acceptingNativeTurn && nativePromptId === null)
          || (nativePromptId !== null && nativePromptId !== turn.promptId)
          || (turn.nativeTurnId !== null && nativeTurnId !== null && nativeTurnId !== turn.nativeTurnId)) {
          this.acceptingNativeTurn = false;
          return true;
        } else {
          turn.nativePromptId = nativePromptId ?? turn.promptId;
        }
        this.acceptingNativeTurn = true;
        if (nativeTurnId !== null) {
          turn.nativeTurnId = nativeTurnId;
          turn.nativeTurnIds.add(nativeTurnId);
        }
        return true;
      }
      case 'turn.step.started': {
        if (agentId !== 'main') return true;
        this.resumeIdleFinalization();
        this.contentStep += 1;
        return true;
      }
      case 'assistant.delta':
      case 'thinking.delta': {
        if (agentId !== 'main' || turn === null) return true;
        const kind = frame.type === 'assistant.delta' ? 'text' as const : 'reasoning' as const;
        const contentId = `${kind === 'text' ? 'assistant' : 'thinking'}:${turn.promptId}:${this.contentStep}`;
        const delta = typeof payload.delta === 'string' ? payload.delta : '';
        const open = this.openContent.get(contentId) ?? { kind, text: '', stepLength: 0 };
        const offset = typeof frame.offset === 'number' && Number.isFinite(frame.offset) ? frame.offset : null;
        if (offset !== null) {
          if (offset < open.stepLength) return true;
          if (offset > open.stepLength) open.stepLength = offset;
        }
        if (delta !== '') this.resumeIdleFinalization();
        this.openContent.set(contentId, open);
        if (delta === '') return true;
        const position = offset ?? this.unoffsetDelta++;
        open.text += delta;
        open.stepLength += delta.length;
        this.emitTurn('content.delta', [frame.type, turn.promptId, this.contentStep, position, delta], { contentId, kind, delta }, turn);
        return true;
      }
      case 'tool.call.started': {
        if (agentId !== 'main' || turn === null) return true;
        const toolCallId = typeof payload.toolCallId === 'string' ? payload.toolCallId : '';
        if (toolCallId === '') return true;
        const toolKey = `${turn.nativeTurnId}\0${toolCallId}`;
        if (this.toolStates.has(toolKey)) return true;
        this.resumeIdleFinalization();
        this.toolStates.set(toolKey, 'running');
        const previousOwner = this.toolOwners.get(toolCallId);
        if (previousOwner !== undefined && previousOwner !== turn.gianTurnId) this.ambiguousToolIds.add(toolCallId);
        this.toolOwners.set(toolCallId, turn.gianTurnId);
        this.ownedToolCalls.add(toolCallId);
        const activityId = this.toolActivityId(toolCallId, turn);
        this.lastToolActivity.set(toolCallId, activityId);
        const name = typeof payload.name === 'string' ? payload.name : 'tool';
        const display = (payload.display ?? undefined) as KimiToolDisplay | undefined;
        if (display?.kind === 'todo_list' && Array.isArray(display.items)) {
          this.emitPlan(activityId, display.items);
        } else if (display?.kind === 'plan_review' && typeof display.plan === 'string') {
          this.emitPlanReview(activityId, display);
        }
        const projected = projectToolCall(name, display, payload.args);
        this.openActivities.set(activityId, {
          name,
          input: payload.args,
          title: projected.title,
          presentation: projected.presentation,
        });
        this.emitTurn('activity.updated', [activityId, 'activity:running'], {
          activityId,
          kind: `tool:${name}`,
          title: projected.title,
          status: 'running',
          presentation: projected.presentation,
          ...(display !== undefined ? { details: { display } } : {}),
        }, turn);
        return true;
      }
      case 'tool.result': {
        if (agentId !== 'main' || turn === null) return true;
        const toolCallId = typeof payload.toolCallId === 'string' ? payload.toolCallId : '';
        if (toolCallId === '') return true;
        if (nativeTurnId === null && nativePromptId === null && this.ambiguousToolIds.has(toolCallId)) return true;
        const toolKey = `${turn.nativeTurnId}\0${toolCallId}`;
        if (this.toolStates.get(toolKey) !== 'running') return true;
        const activityId = this.toolActivities.get(toolKey);
        if (activityId === undefined) return true;
        const open = this.openActivities.get(activityId);
        if (open === undefined) return true;
        this.resumeIdleFinalization();
        this.toolStates.set(toolKey, 'ended');
        const name = open.name;
        this.openActivities.delete(activityId);
        const presentation = open.presentation ?? projectToolCall(name, undefined, open.input).presentation;
        const data: Record<string, unknown> = { ...presentation.data, output: payload.output ?? null };
        this.emitTurn('activity.updated', [activityId, 'activity:terminal'], {
          activityId,
          kind: `tool:${name}`,
          title: open.title ?? name,
          status: payload.isError === true ? 'failed' : 'succeeded',
          ...(typeof payload.output === 'string' ? { summary: payload.output } : {}),
          presentation: { type: presentation.type, data },
        }, turn);
        return true;
      }
      case 'agent.status.updated': {
        if (agentId !== 'main') return true;
        const usage = (payload.usage ?? null) as Record<string, unknown> | null;
        const rawTotal: unknown = usage?.total;
        if (rawTotal === null || rawTotal === undefined || typeof rawTotal !== 'object') return true;
        const fingerprint = JSON.stringify(rawTotal);
        if (fingerprint === this.lastUsageFingerprint) return true;
        this.lastUsageFingerprint = fingerprint;
        const conversation = projectKimiCumulativeUsage(rawTotal);
        if (conversation) {
          const usageTurn = this.terminalSent || !this.acceptingNativeTurn ? null : turn;
          this.emitTurn('usage.updated', ['usage', usageTurn?.promptId ?? '', fingerprint], {
            conversation,
          }, usageTurn);
        }
        return true;
      }
      case 'subagent.spawned':
      case 'subagent.started': {
        if (frame.type === 'subagent.started' && this.openActivities.has(String(payload.subagentId ?? ''))) return true;
        this.emitSubagent(frame, payload, 'running');
        return true;
      }
      case 'subagent.completed': {
        this.emitSubagent(frame, payload, 'succeeded');
        return true;
      }
      case 'subagent.failed': {
        this.emitSubagent(frame, payload, 'failed');
        return true;
      }
      case 'subagent.cancelled':
      case 'subagent.suspended': {
        this.emitSubagent(frame, payload, 'cancelled');
        return true;
      }
      case 'task.started':
      case 'background.task.started': {
        const info = (payload.info ?? {}) as Record<string, unknown>;
        this.emitTask(frame, info, 'running');
        return true;
      }
      case 'task.terminated':
      case 'background.task.terminated': {
        const info = (payload.info ?? {}) as Record<string, unknown>;
        const status = typeof info.status === 'string' ? info.status : 'completed';
        this.emitTask(frame, info, status === 'completed' ? 'succeeded' : status === 'failed' || status === 'timed_out' ? 'failed' : 'cancelled');
        return true;
      }
      case 'event.approval.requested': {
        const approvalId = typeof payload.approval_id === 'string' ? payload.approval_id : '';
        if (approvalId === '' || turn === null) return true;
        const interactionId = `apr:${approvalId}`;
        if (this.pendingInteractions.has(interactionId)) return true;
        this.resumeIdleFinalization();
        this.pendingInteractions.set(interactionId, {
          interactionId,
          kind: 'approval',
          nativeId: approvalId,
          turnId: turn.gianTurnId,
        });
        this.emitTurn('interaction.requested', [approvalId, 'interaction.requested'], {
          interactionId,
          title: typeof payload.tool_name === 'string' ? payload.tool_name : 'Permission required',
          ...(typeof payload.action === 'string' ? { description: `Kimi requests: ${payload.action}` } : {}),
          presentation: { kind: 'permission', tone: 'warning' },
          inputs: [],
          actions: [
            { id: 'approved', label: 'Allow', style: 'primary' },
            { id: 'rejected', label: 'Deny', style: 'danger' },
          ],
          context: {
            approvalId,
            toolName: payload.tool_name ?? '',
            ...(payload.tool_input_display !== undefined ? { input: payload.tool_input_display } : {}),
            ...(typeof payload.expires_at === 'string' ? { expiresAt: payload.expires_at } : {}),
          },
        }, turn);
        return true;
      }
      case 'event.approval.resolved': {
        const approvalId = typeof payload.approval_id === 'string' ? payload.approval_id : '';
        const interactionId = `apr:${approvalId}`;
        if (approvalId === '' || !this.pendingInteractions.delete(interactionId)) return true;
        this.resetReconciliation();
        this.invalidateIdleSignal();
        // Resolved elsewhere (expired/another client): report honestly.
        this.emitTurn('interaction.resolved', [approvalId, 'interaction.resolved:external'], {
          interactionId,
          outcome: 'cancelled',
        }, turn);
        this.scheduleEnd();
        return true;
      }
      case 'event.question.requested': {
        const questionId = typeof payload.question_id === 'string' ? payload.question_id : '';
        if (questionId === '' || turn === null) return true;
        const interactionId = `q:${questionId}`;
        if (this.pendingInteractions.has(interactionId)) return true;
        const questions = Array.isArray(payload.questions) ? payload.questions as Array<Record<string, unknown>> : [];
        if (questions.length === 0) return true;
        this.resumeIdleFinalization();
        const inputs = questions.map((question, index) => {
          const options = Array.isArray(question.options) ? question.options as Array<Record<string, unknown>> : [];
          // Interaction choices have only value/displayName in the shared
          // protocol. Preserve native option help in the input description.
          const descriptions = options
            .filter((option) => typeof option.description === 'string' && option.description !== '')
            .map((option) => `${typeof option.label === 'string' ? option.label : String(option.id)}: ${String(option.description)}`);
          if (question.allow_other === true) descriptions.push('You may provide your own answer in the note field.');
          return {
            id: typeof question.id === 'string' ? question.id : `q_${index}`,
            type: question.multi_select === true ? 'multi_select' : 'single_select',
            label: typeof question.question === 'string' ? question.question : `Question ${index + 1}`,
            required: true,
            ...(options.length > 0
              ? {
                  choices: options
                    .filter((option) => typeof option.id === 'string')
                    .map((option) => ({
                      value: option.id as string,
                      displayName: typeof option.label === 'string' ? option.label : option.id as string,
                    })),
                }
              : {}),
            ...(descriptions.length > 0 ? { description: descriptions.join('\n') } : {}),
          };
        });
        this.pendingInteractions.set(interactionId, {
          interactionId,
          kind: 'question',
          nativeId: questionId,
          turnId: turn.gianTurnId,
          ...(typeof payload.tool_call_id === 'string' && payload.tool_call_id !== ''
            ? { toolCallId: payload.tool_call_id } : {}),
          inputs: inputs.map((input) => ({ id: input.id, type: input.type })),
        });
        this.emitTurn('interaction.requested', [questionId, 'interaction.requested'], {
          interactionId,
          title: 'Question',
          presentation: { kind: 'questions', tone: 'info' },
          inputs,
          actions: [
            { id: 'accept', label: 'Submit', style: 'primary' },
            { id: 'decline', label: 'Dismiss', style: 'danger' },
          ],
          context: { questionId, 'gian.cancelInputOptionalActions': ['decline'] },
        }, turn);
        return true;
      }
      case 'event.question.answered':
      case 'event.question.dismissed': {
        const questionId = typeof payload.question_id === 'string' ? payload.question_id : '';
        const interactionId = `q:${questionId}`;
        const pending = this.pendingInteractions.get(interactionId);
        if (questionId === '' || !this.pendingInteractions.delete(interactionId)) return true;
        this.resetReconciliation();
        this.invalidateIdleSignal();
        if (pending !== undefined) {
          this.settleQuestionTask(pending, frame.type === 'event.question.answered' ? 'succeeded' : 'cancelled');
        }
        this.emitTurn('interaction.resolved', [questionId, 'interaction.resolved:external'], {
          interactionId,
          outcome: 'cancelled',
        }, turn);
        this.scheduleEnd();
        return true;
      }
      case 'prompt.steered': {
        if (agentId !== 'main' || turn === null) return true;
        this.emitTurn('activity.updated', [frame.seq, 'steer'], {
          activityId: `steer-${sha16([frame.seq])}`.slice(0, 24),
          kind: 'kimi:turn-steer',
          title: 'Steer delivered',
          status: 'succeeded',
          presentation: { type: 'notice', data: { message: 'The queued input was steered into the running turn.' } },
        }, turn);
        return true;
      }
      case 'skill.activated': {
        if (agentId !== 'main' || turn === null) return true;
        this.emitTurn('activity.updated', [frame.seq, 'skill'], {
          activityId: `skill-${sha16([frame.seq])}`.slice(0, 24),
          kind: 'kimi:skill-activation',
          title: `Skill activated: ${String(payload.skillName ?? 'unknown')}`,
          status: 'succeeded',
          presentation: {
            type: 'notice',
            data: { message: `Kimi activated the skill "${String(payload.skillName ?? 'unknown')}".` },
          },
        }, turn);
        return true;
      }
      case 'error': {
        if (agentId !== 'main') return true;
        this.lastError = {
          code: typeof payload.code === 'string' ? payload.code : undefined,
          message: typeof payload.message === 'string' ? payload.message : undefined,
          retryable: payload.retryable === true,
        };
        return true;
      }
      case 'turn.ended': {
        if (agentId !== 'main' || turn === null) return true;
        if (turn.nativeTurnId === null && nativeTurnId !== null) {
          turn.nativeTurnId = nativeTurnId;
          turn.nativeTurnIds.add(nativeTurnId);
        }
        turn.nativePromptId = null;
        const reason = typeof payload.reason === 'string' ? payload.reason : 'completed';
        if (payload.error !== undefined && payload.error !== null) {
          const error = payload.error as KimiErrorLike;
          this.lastError = {
            code: typeof error.code === 'string' ? error.code : this.lastError?.code,
            message: typeof error.message === 'string' ? error.message : this.lastError?.message,
            retryable: error.retryable === true || this.lastError?.retryable === true,
          };
        }
        if (this.finalization?.resumable && this.finalization.turn === turn) {
          this.finalization.reason = reason;
          return true;
        }
        this.pendingEnd = { turn, reason };
        this.scheduleEnd();
        return true;
      }
      default:
        return true;
    }
  }

  private emitSubagent(frame: KimiProjectedFrame, payload: Record<string, unknown>, state: 'running' | 'succeeded' | 'failed' | 'cancelled'): void {
    const turn = this.activeTurn;
    if (turn === null || this.terminalSent) return;
    const subagentId = typeof payload.subagentId === 'string' ? payload.subagentId : '';
    if (subagentId === '') return;
    const owner = this.subagentOwners.get(subagentId);
    if (owner !== undefined && owner !== turn.gianTurnId) return;
    if (state === 'running') {
      const previous = this.subagentStates.get(subagentId);
      if (previous !== undefined && (previous !== 'suspended' || frame.type !== 'subagent.started')) return;
      const parent = typeof payload.parentToolCallId === 'string' ? payload.parentToolCallId : null;
      const nativeTurnId = typeof payload.turnId === 'number' ? payload.turnId : null;
      const agentId = typeof payload.agentId === 'string' ? payload.agentId : 'main';
      const belongsToTurn = this.acceptingNativeTurn && (
        (previous === 'suspended' && owner === turn.gianTurnId)
        || (parent !== null && this.ownedToolCalls.has(parent)
          && (nativeTurnId !== null || !this.ambiguousToolIds.has(parent)))
        || (nativeTurnId !== null && nativeTurnId === turn.nativeTurnId)
        || this.subagentOwners.get(agentId) === turn.gianTurnId
      );
      if (!belongsToTurn) return;
      this.resumeIdleFinalization();
      this.resetReconciliation();
      this.subagentOwners.set(subagentId, turn.gianTurnId);
      this.subagentStates.set(subagentId, 'running');
      if (parent !== null) {
        this.subagentParents.set(subagentId, this.lastToolActivity.get(parent) ?? parent);
      }
    } else {
      const previous = this.subagentStates.get(subagentId);
      if (owner !== turn.gianTurnId || previous === undefined || previous === 'ended') return;
      if (frame.type === 'subagent.suspended' && previous !== 'running') return;
      this.subagentStates.set(subagentId, frame.type === 'subagent.suspended' ? 'suspended' : 'ended');
      this.resetReconciliation();
      this.invalidateIdleSignal();
    }
    if (state !== 'running') this.openActivities.delete(`agent:${subagentId}`);
    else this.openActivities.set(`agent:${subagentId}`, { name: 'subagent', input: undefined });
    const title = typeof payload.description === 'string' && payload.description !== ''
      ? payload.description
      : typeof payload.subagentName === 'string' ? payload.subagentName : 'subagent';
    const gianState = state === 'running' ? 'running' : state === 'succeeded' ? 'completed' : state === 'failed' ? 'failed' : 'interrupted';
    this.emitTurn('activity.updated', [frame.seq, 'subagent', subagentId], {
      activityId: subagentId,
      kind: 'subagent:kimi',
      title,
      status: state === 'running' ? 'running' : state === 'succeeded' ? 'succeeded' : state === 'failed' ? 'failed' : 'cancelled',
      presentation: {
        type: 'agent',
        data: {
          agentId: subagentId,
          state: gianState,
          ...(this.subagentParents.has(subagentId) ? { parentToolCallId: this.subagentParents.get(subagentId) } : {}),
          ...(typeof payload.subagentName === 'string' ? { subagentType: payload.subagentName } : {}),
          ...(state === 'succeeded' && typeof payload.resultSummary === 'string' ? { summary: payload.resultSummary } : {}),
          ...(state === 'failed' && typeof payload.error === 'string' ? { summary: payload.error } : {}),
        },
      },
    }, turn);
    this.scheduleEnd();
  }

  private settleQuestionTask(pending: PendingInteractionState, outcome: 'succeeded' | 'cancelled'): void {
    if (pending.toolCallId === undefined) return;
    for (const [taskId, info] of this.taskInfo) {
      if (info.kind !== 'question' || info.toolCallId !== pending.toolCallId || this.taskStates.get(taskId) !== 'running') continue;
      this.emitTask({ type: 'question.resolved', seq: this.lastSeq, payload: {} }, info, outcome,
        ['question-task', pending.interactionId, taskId, outcome]);
    }
  }

  private emitTask(frame: KimiProjectedFrame, info: Record<string, unknown>, status: 'running' | 'succeeded' | 'failed' | 'cancelled', source?: unknown): void {
    const turn = this.activeTurn;
    if (turn === null || this.terminalSent) return;
    const taskId = typeof info.taskId === 'string' ? info.taskId : '';
    if (taskId === '') return;
    const owner = this.taskOwners.get(taskId);
    if (owner !== undefined && owner !== turn.gianTurnId) return;
    if (status === 'running') {
      if (this.taskStates.has(taskId)) return;
      const parent = typeof info.parentToolCallId === 'string' ? info.parentToolCallId
        : typeof info.toolCallId === 'string' ? info.toolCallId : null;
      const nativeTurnId = typeof frame.payload.turnId === 'number' ? frame.payload.turnId : null;
      const agentId = typeof frame.payload.agentId === 'string' ? frame.payload.agentId : 'main';
      const belongsToTurn = this.acceptingNativeTurn && (
        (parent !== null && this.ownedToolCalls.has(parent)
          && (nativeTurnId !== null || !this.ambiguousToolIds.has(parent)))
        || (nativeTurnId !== null && nativeTurnId === turn.nativeTurnId)
        || this.subagentOwners.get(agentId) === turn.gianTurnId
      );
      if (!belongsToTurn) return;
      this.resumeIdleFinalization();
      this.resetReconciliation();
      this.taskOwners.set(taskId, turn.gianTurnId);
      this.taskStates.set(taskId, 'running');
      this.taskInfo.set(taskId, info);
    } else {
      if (owner !== turn.gianTurnId || this.taskStates.get(taskId) !== 'running') return;
      this.taskStates.set(taskId, 'ended');
      this.resetReconciliation();
      this.invalidateIdleSignal();
    }
    const activityId = `task:${taskId}`;
    if (status !== 'running') this.openActivities.delete(activityId);
    else this.openActivities.set(activityId, { name: 'task', input: undefined });
    this.emitTurn('activity.updated', source ?? [frame.seq, 'task', taskId], {
      activityId,
      kind: `task:${typeof info.kind === 'string' ? info.kind : 'process'}`,
      title: typeof info.description === 'string' && info.description !== '' ? info.description : taskId,
      status,
      presentation: {
        type: 'agent',
        data: {
          agentId: taskId,
          state: status === 'running' ? 'running' : status === 'succeeded' ? 'completed' : status === 'failed' ? 'failed' : 'interrupted',
        },
      },
    }, turn);
    this.scheduleEnd();
  }

  private clearEndTimer(): void {
    if (this.endTimer !== null) clearTimeout(this.endTimer);
    this.endTimer = null;
  }

  private clearReconcileTimer(): void {
    if (this.reconcileTimer !== null) clearTimeout(this.reconcileTimer);
    this.reconcileTimer = null;
  }

  private emitReconcileNotice(turn: ActiveTurn, message: string): void {
    if (this.reconcileNoticeSent || this.activeTurn !== turn || this.terminalSent) return;
    this.reconcileNoticeSent = true;
    this.emitTurn('activity.updated', ['work-reconciliation', turn.promptId], {
      activityId: `work-reconciliation:${sha16(turn.promptId)}`,
      kind: 'kimi:work-reconciliation',
      title: 'Native work status requires attention',
      status: 'failed',
      summary: message,
      presentation: { type: 'notice', data: { message } },
    }, turn);
  }

  private scheduleReconciliation(): void {
    const pending = this.pendingEnd;
    if (pending === null || this.services.reconcileWork === undefined || this.reconcilePaused
      || this.reconcileTimer !== null || this.reconciling || this.terminalSent
      || this.interruptPending || this.fencePending) return;
    const timer = setTimeout(() => {
      if (this.reconcileTimer !== timer) return;
      this.reconcileTimer = null;
      void this.reconcilePendingWork(pending.turn, this.lastSeq, this.stateRevision);
    }, this.reconcileDelayMs);
    timer.unref();
    this.reconcileTimer = timer;
  }

  private async reconcilePendingWork(turn: ActiveTurn, expectedSeq: number, expectedRevision: number): Promise<void> {
    if (this.services.reconcileWork === undefined || this.activeTurn !== turn || this.pendingEnd?.turn !== turn) return;
    this.reconciling = true;
    try {
      const snapshot = await this.services.reconcileWork({
        tasks: [...this.taskStates.values()].includes('running'),
        questions: [...this.pendingInteractions.values()].some((item) => item.kind === 'question'),
        approvals: [...this.pendingInteractions.values()].some((item) => item.kind === 'approval'),
      });
      if (this.activeTurn !== turn || this.pendingEnd?.turn !== turn || this.terminalSent
        || this.interruptPending || this.fencePending || this.lastSeq !== expectedSeq || this.stateRevision !== expectedRevision) return;
      if (snapshot === null || snapshot.lastSeq !== expectedSeq) {
        this.reconcileFailures += 1;
        if (this.reconcileFailures >= RECONCILE_FAILURE_LIMIT) {
          this.reconcilePaused = true;
          this.emitReconcileNotice(turn, 'Native work status could not be confirmed. The turn remains open; no work was resent or cancelled.');
        }
        return;
      }
      this.reconcileFailures = 0;
      for (const item of snapshot.tasks) {
        if (this.taskStates.get(item.id) !== 'running' || item.status === 'running') continue;
        const info = this.taskInfo.get(item.id);
        if (info === undefined) continue;
        const status = item.status === 'completed' ? 'succeeded' : item.status === 'failed' ? 'failed' : 'cancelled';
        this.emitTask({ type: 'task.reconciled', seq: expectedSeq, payload: {} }, info, status,
          ['task-reconciled', item.id, item.status]);
      }
      for (const pending of this.pendingInteractions.values()) {
        const listed = pending.kind === 'question' ? snapshot.questions : snapshot.approvals;
        if (!listed.includes(pending.nativeId)) {
          this.emitReconcileNotice(turn, 'The native server no longer lists an interaction, but its outcome is unknown. No answer was sent.');
          break;
        }
      }
      this.nativeBusy = snapshot.busy || snapshot.mainTurnActive || snapshot.pendingInteraction !== 'none'
        || snapshot.questions.length > 0 || snapshot.approvals.length > 0;
      this.idleSignalRequired = false;
      this.scheduleEnd();
    } catch {
      if (this.activeTurn === turn && this.pendingEnd?.turn === turn
        && this.lastSeq === expectedSeq && this.stateRevision === expectedRevision) {
        this.reconcileFailures += 1;
        if (this.reconcileFailures >= RECONCILE_FAILURE_LIMIT) {
          this.reconcilePaused = true;
          this.emitReconcileNotice(turn, 'Native work status could not be confirmed. The turn remains open; no work was resent or cancelled.');
        }
      }
    } finally {
      this.reconciling = false;
      if (this.activeTurn === turn) this.reconcileDelayMs = Math.min(RECONCILE_MAX_MS, this.reconcileDelayMs * 2);
      this.scheduleReconciliation();
    }
  }

  private scheduleEnd(): void {
    const pending = this.pendingEnd;
    if (pending === null || this.endTimer !== null || this.finalization !== null) return;
    const timer = setTimeout(() => {
      if (this.endTimer !== timer) return;
      this.endTimer = null;
      const latest = this.pendingEnd;
      if (latest === null || latest.turn !== pending.turn || this.activeTurn !== pending.turn || this.terminalSent) return;
      if (this.nativeBusy === true || this.interruptPending || this.fencePending || this.pendingInteractions.size > 0
        || [...this.taskStates.values()].includes('running') || [...this.subagentStates.values()].some((state) => state !== 'ended')) {
        this.scheduleReconciliation();
        return;
      }
      // A task can schedule another native turn after its own terminal event.
      // Without an authoritative idle signal, do not guess that the session
      // is finished merely because all currently observed tasks have ended.
      if (this.nativeBusy === null && (this.idleSignalRequired || this.taskStates.size > 0 || this.subagentStates.size > 0)) {
        this.scheduleReconciliation();
        return;
      }
      void this.finalizeTurn(latest.reason, true).catch(() => undefined);
    }, 0);
    this.endTimer = timer;
  }

  private finishFinalization(turn: ActiveTurn): void {
    if (this.activeTurn !== turn) return;
    this.clearEndTimer();
    this.clearReconcileTimer();
    this.pendingEnd = null;
    this.finalization = null;
    this.activeTurn = null;
    this.nativeBusy = null;
    this.idleSignalRequired = false;
    this.acceptingNativeTurn = false;
    this.interruptPending = false;
    this.fencePending = false;
    this.services.onFinalized?.(turn.gianTurnId);
  }

  private emitPlan(toolCallId: string, items: Array<{ title: string; status: string }>): void {
    if (this.activeTurn === null) return;
    const steps = items
      .filter((item) => typeof item.title === 'string' && item.title !== '')
      .map((item, index) => ({
        id: `step-${index}`,
        text: item.title,
        status: PLAN_STATUS_MAP[item.status] ?? 'pending',
      }));
    const fingerprint = JSON.stringify(steps);
    if (fingerprint === this.lastPlanFingerprint) return;
    this.lastPlanFingerprint = fingerprint;
    this.emitTurn('plan.updated', ['plan', toolCallId], {
      planId: `kimi:todos:${this.services.nativeSessionId}`,
      title: 'Plan',
      steps,
    }, this.activeTurn);
  }

  private emitPlanReview(toolCallId: string, display: KimiToolDisplay): void {
    if (this.activeTurn === null) return;
    const steps = [{ id: 'step-0', text: display.plan ?? '', status: 'completed' }];
    const fingerprint = JSON.stringify(steps);
    if (fingerprint === this.lastPlanFingerprint) return;
    this.lastPlanFingerprint = fingerprint;
    this.emitTurn('plan.updated', ['plan-review', toolCallId], {
      planId: `kimi:plan:${this.services.nativeSessionId}`,
      title: 'Plan',
      steps,
    }, this.activeTurn);
  }

  /** Force-fail the active turn (interrupt settle timeout, resync, runtime
   *  loss): the terminal is emitted deterministically with the given error.
   *  When a finalization is already in flight its outcome is known and
   *  stands; this only expedites its optional facets. */
  async failTurn(message: string, retryable: boolean): Promise<void> {
    if (this.terminalSent || this.finalization !== null) {
      this.facetsAborted = true;
      return;
    }
    this.lastError = { message, retryable };
    await this.finalizeTurn('failed');
  }

  /** Deterministic terminal finalization. Async facets (final usage, file
   *  diff) are fetched best-effort; failures skip the facet. */
  async finalizeTurn(reason: string, resumable = false): Promise<void> {
    if (this.terminalSent || this.finalization !== null || this.activeTurn === null) return;
    const turn = this.activeTurn;
    const attempt = { turn, reason, resumable };
    this.finalization = attempt;
    this.clearEndTimer();
    this.pendingEnd = null;

    const facetDeadline = Date.now() + FINAL_FACET_BUDGET_MS;
    const diffs: Array<{ nativeTurnId: number; value: NonNullable<Awaited<ReturnType<ProjectorServices['fileDiff']>>> }> = [];

    // Consumption comes only from the existing stream. Do not query session
    // metadata at finalization: its rollup can be a placeholder zero snapshot.
    for (const nativeTurnId of turn.nativeTurnIds) {
      if (this.facetsAborted || Date.now() >= facetDeadline) break;
      const diff = await this.withFacetDeadline(this.services.fileDiff(nativeTurnId), facetDeadline);
      if (this.activeTurn !== turn || this.finalization !== attempt) return;
      if (diff !== null && !this.facetsAborted && (diff.diff !== '' || diff.files.length > 0)) {
        diffs.push({ nativeTurnId, value: diff });
      }
    }
    if (this.activeTurn !== turn || this.finalization !== attempt) return;
    this.terminalSent = true;

    for (const [interactionId] of this.pendingInteractions) {
      this.emitTurn('interaction.resolved', [interactionId, 'resolved:turn_ended'], {
        interactionId,
        outcome: 'turn_ended',
      }, turn);
    }
    this.pendingInteractions.clear();

    for (const [contentId, content] of this.openContent) {
      this.emitTurn('content.completed', [contentId, 'content:finalizer'], {
        contentId,
        kind: content.kind,
        content: content.text,
      }, turn);
    }
    this.openContent.clear();

    for (const [activityId, activity] of this.openActivities) {
      const projectedActivityId = activity.name === 'subagent' && activityId.startsWith('agent:')
        ? activityId.slice('agent:'.length) : activityId;
      const presentation = activity.presentation ?? {
        type: 'tool',
        data: { name: activity.name },
      };
      this.emitTurn('activity.updated', [projectedActivityId, 'activity:finalizer'], {
        activityId: projectedActivityId,
        kind: `tool:${activity.name}`,
        title: activity.title ?? activity.name,
        status: turn.interruptAccepted ? 'cancelled' : 'failed',
        ...(!turn.interruptAccepted && (activity.name === 'task' || activity.name === 'subagent')
          ? { summary: 'The native activity outcome was not observed before the turn ended.' } : {}),
        presentation,
      }, turn);
    }
    this.openActivities.clear();

    for (const { nativeTurnId, value: diff } of diffs) {
      this.emitTurn('diff.updated', ['diff', nativeTurnId, sha16(diff.diff).slice(0, 8)], {
        diffId: `turn-${nativeTurnId}`,
        diff: diff.diff,
        truncated: diff.truncated,
        ...(diff.files.length > 0 ? { files: diff.files } : {}),
      }, turn);
    }

    const error = this.lastError;
    if (attempt.reason === 'failed') {
      if (error?.code === 'loop.max_steps_exceeded') {
        this.emitTerminal('turn.completed', 'limit_reached', turn);
        this.finishFinalization(turn);
        return;
      }
      const domain = mapKimiErrorCode(error?.code);
      this.services.emit({
        method: 'turn.failed',
        params: {
          eventId: terminalEventIdFor(this.services.nativeSessionId, turn.promptId, 'turn.failed'),
          sessionId: this.services.gianSessionId,
          streamId: this.streamId,
          sequence: this.services.nextSequence(),
          turnId: turn.gianTurnId,
          sourceTurnId: turn.promptId,
          emittedAt: new Date().toISOString(),
          data: {
            error: {
              domainCode: domain,
              message: error?.message ?? `Kimi turn ended with reason "${attempt.reason}".`,
              retryable: error?.retryable === true || domain === 'RUNTIME_AUTH_REQUIRED',
              details: error?.code !== undefined ? { nativeCode: error.code } : {},
            },
          },
        },
      });
      this.finishFinalization(turn);
      return;
    }
    const stopReason = attempt.reason === 'cancelled'
      ? (turn.interruptAccepted ? 'interrupted' : 'cancelled')
      : attempt.reason === 'blocked' ? 'other' : 'completed';
    this.emitTerminal('turn.completed', stopReason, turn);
    this.finishFinalization(turn);
  }

  /** Optional terminal facets never delay the terminal itself: the shared
   *  deadline caps the facet phase, and a hung or failed fetch resolves to a
   *  skipped facet rather than a stuck finalization. */
  private withFacetDeadline<T>(promise: Promise<T>, deadline: number): Promise<T | null> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return Promise.resolve(null);
    return Promise.race([
      promise.catch(() => null),
      new Promise<null>((resolve) => {
        const timer = setTimeout(() => resolve(null), remaining);
        timer.unref();
      }),
    ]);
  }

  private emitTerminal(method: 'turn.completed' | 'turn.failed', stopReason: string, turn: ActiveTurn): void {
    this.services.emit({
      method,
      params: {
        eventId: terminalEventIdFor(this.services.nativeSessionId, turn.promptId, method),
        sessionId: this.services.gianSessionId,
        streamId: this.streamId,
        sequence: this.services.nextSequence(),
        turnId: turn.gianTurnId,
        sourceTurnId: turn.promptId,
        emittedAt: new Date().toISOString(),
        data: method === 'turn.completed' ? { stopReason } : {
          error: { domainCode: 'RUNTIME_ERROR', message: 'Kimi turn failed.', retryable: false, details: {} },
        },
      },
    });
  }
}

function argsRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function argString(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

interface ToolProjection {
  title: string;
  presentation: { type: string; data: Record<string, unknown> };
}

function genericTool(name: string, args: unknown): ToolProjection {
  return {
    title: name,
    presentation: {
      type: 'tool',
      data: {
        name,
        ...(args !== undefined ? { input: args } : {}),
      },
    },
  };
}

/** Map a Kimi tool display onto a basket row. Assistant prose is not a tool
 *  and never comes through here. */
function projectToolCall(name: string, display: KimiToolDisplay | undefined, args: unknown): ToolProjection {
  const record = argsRecord(args);
  if (display?.kind === 'command') {
    const command = (typeof display.command === 'string' && display.command !== '' ? display.command : null)
      ?? argString(record, 'command');
    if (command !== null) {
      return { title: command, presentation: { type: 'command', data: { command } } };
    }
  }
  if (display?.kind === 'url_fetch') {
    const query = (typeof display.url === 'string' && display.url !== '' ? display.url : null)
      ?? argString(record, 'url');
    if (query !== null) {
      return { title: query, presentation: { type: 'search', data: { query } } };
    }
  }
  if (display?.kind === 'file_io') {
    const path = display.path ?? argString(record, 'path') ?? argString(record, 'file_path') ?? '';
    const operation = display.operation ?? '';
    if (path !== '' && (operation === 'read' || operation === 'write' || operation === 'delete' || operation === 'rename')) {
      return { title: path, presentation: { type: 'file', data: { path, operation } } };
    }
    if (path !== '' && operation === 'edit') {
      return { title: path, presentation: { type: 'file', data: { path, operation: 'write' } } };
    }
    if (operation === 'grep' || operation === 'glob' || operation === 'search') {
      const pattern = argString(record, 'pattern')
        ?? argString(record, 'glob')
        ?? argString(record, 'query')
        ?? (typeof display.query === 'string' && display.query !== '' ? display.query : null)
        ?? name;
      return {
        title: pattern,
        presentation: {
          type: 'file-search',
          data: {
            pattern,
            searchKind: operation === 'glob' ? 'glob' : 'grep',
            ...(path !== '' ? { path } : {}),
          },
        },
      };
    }
  }
  return genericTool(name, args);
}

export interface KimiCumulativeUsage {
  mode: 'absolute';
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
}

function safeUsageCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Project one main-agent `usage.total` snapshot.
 *
 * Pinned Kimi Code 2.2.0 adds `inputOther`, `output`, `inputCacheRead`, and
 * `inputCacheCreation` on every `usage.record`. `status().total` is their
 * sum for that agent space, so this snapshot is cumulative. Cache read and
 * cache creation are already inside `inputTokens` and are not added again.
 * `cachedInputTokens` reports cache read only. A missing, fractional,
 * negative, or overflowing component is incomplete and is not coerced to zero.
 */
export function projectKimiCumulativeUsage(total: unknown): KimiCumulativeUsage | null {
  if (!total || typeof total !== 'object') return null;
  const source = total as Record<string, unknown>;
  const inputOther = safeUsageCount(source.inputOther);
  const cacheRead = safeUsageCount(source.inputCacheRead);
  const cacheCreation = safeUsageCount(source.inputCacheCreation);
  const output = safeUsageCount(source.output);
  if (inputOther === null || cacheRead === null || cacheCreation === null || output === null) return null;
  const inputTokens = inputOther + cacheRead + cacheCreation;
  if (!Number.isSafeInteger(inputTokens)) return null;
  const totalTokens = inputTokens + output;
  if (!Number.isSafeInteger(totalTokens)) return null;
  return {
    mode: 'absolute',
    inputTokens,
    outputTokens: output,
    cachedInputTokens: cacheRead,
    totalTokens,
  };
}

/** Map a Kimi error code to a gian DomainCode (subset that matters). */
export function mapKimiErrorCode(code: string | undefined): string {
  switch (code) {
    case 'auth.login_required':
    case 'auth.token_missing':
    case 'auth.token_unauthorized':
    case 'auth.provisioning_required':
    case 'auth.model_not_resolved':
      return 'RUNTIME_AUTH_REQUIRED';
    case 'context.overflow':
      return 'SESSION_ERROR';
    case 'session.busy':
    case 'turn.agent_busy':
      return 'SESSION_BUSY';
    case 'activity.disposed':
    case 'activity.disposing':
      return 'SESSION_CLOSED';
    default:
      return 'RUNTIME_ERROR';
  }
}
