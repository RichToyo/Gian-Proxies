/** Control messages for Kimi's unsequenced conversation feed introduced in
 * 2.6.2. Conversation and interaction events retain their native identities;
 * no local cursor is represented as an upstream sequence number. */

type Frame = Record<string, unknown>;

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function conversationSubscription(type: 'subscribe' | 'unsubscribe', requestId: string, sessionId: string): Frame {
  if (!nonempty(requestId) || !nonempty(sessionId)) throw new Error('Kimi conversation subscription requires request and session IDs.');
  return { type, request_id: requestId, session_id: sessionId };
}

export type ConversationControl =
  | { type: 'ping' }
  | { type: 'response'; requestId: string; code: number; message?: string }
  | { type: 'other'; frame: Frame };

export function parseConversationControl(raw: string): ConversationControl {
  const value: unknown = JSON.parse(raw);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid Kimi conversation frame.');
  const frame = value as Frame;
  if (frame.type === 'ping') return { type: 'ping' };
  if (frame.type === 'response') {
    if (!nonempty(frame.request_id) || !Number.isInteger(frame.code)
      || (frame.msg !== undefined && typeof frame.msg !== 'string')) {
      throw new Error('Invalid Kimi conversation response.');
    }
    return { type: 'response', requestId: frame.request_id, code: frame.code as number,
      ...(typeof frame.msg === 'string' ? { message: frame.msg } : {}) };
  }
  if (!nonempty(frame.type)) throw new Error('Kimi conversation frame has no type.');
  return { type: 'other', frame };
}
