type Frame = Record<string, unknown>;
const MAX_PENDING = 4_096;
const MAX_PENDING_BYTES = 32 * 1024 * 1024;

/** Interaction snapshots can arrive immediately after subscription, before
 * the conversation item that identifies their owning tool. Hold them until
 * an already-bound native turn proves ownership; never answer them here. */
export class KimiInteractionOwnership {
  private readonly tools = new Set<string>();
  private readonly interactions = new Set<string>();
  private readonly unbound: Frame[] = [];
  private pendingBytes = 0;

  constructor(private readonly sessionId: string, private readonly deliver: (frame: Frame) => void) {}

  associate(toolCallId: string, interactionId?: string): void {
    if (!toolCallId) throw new Error('Kimi tool ownership requires a native tool ID.');
    this.tools.add(toolCallId);
    if (interactionId) this.interactions.add(interactionId);
    for (let i = 0; i < this.unbound.length;) {
      const frame = this.unbound[i]!;
      if (!this.owned(frame)) { i += 1; continue; }
      this.unbound.splice(i, 1);
      if (typeof frame.interaction_id === 'string') this.interactions.add(frame.interaction_id);
      this.pendingBytes -= Buffer.byteLength(JSON.stringify(frame), 'utf8');
      this.deliver(frame);
    }
  }

  receive(frame: Frame): void {
    if (frame.type !== 'interaction' || frame.session_id !== this.sessionId || frame.agent_id !== 'main') return;
    if (typeof frame.interaction_id !== 'string' || frame.interaction_id === ''
      || (frame.kind !== 'approval' && frame.kind !== 'question')
      || (frame.status !== 'pending' && frame.status !== 'ended')) throw new Error('Invalid Kimi interaction frame.');
    // Once a pending interaction is owned, its later `ended` frame is too,
    // even if that frame omits the tool identity.
    if (this.owned(frame)) { this.interactions.add(frame.interaction_id); this.deliver(frame); return; }
    const bytes = Buffer.byteLength(JSON.stringify(frame), 'utf8');
    if (this.unbound.length >= MAX_PENDING || this.pendingBytes + bytes > MAX_PENDING_BYTES) throw new Error('Kimi interaction ownership buffer overflow.');
    this.unbound.push(frame);
    this.pendingBytes += bytes;
  }

  /** Unknown pending work must be reconciled, not silently assumed complete. */
  hasUnbound(): boolean { return this.unbound.length > 0; }

  private owned(frame: Frame): boolean {
    return (typeof frame.tool_call_id === 'string' && this.tools.has(frame.tool_call_id))
      || (typeof frame.interaction_id === 'string' && this.interactions.has(frame.interaction_id));
  }
}
