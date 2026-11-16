/** Materialize one Kimi 2.6.2 agent's native conversation feed. The feed is
 * unsequenced: reconnect replaces state with a fresh `turns` snapshot rather
 * than reusing the pre-2.6 cursor protocol. */
type NativeObject = Record<string, unknown>;

function object(value: unknown): value is NativeObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export class KimiConversationState {
  private turns: NativeObject[] = [];
  private synchronized = false;

  constructor(private readonly sessionId: string, private readonly agentId: string) {}

  /** Return a detached view; callers cannot mutate the replay baseline. */
  snapshot(): NativeObject[] { return structuredClone(this.turns); }

  /** Unexpected ordering requires a new native snapshot; dropping an update
   * would silently corrupt resumed history. Foreign sessions/agents are ignored. */
  apply(frame: NativeObject): 'applied' | 'ignored' | 'resync' {
    if (frame.session_id !== this.sessionId || frame.agent_id !== this.agentId) return 'ignored';
    if (frame.type === 'turns') {
      if (!Array.isArray(frame.turns) || !frame.turns.every(turn => object(turn) && id(turn.turn_id) && Array.isArray(turn.items))) return this.invalidate();
      this.turns = structuredClone(frame.turns);
      this.synchronized = true;
      return 'applied';
    }
    if (frame.type === 'turns.failed') return this.invalidate();
    if (!this.synchronized) return 'resync';
    if (frame.type === 'turns.removed') {
      if (!Array.isArray(frame.turn_ids) || !frame.turn_ids.every(id)) return this.invalidate();
      const removed = frame.turn_ids;
      this.turns = this.turns.filter(turn => !id(turn.turn_id) || !removed.includes(turn.turn_id));
      return 'applied';
    }
    if (frame.type === 'turn.started' || frame.type === 'turn.ended') {
      if (!object(frame.turn) || !id(frame.turn.turn_id) || typeof frame.turn.ordinal !== 'number') return this.invalidate();
      const nativeTurn = frame.turn;
      const index = this.turns.findIndex(turn => turn.turn_id === nativeTurn.turn_id);
      const existing = index < 0 ? undefined : this.turns[index];
      const next = { ...structuredClone(frame.turn), items: existing?.items ?? [] };
      if (index < 0) this.turns.push(next); else this.turns[index] = next;
      this.turns.sort((a, b) => Number(a.ordinal) - Number(b.ordinal));
      return 'applied';
    }
    if (!['turn.updated', 'item.started', 'item.ended', 'item.updated', 'item.delta', 'item.removed'].includes(String(frame.type))) return 'ignored';
    if (!id(frame.turn_id)) return this.invalidate();
    const turn = this.turns.find(value => value.turn_id === frame.turn_id);
    if (!turn || !Array.isArray(turn.items)) return this.invalidate();
    if (frame.type === 'turn.updated') {
      if (frame.step !== undefined) {
        if (!object(frame.step) || typeof frame.step.index !== 'number' || !Array.isArray(turn.steps)) return this.invalidate();
        const nextStep = frame.step;
        turn.steps = [...turn.steps.filter(step => object(step) && step.index !== nextStep.index), structuredClone(nextStep)]
          .sort((a, b) => Number(a.index) - Number(b.index));
      }
      if (frame.retry === undefined) delete turn.retry; else turn.retry = structuredClone(frame.retry);
      return 'applied';
    }
    if (frame.type === 'item.started' || frame.type === 'item.ended') {
      if (!object(frame.item) || !id(frame.item.item_id)) return this.invalidate();
      const nativeItem = frame.item;
      const index = turn.items.findIndex(item => object(item) && item.item_id === nativeItem.item_id);
      if (index < 0) turn.items.push(structuredClone(frame.item)); else turn.items[index] = structuredClone(frame.item);
      return 'applied';
    }
    if (!id(frame.item_id)) return this.invalidate();
    const index = turn.items.findIndex(item => object(item) && item.item_id === frame.item_id);
    if (index < 0) return this.invalidate();
    if (frame.type === 'item.removed') { turn.items.splice(index, 1); return 'applied'; }
    const item = turn.items[index] as NativeObject;
    if (frame.type === 'item.updated') {
      if (!object(frame.set)) return this.invalidate();
      Object.assign(item, structuredClone(frame.set));
    } else {
      if (!['text', 'input_text', 'output'].includes(String(frame.field)) || typeof frame.delta !== 'string') return this.invalidate();
      const field = frame.field as string;
      if (item[field] !== undefined && typeof item[field] !== 'string') return this.invalidate();
      item[field] = (item[field] ?? '') + frame.delta;
    }
    return 'applied';
  }

  private invalidate(): 'resync' { this.synchronized = false; return 'resync'; }
}
