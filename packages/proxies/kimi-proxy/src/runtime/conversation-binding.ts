type Frame = Record<string, unknown>;
const MAX_BUFFERED_FRAMES = 4_096;
const MAX_BUFFERED_BYTES = 32 * 1024 * 1024;

function record(value: unknown): value is Frame {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Attribute a native conversation turn only after its opener contains the
 * submitted prompt ID. Native turn.started has no prompt ID; guessing from its
 * arrival order can attach another client's work to the Gian turn. */
export class KimiConversationBinding {
  private nativeTurnId: string | null = null;
  private readonly ownedTurns = new Set<string>();
  private readonly buffered = new Map<string, Frame[]>();
  private readonly bufferedBytesByTurn = new Map<string, number>();
  private readonly excluded = new Set<string>();
  private bufferedCount = 0;
  private bufferedBytes = 0;
  /** Prompts steered into this turn. Kimi can end the running native turn
   *  at a step boundary and run a steer as the next native turn; that turn
   *  is opened by the steer's prompt ID and belongs to this Gian turn. */
  private readonly steerPrompts = new Set<string>();

  constructor(private readonly sessionId: string, private readonly promptId: string,
    private readonly deliver: (frame: Frame) => void, private readonly ownsTask: (taskId: string) => boolean = () => false) {
    if (!sessionId || !promptId) throw new Error('Kimi turn binding requires session and prompt IDs.');
  }

  isBound(): boolean { return this.nativeTurnId !== null; }

  addSteerPrompt(promptId: string): void { if (promptId) this.steerPrompts.add(promptId); }
  removeSteerPrompt(promptId: string): void { this.steerPrompts.delete(promptId); }

  /** A native turn opened by one of this turn's steer prompts. */
  claimSteerTurn(turnId: string): void {
    if (!turnId) return;
    if (this.excluded.delete(turnId)) { /* opened before the steer was registered */ }
    if (this.buffered.has(turnId)) this.claimContinuation(turnId);
    else this.ownedTurns.add(turnId);
  }
  hasUnbound(): boolean { return this.buffered.size > 0; }

  bindSnapshotContinuation(turnId: string, taskId: string): boolean {
    if (!this.nativeTurnId || !turnId || !this.ownsTask(taskId)) return false;
    this.ownedTurns.add(turnId);
    return true;
  }

  receive(frame: Frame): void {
    if (frame.session_id !== this.sessionId || frame.agent_id !== 'main') return;
    if (frame.type === 'turns') {
      if (!Array.isArray(frame.turns)) throw new Error('Invalid Kimi conversation snapshot.');
      const matches = frame.turns.filter(turn => record(turn) && this.hasOpener(turn.items));
      if (matches.length > 1) throw new Error('Kimi prompt appears in multiple native turns.');
      const match = matches[0];
      if (record(match) && typeof match.turn_id === 'string' && match.turn_id !== '') {
        if (this.nativeTurnId !== null && this.nativeTurnId !== match.turn_id) throw new Error('Kimi prompt changed native turn identity.');
        this.nativeTurnId = match.turn_id;
        this.ownedTurns.add(match.turn_id);
        this.clearBuffers();
        this.deliver(frame);
      }
      return;
    }
    const header = record(frame.turn) ? frame.turn : null;
    const nativeId = typeof frame.turn_id === 'string' ? frame.turn_id
      : typeof header?.turn_id === 'string' ? header.turn_id : '';
    if (nativeId === '' || this.excluded.has(nativeId)) return;
    if (this.ownedTurns.has(nativeId)) { this.deliver(frame); return; }
    const bytes = Buffer.byteLength(JSON.stringify(frame), 'utf8');
    if (this.bufferedCount >= MAX_BUFFERED_FRAMES || this.bufferedBytes + bytes > MAX_BUFFERED_BYTES) throw new Error('Kimi native turn binding buffer overflow.');
    const frames = this.buffered.get(nativeId) ?? [];
    frames.push(frame); this.buffered.set(nativeId, frames); this.bufferedCount += 1;
    this.bufferedBytes += bytes;
    this.bufferedBytesByTurn.set(nativeId, (this.bufferedBytesByTurn.get(nativeId) ?? 0) + bytes);
    if ((frame.type === 'item.started' || frame.type === 'item.ended') && record(frame.item)
      && frame.item.type === 'user_message' && frame.item.placement === 'opener') {
      const promptIds = frame.item.prompt_ids;
      if (!Array.isArray(promptIds) || !promptIds.every(value => typeof value === 'string' && value !== '')) {
        throw new Error('Kimi turn opener has invalid prompt IDs.');
      }
      if (!promptIds.includes(this.promptId) && promptIds.some(id => this.steerPrompts.has(id as string))) {
        this.claimContinuation(nativeId);
        return;
      }
      if (!promptIds.includes(this.promptId)) {
        if (this.excluded.size >= MAX_BUFFERED_FRAMES) throw new Error('Kimi native turn exclusion budget exceeded.');
        this.buffered.delete(nativeId); this.bufferedCount -= frames.length;
        this.bufferedBytes -= this.bufferedBytesByTurn.get(nativeId) ?? 0;
        this.bufferedBytesByTurn.delete(nativeId); this.excluded.add(nativeId);
        return;
      }
      if (this.nativeTurnId !== null) throw new Error('Kimi prompt appears in multiple native turns.');
      this.nativeTurnId = nativeId;
      this.ownedTurns.add(nativeId);
      this.buffered.delete(nativeId); this.bufferedCount -= frames.length;
      this.bufferedBytes -= this.bufferedBytesByTurn.get(nativeId) ?? 0;
      this.bufferedBytesByTurn.delete(nativeId);
      for (const value of frames) this.deliver(value);
      return;
    }
    const taskId = this.notificationTask(frame);
    if (this.nativeTurnId !== null && taskId && this.ownsTask(taskId)) { this.claimContinuation(nativeId); return; }
    // A foreign turn that ended unclaimed is not ours: before our opener (a
    // prompt queued behind another client's or a background-notification
    // turn, Kimi 2.7.1) or, once bound, when it carries no background-task
    // notification that could still prove ownership. Holding it would keep
    // the Gian turn "pending" forever.
    if (frame.type === 'turn.ended'
      && (this.nativeTurnId === null || !frames.some(value => this.notificationTask(value) !== null))) this.exclude(nativeId);
  }

  private exclude(nativeId: string): void {
    const frames = this.buffered.get(nativeId) ?? [];
    if (this.excluded.size >= MAX_BUFFERED_FRAMES) throw new Error('Kimi native turn exclusion budget exceeded.');
    this.buffered.delete(nativeId); this.bufferedCount -= frames.length;
    this.bufferedBytes -= this.bufferedBytesByTurn.get(nativeId) ?? 0;
    this.bufferedBytesByTurn.delete(nativeId); this.excluded.add(nativeId);
  }

  /** A task notification may arrive before its parent tool association. */
  associateTask(taskId: string): void {
    if (!this.nativeTurnId || !this.ownsTask(taskId)) return;
    for (const [turnId, frames] of this.buffered) {
      if (frames.some(frame => this.notificationTask(frame) === taskId)) this.claimContinuation(turnId);
    }
  }

  private notificationTask(frame: Frame): string | null {
    if ((frame.type !== 'item.started' && frame.type !== 'item.ended') || !record(frame.item)
      || frame.item.type !== 'notification' || typeof frame.item.task_id !== 'string' || !frame.item.task_id
      || !record(frame.item.source) || frame.item.source.kind !== 'background_task'
      || frame.item.source.id !== frame.item.task_id) return null;
    return frame.item.task_id;
  }

  private claimContinuation(turnId: string): void {
    const frames = this.buffered.get(turnId);
    if (!frames) return;
    this.buffered.delete(turnId); this.bufferedCount -= frames.length;
    this.bufferedBytes -= this.bufferedBytesByTurn.get(turnId) ?? 0;
    this.bufferedBytesByTurn.delete(turnId); this.ownedTurns.add(turnId);
    for (const frame of frames) this.deliver(frame);
  }

  private hasOpener(items: unknown): boolean {
    return Array.isArray(items) && items.some(item => record(item) && item.type === 'user_message'
      && item.placement === 'opener' && Array.isArray(item.prompt_ids) && item.prompt_ids.includes(this.promptId));
  }

  private clearBuffers(): void {
    this.buffered.clear(); this.bufferedBytesByTurn.clear(); this.excluded.clear();
    this.bufferedCount = 0; this.bufferedBytes = 0;
  }
}
