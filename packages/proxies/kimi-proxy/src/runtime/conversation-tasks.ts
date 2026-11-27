import { createHash } from 'node:crypto';

type Frame = Record<string, unknown>;
type Notification = { method: string; params: Frame };
function object(value: unknown): value is Frame { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function id(value: unknown): value is string { return typeof value === 'string' && value !== ''; }
function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16); }

/** Track native background work only when its parent tool belongs to this
 * admitted turn. Unowned work remains a settlement concern, not an activity. */
export class KimiConversationTasks {
  private readonly tools = new Set<string>();
  private readonly observed = new Map<string, Frame>();
  private readonly lastEvent = new Map<string, string>();
  private readonly ownedTasks = new Set<string>();
  /** Owned tasks last projected as running. */
  private readonly projectedRunning = new Set<string>();
  constructor(private readonly context: { sessionId: string; nativeSessionId: string; streamId: string;
    turnId: string; promptId: string; nextSequence: () => number; emit: (notification: Notification) => void;
    onOwnedTask?: (taskId: string) => void }) {}

  ownsTask(taskId: string): boolean { return this.ownedTasks.has(taskId); }

  associateTool(toolId: string, nativeTaskId?: string): void {
    if (!toolId) throw new Error('Kimi task ownership requires a native tool ID.');
    this.tools.add(toolId);
    if (nativeTaskId && !this.ownedTasks.has(nativeTaskId)) {
      this.ownedTasks.add(nativeTaskId); this.context.onOwnedTask?.(nativeTaskId);
    }
    for (const task of this.observed.values()) if (task.parent_tool_call_id === toolId) this.claim(task);
  }

  receive(frame: Frame): void {
    if (frame.session_id !== this.context.nativeSessionId || frame.agent_id !== 'main') return;
    if (frame.type === 'task.list') {
      if (!Array.isArray(frame.tasks)) throw new Error('Invalid Kimi task snapshot.');
      const listed = new Set<string>();
      for (const task of frame.tasks) {
        if (!object(task)) throw new Error('Invalid Kimi task.');
        if (id(task.task_id)) listed.add(task.task_id);
        this.observe({ ...task, event_created_at: id(task.started_at) ? task.started_at : new Date().toISOString() });
      }
      // The snapshot lists every running task. One this turn showed as
      // running that is no longer listed has ended, and its own end frame was
      // lost (a reconnect): close it so the turn never ends with it open.
      for (const taskId of [...this.projectedRunning]) {
        if (listed.has(taskId)) continue;
        const last = this.observed.get(taskId);
        if (!last) continue;
        this.project({ ...last, status: 'ended', outcome: 'completed',
          result_summary: 'Kimi no longer lists this task as running; its own end was not received.',
          event_created_at: id(frame.event_created_at) ? frame.event_created_at : new Date().toISOString() });
      }
    } else if (frame.type === 'task') this.observe(frame);
  }

  private observe(task: Frame): void {
    if (!id(task.task_id) || !['shell', 'subagent', 'other'].includes(String(task.kind))
      || (task.status !== 'running' && task.status !== 'ended')) throw new Error('Invalid Kimi task state.');
    if (this.observed.size >= 4_096 && !this.observed.has(task.task_id)) throw new Error('Kimi task tracking budget exceeded.');
    this.observed.set(task.task_id, structuredClone(task));
    if (id(task.parent_tool_call_id) && this.tools.has(task.parent_tool_call_id)) this.claim(task);
  }

  private claim(task: Frame): void {
    if (!id(task.task_id)) throw new Error('Invalid Kimi task identity.');
    const first = !this.ownedTasks.has(task.task_id);
    this.ownedTasks.add(task.task_id);
    if (first) this.context.onOwnedTask?.(task.task_id);
    this.project(task);
  }

  private project(task: Frame): void {
    if (!id(task.task_id) || !id(task.event_created_at)) throw new Error('Invalid Kimi task identity.');
    let status: 'running' | 'succeeded' | 'failed' | 'cancelled';
    if (task.status === 'running') status = 'running';
    else if (task.outcome === 'completed') status = 'succeeded';
    else if (task.outcome === 'failed' || task.outcome === 'timed_out' || task.outcome === 'lost') status = 'failed';
    else if (task.outcome === 'killed') status = 'cancelled';
    else throw new Error('Kimi ended task has no recognized outcome.');
    const agentId = id(task.child_agent_id) ? task.child_agent_id : task.task_id;
    const state = status === 'running' ? 'running' : status === 'succeeded' ? 'completed' : status === 'failed' ? 'failed' : 'interrupted';
    const data = { activityId: `task:${this.context.promptId}:${task.task_id}`, kind: `task:${String(task.kind)}`,
      title: id(task.description) ? task.description : task.task_id, status,
      ...(typeof task.result_summary === 'string' ? { summary: task.result_summary } : {}),
      presentation: { type: 'agent', data: { agentId, state,
        ...(id(task.parent_tool_call_id) ? { parentToolCallId: `kimi:${this.context.promptId}:${task.parent_tool_call_id}` } : {}) } } };
    const eventId = `evt-${digest([this.context.nativeSessionId, this.context.promptId, task.task_id, data])}`;
    if (this.lastEvent.get(task.task_id) === eventId) return;
    this.lastEvent.set(task.task_id, eventId);
    if (status === 'running') this.projectedRunning.add(task.task_id); else this.projectedRunning.delete(task.task_id);
    this.context.emit({ method: 'activity.updated', params: { eventId, data, emittedAt: task.event_created_at,
      sessionId: this.context.sessionId, streamId: this.context.streamId, turnId: this.context.turnId,
      sourceTurnId: this.context.promptId, sequence: this.context.nextSequence() } });
  }
}
