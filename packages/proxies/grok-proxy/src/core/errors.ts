export class GrokProxyError extends Error {
  readonly status: number;
  readonly code: string;
  /** Native facts kept for the wire (`data.details`), e.g. the ACP error code. */
  readonly details: Record<string, unknown>;

  constructor(status: number, code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'GrokProxyError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function createAppError(
  status: number,
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): GrokProxyError {
  return new GrokProxyError(status, code, message, details);
}

/** ACP reserves this JSON-RPC code for "Authentication required"
 *  (`RequestError.authRequired`). Grok 1.0.92 answers `session/new` with it
 *  when no sign-in and no keyed model is configured. */
export const ACP_AUTH_REQUIRED_CODE = -32000;

/** Sign-in is required only when the runtime says so with the ACP auth code
 *  (or the ACP "Authentication required" text without a code). A provider
 *  401 or a message that merely mentions auth is an ordinary runtime error. */
export function isAcpAuthRequired(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (typeof code === 'number') return code === ACP_AUTH_REQUIRED_CODE;
  return typeof message === 'string' && /^authentication required\b/i.test(message.trim());
}

/** Text the CLI itself gave for an error, including its JSON-RPC data. */
export function nativeErrorText(error: unknown): string {
  if (error instanceof Error || (error && typeof error === 'object')) {
    const { message, data } = error as { message?: unknown; data?: unknown };
    const base = typeof message === 'string' ? message : String(error);
    const extra = typeof data === 'string' && data.trim() && !base.includes(data.trim())
      ? ` (${data.trim()})`
      : '';
    return redactDiagnostics(`${base}${extra}`);
  }
  return redactDiagnostics(String(error));
}

/** The native JSON-RPC code (and string data) of a runtime error, for `details`. */
export function nativeErrorDetails(error: unknown): Record<string, unknown> {
  if (error === null || typeof error !== 'object') return {};
  const { code, data } = error as { code?: unknown; data?: unknown };
  const details: Record<string, unknown> = {};
  if (typeof code === 'number' && Number.isSafeInteger(code)) details.nativeCode = code;
  if (typeof data === 'string' && data.length <= 2_000) details.nativeData = redactDiagnostics(data);
  return details;
}

export const GROK_SIGN_IN_HINT = 'Grok requires sign-in. In the Gian Workbench Terminal run `grok login`, then retry. '
  + 'A model with its own API key in Grok\'s config.toml also works without sign-in.';

/** Removes credentials a diagnostic line might echo. */
export function redactDiagnostics(text: string): string {
  return text
    .replace(/\b(sk|xai|sk-ant|sk-proj)-[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]')
    .replace(/((?:api[_-]?key|token|secret|password)["']?\s*[:=]\s*["']?)[^\s"',;]{6,}/gi, '$1[redacted]');
}
