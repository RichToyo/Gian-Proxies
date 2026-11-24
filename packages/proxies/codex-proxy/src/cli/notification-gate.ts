/**
 * Per-session Response-before-Notification ordering.
 *
 * Sessions run concurrently on their own kit lanes, so one process-wide
 * capture slot would mix their notifications. Instead each in-flight
 * request holds only the sessions it acts on: a notification for a held
 * session is queued and written, in emission order, once the last request
 * holding that session has been answered. Every other notification (other
 * sessions' streaming turns, session-less events) is written at once, so a
 * slow request in one session never delays another session's stream.
 */

export type NotificationWriter = (method: string, params: Record<string, unknown>) => void;

interface Hold {
  count: number;
  queue: Array<{ method: string; params: Record<string, unknown> }>;
}

export class SessionNotificationGate {
  private readonly holds = new Map<string, Hold>();

  constructor(private readonly write: NotificationWriter) {}

  emit(method: string, params: Record<string, unknown>): void {
    const key = typeof params.sessionId === 'string' ? params.sessionId : null;
    const hold = key === null ? undefined : this.holds.get(key);
    if (hold) hold.queue.push({ method, params });
    else this.write(method, params);
  }

  /** Hold the given sessions until the returned release is called (once). */
  hold(keys: readonly string[]): () => void {
    const unique = [...new Set(keys)];
    for (const key of unique) {
      const hold = this.holds.get(key) ?? { count: 0, queue: [] };
      hold.count += 1;
      this.holds.set(key, hold);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const key of unique) {
        const hold = this.holds.get(key);
        if (!hold) continue;
        hold.count -= 1;
        if (hold.count > 0) continue;
        this.holds.delete(key);
        for (const notification of hold.queue) this.write(notification.method, notification.params);
      }
    };
  }

  /** Write what is queued for these sessions now, keeping the holds. Used by
   *  sidechat.close, whose teardown notifications precede its Response
   *  (Contract §10.5.4). */
  flush(keys: readonly string[]): void {
    for (const key of new Set(keys)) {
      const hold = this.holds.get(key);
      if (!hold) continue;
      for (const notification of hold.queue.splice(0)) this.write(notification.method, notification.params);
    }
  }
}

/** Sessions a request acts on: its session, or the Side Chat it targets. */
export function requestSessionKeys(params: Record<string, unknown>): string[] {
  return [params.sessionId, params.sidechatId]
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
}
