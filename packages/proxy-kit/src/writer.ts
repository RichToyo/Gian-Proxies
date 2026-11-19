import { JSONRPC_VERSION } from '@gian/proxy-protocol';

import { WireRequestError } from './request.js';

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

/** Maps a Proxy's own errors (domain errors, adapter JSON-RPC errors) to the
 * wire. Framing and request-shape errors never reach it. */
export type ErrorMapper = (error: unknown) => JsonRpcErrorObject;

export interface JsonRpcWriter {
  result(id: string, result: unknown): void;
  error(id: string | null, error: unknown): void;
  notification(method: string, params: unknown): void;
}

export function wireErrorObject(error: unknown, toError: ErrorMapper): JsonRpcErrorObject {
  if (error instanceof WireRequestError) {
    return { code: error.code, message: error.message };
  }
  return toError(error);
}

export interface JsonRpcWriterOptions {
  /** Refuse to write a line longer than this many UTF-8 bytes (newline
   *  included). The line is not written; `oversized()` is thrown instead. */
  maxLineBytes?: number;
  oversized?: () => Error;
}

export function createJsonRpcWriter(
  output: NodeJS.WritableStream,
  toError: ErrorMapper,
  options: JsonRpcWriterOptions = {},
): JsonRpcWriter {
  const write = (payload: unknown): void => {
    const line = `${JSON.stringify(payload)}\n`;
    if (options.maxLineBytes !== undefined && Buffer.byteLength(line) > options.maxLineBytes) {
      throw options.oversized?.() ?? new Error('Proxy output exceeds the frame limit.');
    }
    output.write(line);
  };
  return {
    result(id, result) {
      write({ jsonrpc: JSONRPC_VERSION, id, result });
    },
    error(id, error) {
      write({ jsonrpc: JSONRPC_VERSION, id, error: wireErrorObject(error, toError) });
    },
    notification(method, params) {
      write({ jsonrpc: JSONRPC_VERSION, method, params });
    },
  };
}
