import { JSONRPC_ERROR_CODES, JSONRPC_VERSION } from '@gian/proxy-protocol';

export interface WireRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

/** A line that is not a valid gian.proxy/2 request. It maps to a standard
 * JSON-RPC error object without domain data. */
export class WireRequestError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'WireRequestError';
  }
}

export function parseWireRequest(line: string): WireRequest {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new WireRequestError(JSONRPC_ERROR_CODES.PARSE_ERROR, 'Parse error.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WireRequestError(JSONRPC_ERROR_CODES.INVALID_REQUEST, 'Invalid Request.');
  }
  const record = value as Record<string, unknown>;
  if (record.jsonrpc !== JSONRPC_VERSION) {
    throw new WireRequestError(JSONRPC_ERROR_CODES.INVALID_REQUEST, 'Invalid Request.');
  }
  if (typeof record.id !== 'string' || record.id.length === 0) {
    throw new WireRequestError(JSONRPC_ERROR_CODES.INVALID_REQUEST, 'Invalid Request.');
  }
  if (typeof record.method !== 'string' || record.method.length === 0) {
    throw new WireRequestError(JSONRPC_ERROR_CODES.INVALID_REQUEST, 'Invalid Request.');
  }
  const params = record.params;
  if (params !== undefined && (typeof params !== 'object' || params === null || Array.isArray(params))) {
    throw new WireRequestError(JSONRPC_ERROR_CODES.INVALID_PARAMS, 'Invalid params.');
  }
  return {
    id: record.id,
    method: record.method,
    params: (params ?? {}) as Record<string, unknown>,
  };
}

/** Best-effort id of a rejected line, so its error can still be correlated. */
export function recoverRequestId(line: string): string | null {
  try {
    const value = JSON.parse(line) as { id?: unknown } | null;
    return typeof value?.id === 'string' && value.id.length > 0 ? value.id : null;
  } catch {
    return null;
  }
}
