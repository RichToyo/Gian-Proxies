import { projectConversationItem } from './conversation-item.js';

type Frame = Record<string, unknown>;
type Notification = { method: string; params: Record<string, unknown> };
function object(value: unknown): value is Frame { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function id(value: unknown): value is string { return typeof value === 'string' && value !== ''; }

/** Materialize tool facts only after the native turn has been attributed to
 * this prompt. Permission association identifies requests but never answers. */
export class KimiConversationTools {
  private readonly items = new Map<string, Frame>();
  private readonly lastEvent = new Map<string, string>();
  constructor(private readonly context: { sessionId: string; nativeSessionId: string; streamId: string;
    turnId: string; promptId: string; nextSequence: () => number; emit: (notification: Notification) => void;
    associateInteraction: (toolId: string, interactionId?: string, taskId?: string) => void }) {}

  receive(frame: Frame): void {
    if (!id(frame.event_created_at)) throw new Error('Kimi tool frame has no native event time.');
    let item: Frame;
    if (frame.type === 'item.started' || frame.type === 'item.ended') {
      if (!object(frame.item)) throw new Error('Invalid Kimi tool item.');
      if (frame.item.type !== 'tool_call') return;
      if (!id(frame.item.item_id)) throw new Error('Invalid Kimi tool identity.');
      item = structuredClone(frame.item);
      this.items.set(frame.item.item_id, item);
    } else if (frame.type === 'item.updated') {
      if (!id(frame.item_id) || !object(frame.set) || Object.hasOwn(frame.set, 'item_id') || Object.hasOwn(frame.set, 'type')) throw new Error('Invalid Kimi tool update.');
      const existing = this.items.get(frame.item_id);
      if (!existing) throw new Error('Kimi tool update has no known item.');
      Object.assign(existing, structuredClone(frame.set));
      item = existing;
    } else if (frame.type === 'item.delta') {
      if (frame.field !== 'input_text' && frame.field !== 'output') return;
      if (!id(frame.item_id) || typeof frame.delta !== 'string') throw new Error('Invalid Kimi tool delta.');
      const existing = this.items.get(frame.item_id);
      if (!existing) throw new Error('Kimi tool delta has no known item.');
      const previous = existing[frame.field];
      if (previous !== undefined && typeof previous !== 'string') throw new Error('Invalid Kimi tool delta state.');
      const next = (previous ?? '') + frame.delta;
      if (Buffer.byteLength(next, 'utf8') > 32 * 1024 * 1024) throw new Error('Kimi tool output exceeds its buffer budget.');
      existing[frame.field] = next;
      item = existing;
    } else return;
    const toolId = item.item_id as string;
    this.context.associateInteraction(toolId, id(item.interaction_id) ? item.interaction_id : undefined,
      id(item.task_id) ? item.task_id : undefined);
    const projection = projectConversationItem(this.context.nativeSessionId, this.context.promptId, item);
    if (!projection || projection.method !== 'activity.updated') throw new Error('Kimi tool item has no valid projection.');
    if (this.lastEvent.get(toolId) === projection.eventId) return;
    this.lastEvent.set(toolId, projection.eventId);
    this.context.emit({ method: projection.method, params: { eventId: projection.eventId, data: projection.data,
      emittedAt: frame.event_created_at, sessionId: this.context.sessionId, streamId: this.context.streamId,
      turnId: this.context.turnId, sourceTurnId: this.context.promptId, sequence: this.context.nextSequence() } });
  }
}
