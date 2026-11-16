import { createHash } from 'node:crypto';
import { projectConversationItem } from './conversation-item.js';

type Frame = Record<string, unknown>;
type Content = { kind: 'text' | 'reasoning'; text: string };
type Notification = { method: string; params: Record<string, unknown> };

function id(value: unknown): value is string { return typeof value === 'string' && value !== ''; }
function object(value: unknown): value is Frame { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16); }

/** Stream native 2.6.2 text items for one already-bound turn. The local offset
 * is used only for Gian event identity; it is never presented as a native seq. */
export class KimiConversationContent {
  private readonly items = new Map<string, Content>();
  private readonly completed = new Map<string, string>();

  constructor(private readonly context: { sessionId: string; nativeSessionId: string; streamId: string;
    turnId: string; promptId: string; nextSequence: () => number; emit: (notification: Notification) => void }) {}

  /** Reconcile a fresh native snapshot after reconnect without replaying text
   * already delivered or guessing when its prefix does not match. */
  hydrate(item: Frame, emittedAt: string): void {
    if (item.type !== 'assistant_message' && item.type !== 'reasoning') return;
    if (!id(item.item_id) || typeof item.text !== 'string' || !id(emittedAt)) throw new Error('Invalid Kimi content snapshot.');
    if (item.status === 'ended') { this.receive({ type: 'item.ended', item, event_created_at: emittedAt }); return; }
    if (item.status !== 'running' || this.completed.has(item.item_id)) throw new Error('Invalid Kimi running content snapshot.');
    const state = this.items.get(item.item_id);
    if (!state) { this.receive({ type: 'item.started', item, event_created_at: emittedAt }); return; }
    const kind = item.type === 'assistant_message' ? 'text' : 'reasoning';
    if (state.kind !== kind || !item.text.startsWith(state.text)) throw new Error('Kimi content snapshot differs from the delivered prefix.');
    this.append(item.item_id, state, item.text.slice(state.text.length), emittedAt);
  }

  receive(frame: Frame): void {
    if (!id(frame.event_created_at)) throw new Error('Kimi content frame has no native event time.');
    if (frame.type === 'item.started') {
      if (!object(frame.item) || !id(frame.item.item_id)) throw new Error('Invalid Kimi content item.');
      const kind = frame.item.type === 'assistant_message' ? 'text' : frame.item.type === 'reasoning' ? 'reasoning' : null;
      if (kind === null) return;
      if (typeof frame.item.text !== 'string' || this.items.has(frame.item.item_id)) throw new Error('Invalid or repeated Kimi content start.');
      const state: Content = { kind, text: '' };
      this.items.set(frame.item.item_id, state);
      this.append(frame.item.item_id, state, frame.item.text, frame.event_created_at);
      return;
    }
    if (frame.type === 'item.delta') {
      if (!id(frame.item_id) || typeof frame.delta !== 'string') throw new Error('Invalid Kimi content delta.');
      if (frame.field !== 'text') return;
      const state = this.items.get(frame.item_id);
      if (!state || this.completed.has(frame.item_id)) throw new Error('Kimi content delta has no open item.');
      this.append(frame.item_id, state, frame.delta, frame.event_created_at);
      return;
    }
    if (frame.type !== 'item.ended' || !object(frame.item)) return;
    if (frame.item.type !== 'assistant_message' && frame.item.type !== 'reasoning') return;
    if (!id(frame.item.item_id) || typeof frame.item.text !== 'string') throw new Error('Invalid Kimi terminal content.');
    const itemId = frame.item.item_id;
    const priorCompletion = this.completed.get(itemId);
    const state = this.items.get(itemId);
    if (!priorCompletion && state && !frame.item.text.startsWith(state.text)) throw new Error('Kimi terminal content differs from the streamed prefix.');
    if (!priorCompletion && state) this.append(itemId, state, frame.item.text.slice(state.text.length), frame.event_created_at);
    const projection = projectConversationItem(this.context.nativeSessionId, this.context.promptId, frame.item);
    if (!projection || projection.method !== 'content.completed') throw new Error('Kimi terminal content is not complete.');
    if (priorCompletion === projection.eventId) return;
    this.completed.set(itemId, projection.eventId);
    this.emit(projection.method, projection.eventId, projection.data, frame.event_created_at);
  }

  private append(itemId: string, state: Content, delta: string, time: string): void {
    if (!delta) return;
    const offset = state.text.length;
    state.text += delta;
    const eventId = `evt-${digest([this.context.nativeSessionId, this.context.promptId, itemId, 'content.delta', offset, delta])}`;
    this.emit('content.delta', eventId, { contentId: `kimi:${this.context.promptId}:${itemId}`, kind: state.kind, delta }, time);
  }

  private emit(method: string, eventId: string, data: Record<string, unknown>, emittedAt: string): void {
    this.context.emit({ method, params: { eventId, data, emittedAt, sessionId: this.context.sessionId,
      streamId: this.context.streamId, turnId: this.context.turnId, sourceTurnId: this.context.promptId,
      sequence: this.context.nextSequence() } });
  }
}
