import {
  DOMAIN_CODES,
  proxyRequestSchema,
} from '@gian/proxy-protocol';

import { redactRuntimeData } from '../core/mcp.js';
import type { JsonRecord } from '../contracts.js';

export interface WireRequest {
  jsonrpc: '2.0';
  id: string;
  method: string;
  params: JsonRecord;
}

export class ProtocolError extends Error {
  readonly details: Record<string, unknown>;

  constructor(
    readonly domainCode: typeof DOMAIN_CODES[number],
    message: string,
    readonly retryable = false,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'AntigravityProtocolError';
    this.details = details;
  }
}

export class RpcError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
    this.name = 'AntigravityRpcError';
  }
}

export function standardError(error: unknown): JsonRecord {
  if (error instanceof RpcError) return { code: error.code, message: error.message };
  const value = error && typeof error === 'object' ? error as JsonRecord : {};
  const domainCode = typeof value.domainCode === 'string'
    && (DOMAIN_CODES as readonly string[]).includes(value.domainCode)
    ? value.domainCode : 'INTERNAL';
  return {
    code: -32000,
    message: String(redactRuntimeData(error instanceof Error ? error.message : 'Unexpected Proxy error.')),
    data: {
      domainCode,
      retryable: value.retryable === true,
      details: redactRuntimeData(value.details ?? {}),
    },
  };
}

export function parseRequestLine(line: string): WireRequest {
  let value: unknown;
  try { value = JSON.parse(line); }
  catch { throw new RpcError(-32700, 'Request is not valid JSON.'); }
  return validateRequest(value);
}

/** Check a parsed request against the Gian Proxy contract. */
export function validateRequest(value: unknown): WireRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RpcError(-32600, 'Request must be a JSON-RPC object.');
  }
  const record = value as JsonRecord;
  if (record.jsonrpc !== '2.0' || typeof record.id !== 'string' || !record.id
    || typeof record.method !== 'string' || !record.method) {
    throw new RpcError(-32600, 'Request requires jsonrpc, a non-empty string id, and method.');
  }
  const parsed = proxyRequestSchema.safeParse(value);
  if (!parsed.success) throw new RpcError(-32602, 'Request does not match the Gian Proxy contract.');
  return parsed.data as WireRequest;
}
