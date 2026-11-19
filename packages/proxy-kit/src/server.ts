import { JSONRPC_ERROR_CODES, readNdjsonLines } from '@gian/proxy-protocol';

import {
  parseWireRequest,
  recoverRequestId,
  WireRequestError,
  type WireRequest,
} from './request.js';
import { createTaskQueue } from './task-queue.js';
import {
  createJsonRpcWriter,
  type ErrorMapper,
  type JsonRpcWriter,
  type JsonRpcWriterOptions,
} from './writer.js';

export type NotificationEmitter = (method: string, params: Record<string, unknown>) => void;

/** Answers one request. Call it once; later calls are ignored. */
export type Responder = (result: unknown, error?: unknown) => void;

interface ProxyHandlerBase {
  /** Releases the native runtime. Runs once, after every tracked request has
   *  settled. A rejection turns the shutdown into a failed exit. */
  close(): Promise<void>;
}

/** The kit writes the Response when `handle` settles. */
export interface ReturningProxyHandler extends ProxyHandlerBase {
  handle(request: WireRequest): Promise<unknown>;
  dispatch?: never;
}

/** The handler writes its own Response through `respond`, synchronously, at
 *  the moment it chooses (e.g. before the notifications that Response
 *  enables). The returned promise only tracks the request for lanes and
 *  drain. Settling without having called `respond` answers with an error. */
export interface RespondingProxyHandler extends ProxyHandlerBase {
  dispatch(request: WireRequest, respond: Responder): Promise<void>;
  handle?: never;
}

export type ProxyHandler = ReturningProxyHandler | RespondingProxyHandler;

export interface ProxyServerOptions {
  /** Log prefix, e.g. `codex-proxy`. */
  tag: string;
  toJsonRpcError: ErrorMapper;
  /**
   * Builds the Proxy around the kit-owned emitters.
   *
   * `emit` is ordered: while any session-lane or overtake request is in
   * flight, notifications are held and written after that request's Response.
   * `emitImmediate` writes at once; use it only for notifications that no
   * in-flight request caused (e.g. an adapter that returns each request's own
   * notifications from dispatch and streams everything else).
   */
  createHandler(emit: NotificationEmitter, emitImmediate: NotificationEmitter): Promise<ProxyHandler>;
  /** Methods that dispatch concurrently and never wait on, or block, the
   *  serialized session lane. They hold no notifications and must not emit. */
  pipelinedMethods?: ReadonlySet<string>;
  /** Methods that dispatch concurrently, so they can answer a native runtime
   *  that is blocked inside a session-lane request (e.g. an approval), but
   *  still hold notifications like a session-lane request. */
  overtakeMethods?: ReadonlySet<string>;
  /** Methods that run alone: they start after every in-flight request has
   *  settled, and later requests wait for them (e.g. `initialize`). */
  barrierMethods?: ReadonlySet<string>;
  /** Session lane of a request. Requests in one lane are serialized; distinct
   *  lanes run concurrently. Omitted: one lane for the whole process. */
  laneKey?: (request: WireRequest) => string;
  /** A handler whose request task rejects (instead of answering an error) is
   *  treated as broken: the Proxy closes its runtime and exits 1. */
  failClosedOnDispatchRejection?: boolean;
  /** Outbound frame limit. */
  writer?: JsonRpcWriterOptions;
  /** Reports an uncaught error before the Proxy closes its runtime and exits
   *  1. The default logs it and emits `runtime.error` with its message; pass a
   *  reporter when native error text may carry secrets. */
  onCrash?: (kind: 'uncaught' | 'unhandledRejection', error: unknown, writer: JsonRpcWriter) => void;
  input?: AsyncIterable<Buffer | string>;
  output?: NodeJS.WritableStream;
  /** Defaults to `process.exit`. */
  exit?: (code: number) => void;
  /** Install signal and crash handlers on `process`. Defaults to true. */
  processHooks?: boolean;
}

/** Longest a crashing Proxy waits for its runtime to close before exiting. */
const CRASH_CLOSE_TIMEOUT_MS = 5_000;

function defaultCrashReport(tag: string) {
  return (kind: 'uncaught' | 'unhandledRejection', error: unknown, writer: JsonRpcWriter): void => {
    const message = error instanceof Error
      ? `${error.message}\n${error.stack ?? ''}`
      : String(error);
    console.error(`[${tag}:${kind}]`, message);
    writer.notification('runtime.error', {
      eventId: `crash-${Date.now()}`,
      emittedAt: new Date().toISOString(),
      data: {
        domainCode: 'RUNTIME_ERROR',
        message,
        retryable: false,
        details: { kind },
      },
    });
  };
}

/**
 * Runs the gian.proxy/2 request loop until a `shutdown` request, EOF or a
 * framing violation. Resolves with the exit code once `exit` has been called.
 *
 * Ordering contract: notifications passed to `emit` while a session-lane or
 * overtake request is in flight are held and written once no such request is
 * in flight, after the Response that released them
 * (Response-before-Notification); `sidechat.close` is the one exception and
 * releases them before its Response (Contract §10.5.4). With nothing in flight
 * they are written immediately.
 */
export async function runProxyServer(options: ProxyServerOptions): Promise<number> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const pipelined = options.pipelinedMethods ?? new Set<string>();
  const overtake = options.overtakeMethods ?? new Set<string>();
  const barriers = options.barrierMethods ?? new Set<string>();
  const processHooks = options.processHooks ?? true;
  const writer = createJsonRpcWriter(output, options.toJsonRpcError, options.writer);

  // Every session-lane or overtake request holds `emit` output until it has
  // been answered; held notifications go out, in emission order, once the
  // last holder releases. Pipelined requests never hold: a concurrent scan
  // must never swallow, reorder, or prematurely flush a live session's
  // notifications.
  let holders = 0;
  const held: Array<{ method: string; params: Record<string, unknown> }> = [];
  const release = (): void => {
    holders -= 1;
    if (holders > 0) return;
    for (const notification of held.splice(0)) {
      writer.notification(notification.method, notification.params);
    }
  };

  let handler: ProxyHandler | null = null;
  let closing: Promise<void> | null = null;
  const closeHandler = (): Promise<void> => {
    closing ??= handler ? handler.close() : Promise.resolve();
    return closing;
  };

  if (processHooks) {
    const report = options.onCrash ?? defaultCrashReport(options.tag);
    let crashed = false;
    const onCrash = (kind: 'uncaught' | 'unhandledRejection', error: unknown) => {
      if (crashed) return;
      crashed = true;
      try {
        report(kind, error, writer);
      } catch {
        // Reporting must never prevent the runtime from being retired.
      }
      // Retire the owned runtime (child processes) before exiting, bounded so
      // a wedged close cannot keep a broken Proxy alive.
      const timer = setTimeout(() => exit(1), CRASH_CLOSE_TIMEOUT_MS);
      void closeHandler().then(
        () => { clearTimeout(timer); exit(1); },
        () => { clearTimeout(timer); exit(1); },
      );
    };
    process.on('uncaughtException', (error) => onCrash('uncaught', error));
    process.on('unhandledRejection', (error) => onCrash('unhandledRejection', error));
  }

  handler = await options.createHandler(
    (method, params) => {
      if (holders > 0) held.push({ method, params });
      else writer.notification(method, params);
    },
    (method, params) => writer.notification(method, params),
  );

  // Every dispatched task is tracked so EOF, shutdown and signals drain
  // in-flight work: no request is ever orphaned without its Response.
  const queue = createTaskQueue(options.tag);

  let resolveExited: (code: number) => void = () => {};
  const exited = new Promise<number>((resolve) => {
    resolveExited = resolve;
  });
  let shuttingDown = false;
  let stopReading = false;
  const shutdown = async (code: number): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    let exitCode = code;
    try {
      await queue.drain();
      await closeHandler();
    } catch (error) {
      // Fail closed: an unverified terminal cleanup must turn the shutdown
      // into a failed exit, not a silent clean one.
      console.error(
        `[${options.tag}:shutdown] cleanup failed:`,
        error instanceof Error ? error.message : String(error),
      );
      exitCode = 1;
    }
    exit(exitCode);
    resolveExited(exitCode);
  };
  if (processHooks) {
    process.on('SIGINT', () => {
      void shutdown(0);
    });
    process.on('SIGTERM', () => {
      void shutdown(0);
    });
  }

  const dispatch = async (request: WireRequest): Promise<void> => {
    let holding = !pipelined.has(request.method);
    if (holding) holders += 1;
    const releaseOnce = (): void => {
      if (!holding) return;
      holding = false;
      release();
    };
    let responded = false;
    const respond: Responder = (result, error) => {
      if (responded) return;
      responded = true;
      // A successful sidechat.close releases what it held before its own
      // Response (Contract §10.5.4); everything else answers first.
      if (request.method === 'sidechat.close' && error === undefined) releaseOnce();
      if (error !== undefined) writer.error(request.id, error);
      else writer.result(request.id, result);
      releaseOnce();
    };
    try {
      const active = handler!;
      if (active.dispatch) {
        await active.dispatch(request, respond);
        if (!responded) {
          respond(undefined, new Error(`${request.method} settled without a Response.`));
        }
      } else {
        respond(await active.handle(request));
      }
    } catch (error) {
      respond(undefined, error);
      if (options.failClosedOnDispatchRejection) {
        stopReading = true;
        void shutdown(1);
      }
    } finally {
      releaseOnce();
      if (request.method === 'shutdown') {
        stopReading = true;
        void shutdown(0);
      }
    }
  };

  const readLoop = async (): Promise<void> => {
    try {
      for await (const line of readNdjsonLines(input)) {
        if (stopReading) break;
        if (!line.trim()) continue;
        let request: WireRequest;
        try {
          request = parseWireRequest(line);
        } catch (error) {
          writer.error(recoverRequestId(line), error);
          continue;
        }
        if (barriers.has(request.method)) {
          queue.enqueueBarrier(() => dispatch(request));
        } else if (pipelined.has(request.method) || overtake.has(request.method)) {
          queue.enqueuePipelined(() => dispatch(request));
        } else {
          queue.enqueueSession(() => dispatch(request), options.laneKey?.(request));
        }
      }
    } catch (error) {
      // Framing violation (oversized line, invalid UTF-8): the byte stream can
      // no longer be trusted, so in-flight work drains and the process fails.
      writer.error(null, new WireRequestError(
        JSONRPC_ERROR_CODES.PARSE_ERROR,
        error instanceof Error ? error.message : String(error),
      ));
      await shutdown(1);
      return;
    }
    // EOF: shutdown drains every tracked task before the process exits.
    await shutdown(0);
  };
  readLoop().catch((error: unknown) => {
    console.error(`[${options.tag}:loop]`, error instanceof Error ? error.message : String(error));
    void shutdown(1);
  });

  return exited;
}
