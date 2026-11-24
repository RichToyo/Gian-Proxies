/** Native Kimi 2.7 failure facts → Gian errors. The CLI's own text always
 *  reaches the Host; sign-in and credential failures become
 *  RUNTIME_AUTH_REQUIRED with an actionable hint, and every other failure
 *  keeps its native code in `details`. */

type Frame = Record<string, unknown>;

export interface GianError {
  domainCode: 'RUNTIME_ERROR' | 'RUNTIME_AUTH_REQUIRED';
  message: string;
  retryable: boolean;
  details: Record<string, unknown>;
}

const AUTH_HINT = 'Sign in to Kimi Code for this Agent (run `kimi login` with its Kimi home) '
  + 'or fix the provider `api_key` in its config.toml, then retry.';

/** Native string codes for missing or rejected credentials: the `auth.*`
 *  family (login_required, token_missing, token_unauthorized,
 *  provisioning_required, model_not_resolved) and a provider HTTP 401/403
 *  (`provider.auth_error`). */
export function isKimiAuthCode(code: unknown): boolean {
  return typeof code === 'string' && (code.startsWith('auth.') || code === 'provider.auth_error');
}

function withHint(message: string): string {
  const trimmed = message.trim();
  return `${trimmed}${/[.!?]$/.test(trimmed) ? '' : '.'} ${AUTH_HINT}`;
}

function text(value: unknown, limit = 4_000): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, limit) : undefined;
}

/** Project a native `turn.error` ({code, message, name?, status_code?,
 *  request_id?, retryable?}) and `end_reason` into a turn failure. */
export function conversationTurnError(error: unknown, endReason?: string): GianError {
  const native = typeof error === 'object' && error !== null && !Array.isArray(error) ? error as Frame : null;
  const message = text(native?.message);
  const code = text(native?.code, 200);
  const details: Record<string, unknown> = {
    ...(code !== undefined ? { nativeCode: code } : {}),
    ...(text(native?.name, 200) !== undefined ? { nativeName: text(native?.name, 200) } : {}),
    ...(Number.isSafeInteger(native?.status_code) ? { statusCode: native!.status_code } : {}),
    ...(text(native?.request_id, 200) !== undefined ? { requestId: text(native?.request_id, 200) } : {}),
    ...(endReason !== undefined ? { endReason } : {}),
  };
  if (isKimiAuthCode(code)) {
    return { domainCode: 'RUNTIME_AUTH_REQUIRED', message: withHint(message ?? 'Kimi Code is not signed in.'),
      retryable: false, details };
  }
  const fallback = endReason === 'filtered' ? 'The model provider filtered the Kimi response.'
    : endReason === 'blocked' ? 'A Kimi hook blocked the prompt.' : 'Kimi turn failed.';
  return { domainCode: 'RUNTIME_ERROR', message: message ?? fallback, retryable: native?.retryable === true, details };
}

/** REST business codes 40110–40113 are the server's auth family. */
export function kimiAuthRequiredMessage(nativeMessage: string): string {
  return withHint(nativeMessage);
}
