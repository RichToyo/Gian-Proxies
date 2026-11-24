/**
 * Classifies Codex failures without losing Codex's own words.
 *
 * `codexErrorInfo` is either a bare string (`unauthorized`,
 * `usageLimitExceeded`, ...) or a single-key object whose value may carry
 * the upstream HTTP status (`{ responseStreamConnectionFailed:
 * { httpStatusCode: 401 } }`). Both forms are kept.
 */

export interface CodexErrorInfo {
  /** The variant name, e.g. `unauthorized` or `httpConnectionFailed`. */
  code?: string;
  httpStatusCode?: number;
}

export function parseCodexErrorInfo(value: unknown): CodexErrorInfo {
  if (typeof value === 'string') {
    const code = value.trim();
    return code ? { code } : {};
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length !== 1) return {};
  const [code, payload] = entries[0]!;
  const status = payload && typeof payload === 'object'
    ? (payload as { httpStatusCode?: unknown }).httpStatusCode
    : undefined;
  return {
    ...(code ? { code } : {}),
    ...(typeof status === 'number' && Number.isSafeInteger(status) ? { httpStatusCode: status } : {}),
  };
}

/** Sign-in and expired-credential wording used by Codex and its backend. */
const AUTH_TEXT = /(?:sign|log)(?:ed)? ?in again|please (?:sign|log) ?in\b|not (?:signed|logged) in\b|\bcodex login\b|refresh token|access token could not be refreshed|authentication required|(?:status|http)\D{0,16}401\b|\b401 unauthori[sz]ed/i;

export function isCodexAuthFailure(failure: { code?: string; httpStatusCode?: number; message?: string }): boolean {
  if (failure.code === 'unauthorized' || failure.httpStatusCode === 401) return true;
  return typeof failure.message === 'string' && AUTH_TEXT.test(failure.message);
}

export const CODEX_SIGN_IN_GUIDANCE = 'Codex is not signed in, or its sign-in has expired. '
  + 'Open this Agent in Gian and choose Log in (it runs `codex login` with the Agent HOME), then retry.';

/** Actionable text that still ends with what Codex itself reported. */
export function signInRequiredMessage(nativeMessage: string): string {
  const native = nativeMessage.trim();
  return native ? `${CODEX_SIGN_IN_GUIDANCE} Codex reported: ${native}` : CODEX_SIGN_IN_GUIDANCE;
}

export interface CodexTurnFailure extends CodexErrorInfo {
  message: string;
  authRequired: boolean;
}

/** Reads a TurnError (`{ message, codexErrorInfo, additionalDetails }`). */
export function codexTurnFailure(error: unknown, fallback: string): CodexTurnFailure {
  const record = error && typeof error === 'object' && !Array.isArray(error)
    ? error as Record<string, unknown>
    : {};
  const base = typeof record.message === 'string' && record.message.trim()
    ? record.message.trim()
    : fallback;
  const extra = typeof record.additionalDetails === 'string' ? record.additionalDetails.trim() : '';
  const message = extra && !base.includes(extra) ? `${base} (${extra})` : base;
  const info = parseCodexErrorInfo(record.codexErrorInfo);
  return { message, ...info, authRequired: isCodexAuthFailure({ ...info, message }) };
}
