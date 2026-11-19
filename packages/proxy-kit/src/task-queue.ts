/** Per-process dispatch queue for a Proxy's request loop.
 *
 *  Three traffic classes share one Proxy process:
 *  - Session-scoped requests are STRICTLY serialized within their lane: the
 *    next task of a lane starts only after the previous one has settled. That
 *    is what keeps the request-scoped notification capture slot from being
 *    clobbered by a concurrent session handler, and what preserves
 *    shutdown/sidechat ordering. By default every session request shares one
 *    lane; a Proxy that serializes per session passes a lane key instead, and
 *    different lanes then run concurrently.
 *  - Pipelined requests (e.g. customization scans) dispatch concurrently and
 *    never wait on a session lane: a slow scan must not block live session
 *    traffic and session traffic must never block a scan.
 *  - Barrier requests (e.g. `initialize`) start only after every tracked task
 *    has settled, and every task enqueued after a barrier waits for it.
 *
 *  Every dispatched task is tracked for EOF/shutdown drain. Tasks that reject
 *  (a dispatch or writer exception escaping its own error path) are cleaned
 *  up via `then(success, failure)`: no derived `finally` promise is left
 *  unhandled, the rejecting task is removed from the in-flight set, and the
 *  queue keeps serving subsequent tasks (a rejected task never poisons the
 *  chain).
 */
export interface TaskQueue {
  /** Enqueue a session-scoped task. Starts only after every previously
   *  enqueued task of the same lane, and any earlier barrier, has settled.
   *  Omitting `lane` uses the single default lane. */
  enqueueSession(task: () => Promise<void>, lane?: string): void;
  /** Dispatch a pipelined task. It never waits on a session lane and never
   *  blocks session tasks; it only waits for an earlier barrier. */
  enqueuePipelined(task: () => Promise<void>): void;
  /** Enqueue a barrier task: it starts once every tracked task has settled,
   *  and every task enqueued after it waits for it to settle. */
  enqueueBarrier(task: () => Promise<void>): void;
  /** Number of tracked tasks that have not yet settled (any outcome). */
  pendingCount(): number;
  /** Resolves once every tracked task has settled. */
  drain(): Promise<void>;
}

const DEFAULT_LANE = '';

export function createTaskQueue(tag: string): TaskQueue {
  const lanes = new Map<string, Promise<void>>();
  const inFlight = new Set<Promise<void>>();
  // Settles when the latest barrier has settled. `barrierPending` lets work
  // start synchronously when no barrier is outstanding, exactly as before
  // barriers existed.
  let barrier: Promise<void> = Promise.resolve();
  let barrierPending = 0;

  const absorb = (task: Promise<void>): Promise<void> => task.then(
    () => undefined,
    () => undefined,
  );

  const track = (task: Promise<void>): void => {
    inFlight.add(task);
    task.then(
      () => inFlight.delete(task),
      (error) => {
        inFlight.delete(task);
        // A task that escapes its own error handling must never become an
        // unhandled rejection that kills the shared process mid-drain.
        console.error(`[${tag}:task]`, error instanceof Error ? error.message : String(error));
      },
    );
  };

  return {
    enqueueSession(task, lane = DEFAULT_LANE) {
      const previous = lanes.get(lane) ?? Promise.resolve();
      const start = barrierPending > 0 ? Promise.all([previous, barrier]) : previous;
      const queued = start.then(task);
      // Absorb the outcome so a rejecting task never poisons the chain, and
      // register exactly one continuation (the queued promise) for tracking.
      const tail = absorb(queued);
      lanes.set(lane, tail);
      void tail.then(() => {
        if (lanes.get(lane) === tail) lanes.delete(lane);
      });
      track(queued);
    },
    enqueuePipelined(task) {
      track(barrierPending > 0 ? barrier.then(task) : task());
    },
    enqueueBarrier(task) {
      const prior = Promise.allSettled([...inFlight, barrier]);
      const queued = prior.then(task);
      barrierPending += 1;
      barrier = absorb(queued);
      void barrier.then(() => {
        barrierPending -= 1;
      });
      track(queued);
    },
    pendingCount: () => inFlight.size,
    async drain() {
      while (inFlight.size > 0) {
        await Promise.allSettled([...inFlight]);
      }
    },
  };
}
