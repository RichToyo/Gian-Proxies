import { conversationSubscription, parseConversationControl } from './conversation-wire.js';

type Frame = Record<string, unknown>;
type Pending = { sessionId: string; operation: 'subscribe' | 'unsubscribe'; acknowledged: boolean; resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

/** One connected Kimi 2.7 socket. The owner creates a fresh channel after a
 * disconnect and re-subscribes; the native server then sends a new snapshot. */
export class KimiConversationChannel {
  private nextRequest = 1;
  private readonly pending = new Map<string, Pending>();
  private readonly active = new Set<string>();
  private readonly synchronized = new Set<string>();
  private closed = false;

  constructor(private readonly send: (frame: Frame) => void,
    private readonly deliver: (frame: Frame) => void,
    private readonly timeoutMs = 10_000) {}

  async subscribe(sessionId: string): Promise<void> {
    return this.request('subscribe', sessionId);
  }

  /** Repeating subscribe on an attached native feed may not resend a page.
   * At the idle prompt boundary, detach and reattach to obtain a fresh page. */
  async refresh(sessionId: string): Promise<void> {
    if (this.synchronized.has(sessionId)) await this.request('unsubscribe', sessionId);
    await this.request('subscribe', sessionId);
  }

  private async request(operation: 'subscribe' | 'unsubscribe', sessionId: string): Promise<void> {
    if (this.closed) throw new Error('Kimi conversation channel is closed.');
    const requestId = `gian-${this.nextRequest++}`;
    const frame = conversationSubscription(operation, requestId, sessionId);
    const ack = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('Kimi conversation subscription timed out.'));
      }, this.timeoutMs);
      timer.unref();
      this.pending.set(requestId, { sessionId, operation, acknowledged: false, resolve, reject, timer });
    });
    try { this.send(frame); } catch (error) {
      const pending = this.pending.get(requestId);
      if (pending) { clearTimeout(pending.timer); this.pending.delete(requestId); }
      // Consume the otherwise unreachable promise if sending failed.
      void ack.catch(() => undefined);
      throw error;
    }
    return ack;
  }

  receive(raw: string): void {
    if (this.closed) return;
    const message = parseConversationControl(raw);
    if (message.type === 'ping') { this.send({ type: 'pong' }); return; }
    if (message.type === 'response') {
      const pending = this.pending.get(message.requestId);
      if (!pending) return;
      if (message.code === 0 && pending.operation === 'unsubscribe') {
        clearTimeout(pending.timer); this.pending.delete(message.requestId);
        this.active.delete(pending.sessionId); this.synchronized.delete(pending.sessionId); pending.resolve();
      } else if (message.code === 0) { pending.acknowledged = true; this.active.add(pending.sessionId); }
      else {
        clearTimeout(pending.timer); this.pending.delete(message.requestId);
        pending.reject(new Error(`Kimi conversation subscription rejected (${message.code}).`));
      }
      return;
    }
    if (message.frame.type === 'session') {
      // 2.7 publishes session work state as an unwrapped global event to
      // every connection; only attached sessions are delivered, tagged with
      // their native id like every per-session frame.
      const session = message.frame.session;
      if (typeof session !== 'object' || session === null || Array.isArray(session)) return;
      const nativeId = (session as Frame).id;
      if (typeof nativeId === 'string' && this.active.has(nativeId)) this.deliver({ ...message.frame, session_id: nativeId });
      return;
    }
    const sessionId = message.frame.session_id;
    if (typeof sessionId !== 'string' || !this.active.has(sessionId)) return;
    if (message.frame.type === 'turns' && (!Array.isArray(message.frame.turns) || typeof message.frame.has_more !== 'boolean')) {
      throw new Error('Invalid Kimi conversation snapshot.');
    }
    this.deliver(message.frame);
    if (message.frame.agent_id !== 'main' || (message.frame.type !== 'turns' && message.frame.type !== 'turns.failed')) return;
    if (message.frame.type === 'turns') this.synchronized.add(sessionId);
    else this.synchronized.delete(sessionId);
    for (const [requestId, pending] of this.pending) {
      if (pending.sessionId !== sessionId || pending.operation !== 'subscribe' || !pending.acknowledged) continue;
      clearTimeout(pending.timer); this.pending.delete(requestId);
      if (message.frame.type === 'turns') pending.resolve();
      else pending.reject(new Error('Kimi conversation snapshot failed.'));
    }
  }

  forget(sessionId: string): void {
    this.active.delete(sessionId);
    this.synchronized.delete(sessionId);
    for (const [requestId, pending] of this.pending) {
      if (pending.sessionId !== sessionId) continue;
      clearTimeout(pending.timer);
      this.pending.delete(requestId);
      pending.reject(new Error('Kimi conversation subscription was detached.'));
    }
    if (!this.closed) this.send(conversationSubscription('unsubscribe', `gian-${this.nextRequest++}`, sessionId));
  }

  close(): void {
    this.closed = true;
    this.active.clear();
    this.synchronized.clear();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Kimi conversation channel closed before subscription was acknowledged.'));
    }
    this.pending.clear();
  }
}
