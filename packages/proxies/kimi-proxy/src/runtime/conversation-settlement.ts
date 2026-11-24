type Frame = Record<string, unknown>;

/** A native turn ending is not proof that its background work has finished.
 * Require fresh agent/task facts after every reconnect before finalizing. */
export class KimiConversationSettlement {
  private readonly runningTasks = new Set<string>();
  private haveTaskSnapshot = false;
  private agentIdle = false;
  private turnEnded = false;
  private nativeBusy: boolean | null = null;
  private sawTask = false;

  constructor(private readonly sessionId: string) {}

  turnStarted(): void { this.turnEnded = false; this.agentIdle = false; this.nativeBusy = null; }
  turnFinished(): void { this.turnEnded = true; }

  disconnected(): void {
    this.haveTaskSnapshot = false;
    this.agentIdle = false;
    this.turnEnded = false;
    this.nativeBusy = null;
    this.sawTask = false;
    this.runningTasks.clear();
  }

  receive(frame: Frame): void {
    if (frame.session_id !== this.sessionId) return;
    if (frame.type === 'session') {
      // 2.7 global session event: {change, session:{id, activity,
      // pending_interaction?}}. `activity` is turn/background/idle.
      const session = frame.session;
      if (typeof session !== 'object' || session === null || Array.isArray(session)) throw new Error('Invalid Kimi session work state.');
      const work = session as Frame;
      if (work.id !== this.sessionId || !['idle', 'turn', 'background'].includes(String(work.activity))
        || (work.pending_interaction !== undefined && !['none', 'approval', 'question'].includes(String(work.pending_interaction)))) {
        throw new Error('Invalid Kimi session work state.');
      }
      this.nativeBusy = work.activity !== 'idle'
        || work.pending_interaction === 'approval' || work.pending_interaction === 'question';
      return;
    }
    if (frame.agent_id !== 'main') return;
    if (frame.type === 'agent') {
      // 2.7 adds `ended` when the main agent closes (idle reclaim, reload):
      // it can no longer run work, so it counts as idle.
      if (frame.status !== 'idle' && frame.status !== 'running' && frame.status !== 'ended') throw new Error('Invalid Kimi agent state.');
      this.agentIdle = frame.status !== 'running';
    } else if (frame.type === 'task.list') {
      if (!Array.isArray(frame.tasks)) throw new Error('Invalid Kimi task snapshot.');
      const next = new Set<string>();
      for (const item of frame.tasks) {
        if (typeof item !== 'object' || item === null || Array.isArray(item)) throw new Error('Invalid Kimi task state.');
        const task = item as Frame;
        if (typeof task.task_id !== 'string' || !task.task_id || task.status !== 'running' || next.has(task.task_id)) throw new Error('Invalid Kimi running task.');
        next.add(task.task_id);
      }
      this.runningTasks.clear();
      for (const id of next) this.runningTasks.add(id);
      if (next.size > 0) this.sawTask = true;
      this.haveTaskSnapshot = true;
    } else if (frame.type === 'task') {
      if (typeof frame.task_id !== 'string' || !frame.task_id || (frame.status !== 'running' && frame.status !== 'ended')) throw new Error('Invalid Kimi task state.');
      if (frame.status === 'ended' && !['completed', 'failed', 'timed_out', 'killed', 'lost'].includes(String(frame.outcome))) throw new Error('Kimi ended task has no recognized outcome.');
      if (this.nativeBusy === false) this.nativeBusy = null;
      if (frame.status === 'running') { this.runningTasks.add(frame.task_id); this.sawTask = true; }
      else this.runningTasks.delete(frame.task_id);
    }
  }

  canFinish(hasPendingOrUnboundInteractions: boolean): boolean {
    return this.turnEnded && this.haveTaskSnapshot && this.agentIdle
      && this.runningTasks.size === 0 && !hasPendingOrUnboundInteractions
      && this.nativeBusy !== true && (!this.sawTask || this.nativeBusy === false);
  }
}
