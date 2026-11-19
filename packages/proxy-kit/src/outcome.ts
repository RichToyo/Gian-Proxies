import type { NotificationEmitter } from './server.js';
import type { JsonRpcErrorObject } from './writer.js';

/** Result of an adapter whose `dispatch` returns the notifications its own
 * request produced instead of emitting them. */
export interface DispatchOutcome {
  ok: boolean;
  result?: unknown;
  error?: unknown;
  notifications: ReadonlyArray<{ method: string; params: Record<string, unknown> }>;
}

/** Hands a dispatch outcome to the kit: the request's notifications go
 * through the ordered `emit`, a failure is thrown for the error mapper. */
export function resolveDispatchOutcome(outcome: DispatchOutcome, emit: NotificationEmitter): unknown {
  for (const notification of outcome.notifications) {
    emit(notification.method, notification.params);
  }
  if (!outcome.ok || outcome.error !== undefined) throw outcome.error;
  return outcome.result;
}

export function isJsonRpcErrorObject(value: unknown): value is JsonRpcErrorObject {
  return typeof value === 'object'
    && value !== null
    && Number.isSafeInteger((value as { code?: unknown }).code)
    && typeof (value as { message?: unknown }).message === 'string';
}
