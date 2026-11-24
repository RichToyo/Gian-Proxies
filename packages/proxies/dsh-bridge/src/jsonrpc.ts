/**
 * gian.dsh.bridge/1.0 JSON-RPC 2.0 transport over UTF-8 NDJSON stdio.
 *
 * Transport rules (plan §5.1):
 * - every message carries `jsonrpc:"2.0"`;
 * - request IDs are non-empty strings;
 * - batch arrays are forbidden;
 * - a single line must not exceed 16 MiB;
 * - stdout carries only bridge JSON-RPC; stderr carries sanitized diagnostics;
 * - the writer serializes output (one message per line, never interleaved).
 */

import { Buffer } from 'node:buffer';
import { Readable, Writable } from 'node:stream';
import { createInterface } from 'node:readline';

import {
  BRIDGE_NOTIFICATIONS,
  BRIDGE_PROTOCOL_NAME,
  BRIDGE_PROTOCOL_VERSION,
  MAX_BRIDGE_LINE_BYTES,
  asRecord,
  validateBridgeNotification,
  validateBridgeRequest,
  type BridgeNotification,
  type BridgeNotificationMethod,
  type BridgeRequest,
} from './schema.js';

export class BridgeProtocolError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly domainCode?: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'BridgeProtocolError';
  }
}

/** Gian domain codes a bridge error may carry; mirrors gian.proxy DOMAIN_CODES. */
const DOMAIN_CODES: ReadonlySet<string> = new Set([
  'CAPABILITY_NOT_SUPPORTED', 'SESSION_NOT_FOUND', 'SESSION_CLOSED', 'SESSION_STALE',
  'SESSION_ERROR', 'SESSION_BUSY', 'TURN_NOT_FOUND', 'INTERACTION_NOT_FOUND',
  'INTERACTION_ACTION_NOT_FOUND', 'CONFIG_REQUIRED', 'CONFIG_VALUE_INVALID',
  'CONFIG_BINDING_INVALID', 'NATIVE_SESSION_NOT_FOUND', 'SIDECHAT_UNAVAILABLE',
  'FORK_BOUNDARY_UNAVAILABLE', 'CONFLICT', 'RUNTIME_UNAVAILABLE',
  'RUNTIME_AUTH_REQUIRED', 'RUNTIME_ERROR', 'CANCELLED', 'INTERNAL',
]);

/**
 * JSON-RPC error object for a handler failure. A `BridgeProtocolError` keeps
 * its code; a plain `Error` whose message starts with `<DOMAIN_CODE>: ` (the
 * Cordis host's convention) carries that domain code instead of collapsing to
 * an anonymous -32603, so the Proxy can classify it. The message text is kept
 * verbatim.
 */
export function bridgeErrorObject(error: unknown): {
  code: number;
  message: string;
  data?: { domainCode: string; retryable: boolean; details?: Record<string, unknown> };
} {
  if (error instanceof BridgeProtocolError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.domainCode
        ? { data: { domainCode: error.domainCode, retryable: error.retryable } }
        : {}),
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  const prefix = /^([A-Z][A-Z_]+): /u.exec(message)?.[1];
  if (prefix !== undefined && DOMAIN_CODES.has(prefix)) {
    return { code: -32000, message, data: { domainCode: prefix, retryable: false } };
  }
  return { code: -32603, message };
}

export function parseBridgeLine(line: string): unknown {
  if (line.trim() === '') return null;
  const bytes = Buffer.byteLength(line, 'utf8');
  if (bytes > MAX_BRIDGE_LINE_BYTES) {
    throw new BridgeProtocolError(
      -32600,
      `NDJSON line is ${bytes} bytes; maximum is ${MAX_BRIDGE_LINE_BYTES}.`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    throw new BridgeProtocolError(
      -32700,
      `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (Array.isArray(value)) {
    throw new BridgeProtocolError(-32600, 'JSON-RPC batch arrays are not allowed.');
  }
  if (value === null || typeof value !== 'object') {
    throw new BridgeProtocolError(-32600, 'NDJSON top-level value must be an object.');
  }
  return value;
}

/** A synchronous serialized NDJSON writer. Every payload goes out on one line. */
export class BridgeWriter {
  private pending: string[] = [];

  constructor(private readonly output: Writable = process.stdout) {}

  write(value: unknown): void {
    this.pending.push(JSON.stringify(value));
    this.flush();
  }

  flush(): void {
    while (this.pending.length > 0) {
      const line = this.pending.shift();
      if (line !== undefined) this.output.write(`${line}\n`);
    }
  }

  notification(method: BridgeNotificationMethod, params: Record<string, unknown>): void {
    this.write({
      jsonrpc: '2.0',
      method,
      params,
    });
  }

  result(id: string, result: Record<string, unknown>): void {
    this.write({ jsonrpc: '2.0', id, result });
  }

  error(id: string | null, error: {
    code: number;
    message: string;
    data?: { domainCode: string; retryable: boolean; details?: Record<string, unknown> };
  }): void {
    this.write({ jsonrpc: '2.0', id, error });
  }
}

/** How `runBridgeInput` schedules requests. */
export interface BridgeSchedule {
  /** Requests with the same key run one at a time, in arrival order; `null`
   *  runs the request concurrently with everything else. */
  laneKey(request: BridgeRequest): string | null;
  /** Methods that start at once, so they can answer a native runtime blocked
   *  inside a lane request (approvals, interrupts, shutdown). */
  overtake: ReadonlySet<string>;
  /** Methods that start after every in-flight request has settled; later
   *  requests wait for them. */
  barrier: ReadonlySet<string>;
}

/**
 * The real Bridge schedule: one lane per Gian session, concurrent
 * process-level reads (catalog, quota, customization, native list),
 * overtaking interrupts/answers/shutdown, and `initialize` as a barrier. A
 * slow quota read, resume or replay therefore never blocks another session's
 * interrupt or approval.
 */
export const CONCURRENT_BRIDGE_SCHEDULE: BridgeSchedule = {
  laneKey: request => {
    const sessionId = request.params.sessionId;
    return typeof sessionId === 'string' && sessionId.length > 0 ? `session:${sessionId}` : null;
  },
  overtake: new Set(['turn.interrupt', 'interaction.respond', 'shutdown']),
  barrier: new Set(['initialize']),
};

/** One request at a time, in arrival order (the bridge/1.0 baseline). */
export const SERIAL_BRIDGE_SCHEDULE: BridgeSchedule = {
  laneKey: () => 'serial',
  overtake: new Set(),
  barrier: new Set(),
};

/**
 * Read NDJSON request lines from stdin and route each one to a handler.
 * The handler returns a result synchronously or asynchronously; a thrown
 * `BridgeProtocolError` becomes a JSON-RPC error response. Requests are
 * scheduled by `schedule` (serial by default). A request whose `deadlineAt`
 * has passed is refused without running. Resolves at EOF once every started
 * request has been answered.
 */
export async function runBridgeInput(
  input: Readable,
  handle: (request: BridgeRequest) => Promise<Record<string, unknown>>,
  writer: BridgeWriter,
  onError?: (error: unknown) => void,
  schedule: BridgeSchedule = SERIAL_BRIDGE_SCHEDULE,
  now: () => number = Date.now,
): Promise<void> {
  const reader = createInterface({ input, crlfDelay: Infinity });
  const inflight = new Set<Promise<void>>();
  const lanes = new Map<string, Promise<void>>();
  let barrier: Promise<void> = Promise.resolve();

  const run = async (request: BridgeRequest): Promise<void> => {
    try {
      if (request.deadlineAt !== undefined && now() > request.deadlineAt) {
        throw new BridgeProtocolError(
          -32000,
          `Bridge request ${request.method} expired before it ran; the Proxy had already stopped waiting.`,
          'RUNTIME_UNAVAILABLE',
          true,
        );
      }
      const result = await handle(request);
      writer.result(request.id, result);
    } catch (error) {
      writer.error(request.id, bridgeErrorObject(error));
      if (onError) onError(error);
    }
  };
  const track = (task: Promise<void>): void => {
    inflight.add(task);
    void task.finally(() => inflight.delete(task));
  };

  for await (const line of reader) {
    if (line.trim() === '') continue;
    let value: unknown;
    try {
      value = parseBridgeLine(line);
    } catch (error) {
      writer.error(null, transportError(error));
      if (onError) onError(error);
      continue;
    }
    if (value === null) continue;

    const record = asRecord(value);
    const id = typeof record?.id === 'string' && record.id.length > 0
      ? record.id
      : null;

    if (typeof record?.id !== 'string' || record.id.length === 0) {
      const checked = validateBridgeNotification(value);
      if (checked.ok === false) {
        writer.error(null, transportError(new BridgeProtocolError(-32600, checked.error)));
        continue;
      }
      // Inbound notifications from the proxy are not part of bridge/1.0: the
      // private contract only defines Proxy -> Bridge requests and
      // Bridge -> Proxy notifications. Reject rather than silently ignore.
      writer.error(null, transportError(new BridgeProtocolError(-32601, `Bridge does not accept notification ${String(record?.method)}`)));
      continue;
    }

    const checked = validateBridgeRequest(value);
    if (checked.ok === false) {
      writer.error(id, transportError(new BridgeProtocolError(-32600, checked.error)));
      continue;
    }
    const request = checked.request;

    if (schedule.barrier.has(request.method)) {
      const settled = Promise.allSettled([...inflight, barrier]);
      const task = settled.then(() => run(request));
      barrier = task;
      track(task);
      continue;
    }
    const key = schedule.overtake.has(request.method) ? null : schedule.laneKey(request);
    const gate = barrier;
    const previous = key === null ? undefined : lanes.get(key);
    const task = Promise.allSettled([gate, previous]).then(() => run(request));
    if (key !== null) {
      lanes.set(key, task);
      void task.finally(() => {
        if (lanes.get(key) === task) lanes.delete(key);
      });
    }
    track(task);
  }
  while (inflight.size > 0) await Promise.allSettled([...inflight]);
}

function transportError(error: unknown): {
  code: number;
  message: string;
  data?: { domainCode: string; retryable: boolean; details?: Record<string, unknown> };
} {
  if (error instanceof BridgeProtocolError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.domainCode
        ? { data: { domainCode: error.domainCode, retryable: error.retryable } }
        : {}),
    };
  }
  return {
    code: -32603,
    message: error instanceof Error ? error.message : String(error),
  };
}

/** Build the frozen initialize result header emitted by a bridge runtime. */
export function buildInitializeResult(version: string, dshVersion: string, sessionFormatVersion: number) {
  return {
    protocol: {
      name: BRIDGE_PROTOCOL_NAME,
      version: BRIDGE_PROTOCOL_VERSION,
    },
    plugin: {
      id: 'ai.deepseek.harness',
      bundle: '@gian/dsh-bridge',
      version,
    },
    runtime: {
      id: 'deepseek-harness',
      package: '@deepseek-ai/dsh',
      version: dshVersion,
      sessionFormatVersion,
    },
    capabilities: {
      'session.resume': 1,
      'session.events.read': 1,
      'turn.interrupt': 1,
      'catalog.changed': 1,
      interaction: 1,
      'event.step': 1,
      'event.request': 1,
      'event.usage': 1,
    },
  };
}

export const BRIDGE_NOTIFICATION_SET: ReadonlySet<string> = new Set(BRIDGE_NOTIFICATIONS);
