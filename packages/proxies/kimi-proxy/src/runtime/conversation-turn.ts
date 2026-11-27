import { createHash } from 'node:crypto';
import { terminalEventIdFor } from './conversation-replay.js';
import { KimiConversationBinding } from './conversation-binding.js';
import { KimiConversationContent } from './conversation-content.js';
import { KimiInteractionOwnership } from './conversation-interaction-ownership.js';
import { projectConversationInteraction } from './conversation-interaction-card.js';
import { approvalResponse, interactionEndpoint, questionResponse, type NativeQuestion } from './conversation-interaction.js';
import { KimiConversationSettlement } from './conversation-settlement.js';
import { KimiConversationTools } from './conversation-tools.js';
import { KimiConversationTasks } from './conversation-tasks.js';
import { KimiOpenWork, type OpenWorkOutcome } from './conversation-open-work.js';
import { conversationTurnError, type GianError } from './conversation-error.js';
import { conversationUsageEventSource, sumConversationUsage } from './conversation-usage.js';
import { projectConversationItem } from './conversation-item.js';

type Frame = Record<string, unknown>;
type Notification = { method: string; params: Frame };
type Pending = { nativeId: string; kind: 'approval' | 'question'; questions?: NativeQuestion[] };
type Diff = { diff: string; truncated: boolean; files: Array<{ path: string; status: string }> };
function object(value: unknown): value is Frame { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function id(value: unknown): value is string { return typeof value === 'string' && value !== ''; }
function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16); }

/** One submitted Gian turn over the native Kimi 2.7 conversation feed. */
export class KimiConversationTurn {
  private readonly binding: KimiConversationBinding;
  private readonly ownership: KimiInteractionOwnership;
  private readonly settlement: KimiConversationSettlement;
  private readonly content: KimiConversationContent;
  private readonly tools: KimiConversationTools;
  private readonly tasks: KimiConversationTasks;
  private readonly pending = new Map<string, Pending>();
  private readonly responding = new Map<string, string>();
  private readonly endedWhileResponding = new Map<string, string>();
  private nativeEnd: { outcome: string; reason?: string; emittedAt: string } | null = null;
  private failure: GianError | null = null;
  private readonly retries = new Map<string, Frame>();
  private readonly notices = new Set<string>();
  private queued = false;
  private finished = false;
  private interruptAccepted = false;
  private interruptPending = false;
  private fencePending = false;
  private readonly nativeTurnNumbers = new Map<string, number>();
  private readonly nativeUsage = new Map<string, unknown>();
  private readonly notificationEvents = new Set<string>();
  private anyNativeFailure = false;
  private anyNativeLimit = false;
  private lastPlan: string | null = null;
  private lastContext: string | null = null;
  private revision = 0;
  private finishTimer: NodeJS.Timeout | null = null;
  private finalizing = false;
  private admitted: boolean;
  private resynchronizing = false;
  /** Steers this turn waits for: prompt ID → the native turn that runs it
   *  (null until its opener is seen). Kimi may run a steer as the next native
   *  turn; this Gian turn ends only after that turn ends. */
  private readonly steers = new Map<string, string | null>();
  /** Everything this turn reported open; closed before its terminal. */
  private readonly openWork = new KimiOpenWork();

  constructor(private readonly context: { sessionId: string; nativeSessionId: string; streamId: string;
    turnId: string; promptId: string; nextSequence: () => number; emit: (notification: Notification) => void;
    onFinalized: () => void; onResynced?: () => void; fetchDiff?: (turnNumber: number) => Promise<Diff | null>; holdUntilAdmitted?: boolean }) {
    // Every emission (this turn's and its trackers') is recorded first, so
    // the terminal can close what is still open.
    const forward = context.emit;
    context.emit = notification => { this.openWork.observe(notification); forward(notification); };
    this.admitted = context.holdUntilAdmitted !== true;
    this.settlement = new KimiConversationSettlement(context.nativeSessionId);
    this.ownership = new KimiInteractionOwnership(context.nativeSessionId, frame => this.interaction(frame));
    this.content = new KimiConversationContent(context);
    this.tasks = new KimiConversationTasks({ ...context, onOwnedTask: taskId => this.binding.associateTask(taskId) });
    this.tools = new KimiConversationTools({ ...context, associateInteraction: (tool, interaction, taskId) => {
      this.ownership.associate(tool, interaction); this.tasks.associateTool(tool, taskId);
    } });
    this.binding = new KimiConversationBinding(context.nativeSessionId, context.promptId, frame => this.bound(frame), taskId => this.tasks.ownsTask(taskId));
  }

  /** Register a steer before it is submitted, so its native turn is ours. */
  addSteer(promptId: string): void {
    if (this.finished) throw new Error('Kimi turn has already finished.');
    this.steers.set(promptId, null); this.binding.addSteerPrompt(promptId); this.revision += 1;
  }

  /** The steer was refused or withdrawn: it runs nowhere. */
  dropSteer(promptId: string): void {
    this.steers.delete(promptId); this.binding.removeSteerPrompt(promptId); this.revision += 1;
    this.maybeFinish();
  }

  /** Prompt IDs an interrupt or fence must abort besides the opening one. */
  steerPromptIds(): string[] { return [...this.steers.keys()]; }

  receive(frame: Frame): void {
    if (this.finished || frame.session_id !== this.context.nativeSessionId
      || (frame.type !== 'session' && frame.agent_id !== 'main')) return;
    this.revision += 1;
    if (frame.type === 'interaction') this.ownership.receive(frame);
    else if (frame.type === 'agent' || frame.type === 'task' || frame.type === 'task.list' || frame.type === 'session') {
      if (frame.type === 'task' || frame.type === 'task.list') this.tasks.receive(frame);
      this.settlement.receive(frame);
    }
    else if (frame.type === 'todo' && this.binding.isBound()) this.todo(frame);
    else if (frame.type === 'context' && this.binding.isBound()) this.contextOccupancy(frame);
    else if (frame.type === 'notice' && this.binding.isBound()) this.notice(frame);
    else if (frame.type === 'turns' || String(frame.type).startsWith('turn.') || String(frame.type).startsWith('item.')) this.binding.receive(frame);
    this.maybeFinish();
  }

  /** Build a native HTTP request only for an explicit user action. The caller
   * must send it and invoke acknowledge only after the server accepts it. */
  response(interactionId: string, actionId: string, values: Frame): { path: string; json: Frame } {
    const pending = this.pending.get(interactionId);
    if (!pending) throw new Error('Kimi interaction is not pending.');
    if (this.responding.has(interactionId)) throw new Error('Kimi interaction response is already pending.');
    const json = pending.kind === 'approval' ? approvalResponse(actionId, values.feedback)
      : questionResponse(actionId, pending.questions ?? [], values);
    this.responding.set(interactionId, actionId);
    this.revision += 1;
    return { path: interactionEndpoint(this.context.nativeSessionId, pending.nativeId), json };
  }

  acknowledge(interactionId: string, actionId: string, emittedAt: string): boolean {
    const pending = this.pending.get(interactionId);
    if (!pending) return false;
    if (this.responding.get(interactionId) !== actionId) throw new Error('Kimi interaction response does not match the pending action.');
    this.revision += 1;
    this.pending.delete(interactionId);
    this.responding.delete(interactionId);
    this.endedWhileResponding.delete(interactionId);
    const cancelled = pending.kind === 'question' && actionId === 'decline';
    this.emit('interaction.resolved', [pending.nativeId, 'local', actionId], { interactionId,
      outcome: cancelled ? 'cancelled' : 'submitted', ...(cancelled ? {} : { actionId }) }, emittedAt);
    this.maybeFinish();
    return true;
  }

  rejectResponse(interactionId: string): void {
    this.responding.delete(interactionId);
    const endedAt = this.endedWhileResponding.get(interactionId);
    this.endedWhileResponding.delete(interactionId);
    this.revision += 1;
    if (endedAt && this.pending.delete(interactionId)) this.emit('interaction.resolved', [interactionId, 'native-ended'],
      { interactionId, outcome: 'cancelled' }, endedAt);
    this.maybeFinish();
  }

  hasPendingInteractions(): boolean { return this.pending.size > 0 || this.ownership.hasUnbound() || this.binding.hasUnbound(); }
  pendingInteractionKind(interactionId: string): 'approval' | 'question' | null { return this.pending.get(interactionId)?.kind ?? null; }
  getNativeTurnNumber(): number | null { return [...this.nativeTurnNumbers.values()].at(-1) ?? null; }
  isBound(): boolean { return this.binding.isBound(); }

  /** 2.7.1 keeps a new prompt `queued` while another native turn (a
   *  background-notification turn or another client's prompt) finishes. The
   *  binding already ignores foreign turns; the prompt binds when its own
   *  opener appears. */
  markQueued(): void { this.queued = true; this.revision += 1; }
  isQueued(): boolean { return this.queued && !this.binding.isBound(); }

  /** A queued prompt removed by an accepted abort never starts a native
   *  turn, so the interrupt is the terminal fact. */
  finishQueuedInterrupt(emittedAt: string): boolean {
    if (this.finished || this.binding.isBound() || !this.interruptAccepted) return false;
    this.finished = true; this.revision += 1;
    if (this.finishTimer) clearTimeout(this.finishTimer);
    this.finishTimer = null;
    this.context.emit({ method: 'turn.completed', params: { eventId: terminalEventIdFor(this.context.nativeSessionId, this.context.promptId, 'turn.completed'),
      sessionId: this.context.sessionId, streamId: this.context.streamId, turnId: this.context.turnId,
      sourceTurnId: this.context.promptId, sequence: this.context.nextSequence(), emittedAt, data: { stopReason: 'interrupted' } } });
    this.context.onFinalized();
    return true;
  }

  admit(): void { this.admitted = true; this.maybeFinish(); }

  disconnected(): void {
    if (this.finished) return;
    this.revision += 1; this.resynchronizing = true; this.nativeEnd = null;
    this.settlement.disconnected();
    if (this.finishTimer) clearTimeout(this.finishTimer);
    this.finishTimer = null;
  }

  /** A failed or uncontained runtime must produce a failure, never a
   * fabricated successful terminal. The caller is responsible for fencing. */
  fail(message: string, retryable: boolean): void {
    if (this.finished) return;
    this.finished = true; this.revision += 1;
    if (this.finishTimer) clearTimeout(this.finishTimer);
    this.finishTimer = null;
    const emittedAt = new Date().toISOString();
    this.closeRetries('failed', emittedAt);
    for (const interactionId of this.pending.keys()) this.emit('interaction.resolved', [interactionId, 'runtime-ended'],
      { interactionId, outcome: 'runtime_ended' }, emittedAt);
    this.pending.clear();
    this.responding.clear(); this.endedWhileResponding.clear();
    // The native work was aborted or abandoned: what is still open stopped.
    this.closeOpenWork('cancelled', emittedAt);
    this.context.emit({ method: 'turn.failed', params: {
      eventId: terminalEventIdFor(this.context.nativeSessionId, this.context.promptId, 'turn.failed'),
      sessionId: this.context.sessionId, streamId: this.context.streamId, turnId: this.context.turnId,
      sourceTurnId: this.context.promptId, sequence: this.context.nextSequence(), emittedAt,
      data: { error: { domainCode: 'RUNTIME_ERROR', message, retryable, details: {} } },
    } });
    this.context.onFinalized();
  }

  /** Hold terminal projection while a user-requested interrupt races the
   * native terminal. Only an accepted native response earns interrupted. */
  beginInterrupt(): void {
    if (this.finished || this.interruptPending || this.fencePending) throw new Error('Kimi turn cannot start another interrupt.');
    this.interruptPending = true;
    this.revision += 1;
  }

  beginFence(): boolean {
    if (this.finished || this.fencePending) return false;
    this.fencePending = true; this.revision += 1;
    return true;
  }

  finishInterrupt(accepted: boolean): void {
    if (!this.interruptPending) throw new Error('Kimi interrupt was not pending.');
    this.interruptPending = false;
    this.revision += 1;
    if (accepted) this.interruptAccepted = true;
    this.maybeFinish();
  }

  private bound(frame: Frame): void {
    if (!id(frame.event_created_at)) throw new Error('Kimi conversation frame has no native event time.');
    if (this.steers.size > 0 && (frame.type === 'item.started' || frame.type === 'item.ended') && object(frame.item)
      && frame.item.type === 'user_message' && Array.isArray(frame.item.prompt_ids) && id(frame.turn_id)) {
      for (const promptId of frame.item.prompt_ids) {
        if (typeof promptId === 'string' && this.steers.has(promptId)) this.steers.set(promptId, frame.turn_id);
      }
    }
    if (frame.type === 'turns') {
      if (!Array.isArray(frame.turns)) throw new Error('Invalid Kimi conversation snapshot.');
      const match = frame.turns.find(turn => object(turn) && Array.isArray(turn.items) && turn.items.some(item => object(item)
        && item.type === 'user_message' && item.placement === 'opener' && Array.isArray(item.prompt_ids)
        && item.prompt_ids.includes(this.context.promptId)));
      if (!object(match) || !Array.isArray(match.items)) throw new Error('Kimi snapshot lost its bound prompt.');
      this.hydrateSnapshotTurn(match, frame.event_created_at);
      const start = frame.turns.indexOf(match) + 1;
      for (const candidate of frame.turns.slice(start)) {
        if (!object(candidate) || !id(candidate.turn_id) || !Array.isArray(candidate.items)) throw new Error('Invalid Kimi continuation snapshot.');
        const steerOpener = candidate.items.find(item => object(item) && item.type === 'user_message' && Array.isArray(item.prompt_ids)
          && item.prompt_ids.some(promptId => typeof promptId === 'string' && this.steers.has(promptId)));
        if (object(steerOpener)) {
          for (const promptId of steerOpener.prompt_ids as unknown[]) {
            if (typeof promptId === 'string' && this.steers.has(promptId)) this.steers.set(promptId, candidate.turn_id);
          }
          this.binding.claimSteerTurn(candidate.turn_id);
          this.hydrateSnapshotTurn(candidate, frame.event_created_at);
          continue;
        }
        const notice = candidate.items.find(item => object(item) && item.type === 'notification' && id(item.task_id)
          && object(item.source) && item.source.kind === 'background_task' && item.source.id === item.task_id);
        if (!object(notice) || !id(notice.task_id)) continue;
        if (!this.binding.bindSnapshotContinuation(candidate.turn_id, notice.task_id)) throw new Error('Kimi continuation snapshot has unknown ownership.');
        this.hydrateSnapshotTurn(candidate, frame.event_created_at);
      }
      if (this.resynchronizing) { this.resynchronizing = false; this.context.onResynced?.(); }
      return;
    }
    if (frame.type === 'turn.started') {
      if (!object(frame.turn)) throw new Error('Invalid Kimi starting turn.');
      this.recordTurnNumber(frame.turn); this.nativeEnd = null; this.settlement.turnStarted(); return;
    }
    if (frame.type === 'turn.ended') {
      if (!object(frame.turn)) throw new Error('Invalid Kimi terminal turn.');
      this.end(frame.turn, frame.event_created_at); return;
    }
    if (frame.type === 'turn.updated') { this.retry(frame, frame.event_created_at); return; }
    if (String(frame.type).startsWith('item.')) this.item(frame);
  }

  private hydrateSnapshotTurn(turn: Frame, emittedAt: string): void {
    if (!Array.isArray(turn.items)) throw new Error('Invalid Kimi conversation snapshot turn.');
    this.recordTurnNumber(turn);
    if (turn.status === 'running') { this.nativeEnd = null; this.settlement.turnStarted(); }
    for (const item of turn.items) {
      if (!object(item)) throw new Error('Invalid Kimi conversation item.');
      if (item.type === 'assistant_message' || item.type === 'reasoning') this.content.hydrate(item, emittedAt);
      else this.item({ type: item.status === 'ended' ? 'item.ended' : 'item.started', item, event_created_at: emittedAt });
    }
    if (turn.status === 'ended') this.end(turn, emittedAt);
    else if (turn.status !== 'running') throw new Error('Invalid Kimi snapshot turn status.');
  }

  private item(frame: Frame): void {
    this.content.receive(frame);
    this.tools.receive(frame);
    if (frame.type === 'item.ended' && object(frame.item) && (frame.item.type === 'notification' || frame.item.type === 'system')) {
      if (!id(frame.event_created_at)) throw new Error('Invalid Kimi notification time.');
      const projection = projectConversationItem(this.context.nativeSessionId, this.context.promptId, frame.item);
      if (!projection) throw new Error('Kimi notification has no valid projection.');
      if (this.notificationEvents.has(projection.eventId)) return;
      this.notificationEvents.add(projection.eventId);
      this.context.emit({ method: projection.method, params: { eventId: projection.eventId, data: projection.data,
        emittedAt: frame.event_created_at, sessionId: this.context.sessionId, streamId: this.context.streamId,
        turnId: this.context.turnId, sourceTurnId: this.context.promptId, sequence: this.context.nextSequence() } });
    }
  }

  private end(turn: Frame, emittedAt: string): void {
    this.recordTurnNumber(turn);
    if (turn.status !== 'ended' || !['completed', 'interrupted', 'failed'].includes(String(turn.outcome))) throw new Error('Kimi terminal turn has no recognized outcome.');
    this.nativeEnd = { outcome: turn.outcome as string, emittedAt,
      ...(typeof turn.end_reason === 'string' ? { reason: turn.end_reason } : {}) };
    if (!id(turn.turn_id)) throw new Error('Kimi terminal turn has no native identity.');
    if (turn.usage !== undefined) this.nativeUsage.set(turn.turn_id, turn.usage);
    this.closeRetries(turn.outcome === 'completed' ? 'succeeded' : turn.outcome === 'interrupted' ? 'cancelled' : 'failed', emittedAt, turn.turn_id);
    if (turn.outcome === 'failed' && turn.end_reason !== 'max_steps') {
      this.anyNativeFailure = true;
      this.failure = conversationTurnError(turn.error, typeof turn.end_reason === 'string' ? turn.end_reason : undefined);
    }
    if (turn.end_reason === 'max_steps') this.anyNativeLimit = true;
    for (const [promptId, nativeTurn] of this.steers) if (nativeTurn === turn.turn_id) this.steers.delete(promptId);
    this.settlement.turnFinished();
  }

  private recordTurnNumber(turn: Frame): void {
    if (turn.turn_number === undefined) return;
    if (!id(turn.turn_id) || !Number.isSafeInteger(turn.turn_number) || (turn.turn_number as number) < 0
      || (this.nativeTurnNumbers.has(turn.turn_id) && this.nativeTurnNumbers.get(turn.turn_id) !== turn.turn_number)) {
      throw new Error('Invalid or changed Kimi native turn number.');
    }
    this.nativeTurnNumbers.set(turn.turn_id, turn.turn_number as number);
  }

  private todo(frame: Frame): void {
    if (!id(frame.event_created_at) || !Array.isArray(frame.items)) throw new Error('Invalid Kimi plan state.');
    const statusMap: Record<string, string> = { pending: 'pending', in_progress: 'in_progress', done: 'completed' };
    const steps = frame.items.map((item, index) => {
      if (!object(item) || !id(item.title) || typeof item.status !== 'string' || !Object.hasOwn(statusMap, item.status)) throw new Error('Invalid Kimi plan item.');
      return { id: `step-${index}`, text: item.title, status: statusMap[item.status] };
    });
    const fingerprint = JSON.stringify(steps);
    if (fingerprint === this.lastPlan) return;
    this.lastPlan = fingerprint;
    this.emit('plan.updated', ['plan', fingerprint], { planId: `kimi:todos:${this.context.nativeSessionId}`, title: 'Plan', steps }, frame.event_created_at);
  }

  /** Native retry state (`turn.updated` with `retry`) is a running activity
   *  until the step succeeds or the native turn ends. */
  private retry(frame: Frame, emittedAt: string): void {
    if (!id(frame.turn_id)) return;
    const activityId = `retry:${this.context.promptId}:${frame.turn_id}`;
    const retry = frame.retry;
    if (object(retry) && Number.isSafeInteger(retry.next_attempt) && Number.isSafeInteger(retry.max_attempts)) {
      const error = object(retry.error) && typeof retry.error.message === 'string' ? retry.error.message.slice(0, 2_000) : 'The model request failed.';
      const delay = typeof retry.delay_ms === 'number' && retry.delay_ms > 0 ? ` in ${Math.ceil(retry.delay_ms / 1000)} s` : '';
      const data = { activityId, kind: 'kimi:retry', title: 'Retrying the model request', status: 'running',
        presentation: { type: 'notice', data: { message: `${error} Retry ${String(retry.next_attempt)} of ${String(retry.max_attempts)}${delay}.` } } };
      this.retries.set(frame.turn_id, data);
      this.emit('activity.updated', ['retry', frame.turn_id, data], data, emittedAt);
    } else if (object(frame.step)) this.closeRetries('succeeded', emittedAt, frame.turn_id);
  }

  private closeRetries(status: 'succeeded' | 'failed' | 'cancelled', emittedAt: string, turnId?: string): void {
    for (const [nativeTurnId, data] of [...this.retries]) {
      if (turnId !== undefined && nativeTurnId !== turnId) continue;
      this.retries.delete(nativeTurnId);
      const closed = { ...data, status };
      this.emit('activity.updated', ['retry', nativeTurnId, closed], closed, emittedAt);
    }
  }

  /** Native warnings and agent errors (`notice` frames) are shown, never
   *  turned into a terminal of their own. */
  private notice(frame: Frame): void {
    if (!id(frame.event_created_at) || !id(frame.title) || !['info', 'warning', 'error'].includes(String(frame.level))) return;
    const message = (typeof frame.detail === 'string' && frame.detail !== '' ? frame.detail : frame.title).slice(0, 64 * 1024);
    const data = { activityId: `notice:${this.context.promptId}:${digest([frame.title, frame.detail, frame.code, frame.event_created_at])}`,
      kind: 'kimi:notice', title: frame.title.slice(0, 500), status: frame.level === 'error' ? 'failed' : 'succeeded',
      presentation: { type: 'notice', data: { message } } };
    if (this.notices.has(data.activityId)) return;
    this.notices.add(data.activityId);
    this.emit('activity.updated', ['notice', data], data, frame.event_created_at);
  }

  /** 2.7 renamed the occupancy feed from `usage` to `context`. */
  private contextOccupancy(frame: Frame): void {
    if (!id(frame.event_created_at) || !Number.isSafeInteger(frame.context_tokens) || (frame.context_tokens as number) < 0
      || (frame.max_context_tokens !== undefined && (!Number.isSafeInteger(frame.max_context_tokens) || (frame.max_context_tokens as number) <= 0))) {
      throw new Error('Invalid Kimi context usage.');
    }
    const context = { used: frame.context_tokens as number,
      ...(typeof frame.max_context_tokens === 'number' ? { window: frame.max_context_tokens } : {}) };
    const fingerprint = JSON.stringify(context);
    if (fingerprint === this.lastContext) return;
    this.lastContext = fingerprint;
    this.emit('usage.updated', ['context', fingerprint], { context }, frame.event_created_at);
  }

  private interaction(frame: Frame): void {
    if (!id(frame.interaction_id) || !id(frame.event_created_at)) throw new Error('Invalid Kimi interaction identity.');
    const interactionId = `${frame.kind === 'approval' ? 'apr' : 'q'}:${frame.interaction_id}`;
    if (frame.status === 'ended') {
      if (this.responding.has(interactionId)) { this.endedWhileResponding.set(interactionId, frame.event_created_at); return; }
      if (this.pending.delete(interactionId)) this.emit('interaction.resolved', [frame.interaction_id, 'native-ended'],
        { interactionId, outcome: 'cancelled' }, frame.event_created_at);
      return;
    }
    if (this.pending.has(interactionId)) return;
    const projected = projectConversationInteraction(frame);
    const kind = frame.kind === 'approval' ? 'approval' : 'question';
    this.pending.set(interactionId, { nativeId: frame.interaction_id, kind,
      ...(projected.questions ? { questions: projected.questions } : {}) });
    this.emit('interaction.requested', [frame.interaction_id, 'requested'], projected.data, frame.event_created_at);
  }

  private maybeFinish(): void {
    if (!this.readyToFinish() || this.finishTimer || this.finalizing) return;
    this.finishTimer = setTimeout(() => {
      this.finishTimer = null;
      if (this.readyToFinish()) void this.finalize();
    }, 0);
  }

  private readyToFinish(): boolean {
    return this.admitted && !this.resynchronizing && !this.finished && !this.interruptPending && !this.fencePending && this.nativeEnd !== null
      && this.steers.size === 0 && this.settlement.canFinish(this.hasPendingInteractions());
  }

  private async finalize(): Promise<void> {
    if (!this.readyToFinish() || this.finalizing) return;
    this.finalizing = true;
    const revision = this.revision;
    const diffs: Array<{ number: number; value: Diff }> = [];
    const deadline = Date.now() + 10_000;
    if (this.context.fetchDiff) for (const number of new Set(this.nativeTurnNumbers.values())) {
      if (Date.now() >= deadline || revision !== this.revision) break;
      try {
        let timer: NodeJS.Timeout | undefined;
        try {
          const value = await Promise.race([this.context.fetchDiff(number), new Promise<null>(resolve => {
            timer = setTimeout(() => resolve(null), Math.max(1, deadline - Date.now())); timer.unref();
          })]);
          if (value) diffs.push({ number, value });
        } finally { if (timer) clearTimeout(timer); }
      } catch { /* Optional native file history is not a turn failure. */ }
    }
    this.finalizing = false;
    if (revision !== this.revision || !this.readyToFinish()) { this.maybeFinish(); return; }
    const end = this.nativeEnd!;
    // One delta per Gian turn: a turn that spans background continuations
    // sums its native turns (the Host and conformance key one delta per turn).
    const usage = sumConversationUsage([...this.nativeUsage.values()]);
    if (usage) this.emit('usage.updated', conversationUsageEventSource([...this.nativeUsage.keys()], usage), usage, end.emittedAt);
    for (const { number, value } of diffs) if (value.diff !== '' || value.files.length > 0) this.emit('diff.updated', ['diff', number, digest(value)], {
      diffId: `turn-${number}`, diff: value.diff, truncated: value.truncated,
      ...(value.files.length ? { files: value.files } : {}),
    }, end.emittedAt);
    this.finished = true;
    const failed = this.anyNativeFailure;
    const method = failed ? 'turn.failed' : 'turn.completed';
    this.closeRetries(failed ? 'failed' : end.outcome === 'interrupted' ? 'cancelled' : 'succeeded', end.emittedAt);
    this.closeOpenWork(failed ? 'failed' : end.outcome === 'interrupted' ? 'cancelled' : 'succeeded', end.emittedAt);
    const data = failed ? { error: this.failure ?? conversationTurnError(undefined, end.reason) }
      : { stopReason: this.anyNativeLimit ? 'limit_reached' : end.outcome === 'interrupted' ? (this.interruptAccepted ? 'interrupted' : 'cancelled')
        : end.reason === 'blocked' ? 'other' : 'completed' };
    this.context.emit({ method, params: { eventId: terminalEventIdFor(this.context.nativeSessionId, this.context.promptId, method),
      sessionId: this.context.sessionId, streamId: this.context.streamId, turnId: this.context.turnId,
      sourceTurnId: this.context.promptId, sequence: this.context.nextSequence(), emittedAt: end.emittedAt, data } });
    this.context.onFinalized();
  }

  /** Close what Kimi left open (a task end lost across a reconnect, work of
   *  a fenced or abandoned turn): the Host requires it before the terminal. */
  private closeOpenWork(outcome: OpenWorkOutcome, emittedAt: string): void {
    for (const event of this.openWork.closing(outcome)) {
      this.emit(event.method, ['close-open-work', event.method, event.key, outcome], event.data, emittedAt);
    }
  }

  private emit(method: string, source: unknown, data: Frame, emittedAt: string): void {
    this.context.emit({ method, params: { eventId: `evt-${digest([this.context.nativeSessionId, this.context.promptId, source])}`,
      sessionId: this.context.sessionId, streamId: this.context.streamId, turnId: this.context.turnId,
      sourceTurnId: this.context.promptId, sequence: this.context.nextSequence(), emittedAt, data } });
  }
}
