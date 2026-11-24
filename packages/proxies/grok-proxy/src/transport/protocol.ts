const JSONRPC = '2.0' as const;

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
  | 'INVALID_REQUEST'
  | 'INVALID_PARAMS'
  | 'METHOD_NOT_FOUND'
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

export class GrokProtocolError extends Error {
  readonly retryable: boolean;
  constructor(
    readonly domainCode: DomainCode,
    message: string,
    retryable = false,
    /** Native facts (e.g. the ACP error code) carried in `data.details`. */
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'GrokProtocolError';
    this.retryable = retryable;
  }
}

/** An outbound line that would exceed the negotiated NDJSON frame limit. The
 *  line is never written. */
export class GrokFrameLimitError extends GrokProtocolError {
  constructor() {
    super('RUNTIME_ERROR', 'Proxy output exceeds the negotiated frame limit.');
    this.name = 'GrokFrameLimitError';
  }
}

export class GrokJsonRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'GrokJsonRpcError';
  }
}

export function jsonRpcError(error: unknown) {
  if (error instanceof GrokJsonRpcError) {
    return {
      code: error.code,
      message: error.message,
    };
  }
  if (error instanceof GrokProtocolError) {
    return {
      code: JSONRPC_ERROR_CODES.DOMAIN_ERROR,
      message: error.message,
      data: {
        domainCode: error.domainCode,
        retryable: error.retryable,
        details: error.details,
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
