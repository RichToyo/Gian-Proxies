const JSONRPC_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  DOMAIN_ERROR: -32000,
} as const;

export type DomainCode =
  | 'INTERNAL'
  | 'NOT_INITIALIZED'
  | 'ALREADY_INITIALIZED'
  | 'INCOMPATIBLE_PROTOCOL'
  | 'CAPABILITY_NOT_SUPPORTED'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_CLOSED'
  | 'SESSION_STALE'
  | 'SESSION_ERROR'
  | 'SESSION_BUSY'
  | 'TURN_NOT_FOUND'
  | 'CONFLICT'
  | 'INTERACTION_NOT_FOUND'
  | 'INTERACTION_ACTION_NOT_FOUND'
  | 'CONFIG_REQUIRED'
  | 'CONFIG_VALUE_INVALID'
  | 'CONFIG_BINDING_INVALID'
  | 'NATIVE_SESSION_NOT_FOUND'
  | 'SIDECHAT_UNAVAILABLE'
  | 'FORK_BOUNDARY_UNAVAILABLE'
  | 'RUNTIME_UNAVAILABLE'
  | 'RUNTIME_ERROR'
  | 'RUNTIME_AUTH_REQUIRED'
  | 'CANCELLED';

export class CodexProtocolError extends Error {
  readonly retryable: boolean;
  constructor(
    readonly domainCode: DomainCode,
    message: string,
    retryable = false,
    /** Native identifiers (Codex error code, RPC method); never secrets. */
    readonly details: Record<string, string | number | boolean | null> = {},
  ) {
    super(message);
    this.name = 'CodexProtocolError';
    this.retryable = retryable;
  }
}

export class CodexJsonRpcError extends Error {
  constructor(
    readonly code: -32700 | -32600 | -32601 | -32602 | -32603,
    message: string,
  ) {
    super(message);
    this.name = 'CodexJsonRpcError';
  }
}

export function jsonRpcError(error: unknown) {
  if (error instanceof CodexJsonRpcError) {
    return {
      code: error.code,
      message: error.message,
    };
  }
  if (error instanceof CodexProtocolError) {
    return {
      code: JSONRPC_ERROR_CODES.DOMAIN_ERROR,
      message: error.message,
      data: {
        domainCode: error.domainCode,
        retryable: error.retryable,
        details: { ...error.details },
      },
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: JSONRPC_ERROR_CODES.DOMAIN_ERROR,
    message,
    data: {
      domainCode: 'INTERNAL' as const,
      retryable: false,
      details: {},
    },
  };
}
