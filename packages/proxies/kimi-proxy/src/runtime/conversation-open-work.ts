/**
 * Work a turn has reported as still open.
 *
 * gian.proxy requires every activity that entered `running`, every running
 * step and every content stream of a turn to be terminal before its
 * turn.completed or turn.failed; the Host treats anything else as a protocol
 * violation and quarantines the turn. Kimi's own feed normally closes them,
 * but not always: a task's end can be lost across a reconnect, and a fenced
 * or abandoned turn ends without its native terminal. The turn records what
 * it emitted here and closes whatever is still open right before its own
 * terminal.
 */

type Frame = Record<string, unknown>;
type Notification = { method: string; params: Frame };

const TERMINAL_ACTIVITY = new Set(['succeeded', 'failed', 'cancelled']);
const TERMINAL_STEP = new Set(['completed', 'failed']);

function object(value: unknown): value is Frame { return typeof value === 'object' && value !== null && !Array.isArray(value); }

export type OpenWorkOutcome = 'succeeded' | 'failed' | 'cancelled';

export interface ClosingEvent { method: 'activity.updated' | 'step.updated' | 'content.completed'; key: string; data: Frame }

export class KimiOpenWork {
  private readonly activities = new Map<string, Frame>();
  private readonly steps = new Map<string, Frame>();
  private readonly contents = new Map<string, { kind: unknown; format?: unknown; stepId?: unknown; text: string }>();

  observe(notification: Notification): void {
    const data = object(notification.params.data) ? notification.params.data : null;
    if (!data) return;
    if (notification.method === 'activity.updated' && typeof data.activityId === 'string') {
      if (TERMINAL_ACTIVITY.has(String(data.status))) this.activities.delete(data.activityId);
      else this.activities.set(data.activityId, structuredClone(data));
    } else if (notification.method === 'step.updated' && typeof data.stepId === 'string') {
      if (TERMINAL_STEP.has(String(data.status))) this.steps.delete(data.stepId);
      else this.steps.set(data.stepId, structuredClone(data));
    } else if (notification.method === 'content.delta' && typeof data.contentId === 'string') {
      const open = this.contents.get(data.contentId)
        ?? { kind: data.kind, ...(data.format !== undefined ? { format: data.format } : {}), ...(data.stepId !== undefined ? { stepId: data.stepId } : {}), text: '' };
      open.text += typeof data.delta === 'string' ? data.delta : '';
      this.contents.set(data.contentId, open);
    } else if (notification.method === 'content.completed' && typeof data.contentId === 'string') {
      this.contents.delete(data.contentId);
    }
  }

  hasOpenWork(): boolean { return this.activities.size > 0 || this.steps.size > 0 || this.contents.size > 0; }

  /** Terminal events for everything still open: content first, then
   *  activities, then steps, so nothing is left open when the turn ends. */
  closing(outcome: OpenWorkOutcome): ClosingEvent[] {
    const events: ClosingEvent[] = [];
    for (const [contentId, open] of this.contents) {
      events.push({ method: 'content.completed', key: contentId, data: { contentId, kind: open.kind,
        ...(open.format !== undefined ? { format: open.format } : {}),
        ...(open.stepId !== undefined ? { stepId: open.stepId } : {}),
        content: open.text } });
    }
    for (const [activityId, last] of this.activities) {
      const presentation = object(last.presentation) ? structuredClone(last.presentation) : last.presentation;
      if (object(presentation) && presentation.type === 'agent' && object(presentation.data)) {
        presentation.data.state = outcome === 'succeeded' ? 'completed' : outcome === 'failed' ? 'failed' : 'interrupted';
      }
      events.push({ method: 'activity.updated', key: activityId, data: { ...last, status: outcome, presentation } });
    }
    for (const [stepId, last] of this.steps) {
      events.push({ method: 'step.updated', key: stepId, data: { ...last, status: outcome === 'succeeded' ? 'completed' : 'failed' } });
    }
    return events;
  }
}
