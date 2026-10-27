import { createHash } from 'node:crypto';
import { isProxyOfficialQuotaData, type ProxyOfficialQuotaData, type ProxyOfficialQuotaWindow } from '@gian/proxy-protocol';

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const safeText = (value: unknown): value is string => typeof value === 'string' && value.length > 0
  && value.length <= 128 && !/[\u0000-\u001f\u007f]/u.test(value);

/** Native print-mode report, not a generated response or an ACP session's
 * Token usage. quotaJSON/groupJSON/bucketJSON are the CLI's own JSON types. */
export function normalizeAntigravityCliQuota(stdout: string): ProxyOfficialQuotaData {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { throw new Error('invalid_response'); }
  const raw = object(parsed);
  if (raw.status !== 'SUCCESS' || raw.conversation_id !== '' || raw.num_turns !== 0) throw new Error('invalid_response');
  if (!raw.usage || typeof raw.usage !== 'object' || Array.isArray(raw.usage)) throw new Error('invalid_response');
  const usage = object(raw.usage);
  for (const field of ['input_tokens', 'output_tokens', 'thinking_tokens', 'cache_read_tokens', 'total_tokens']) {
    if (usage[field] != null && usage[field] !== 0) throw new Error('invalid_response');
  }
  const command = object(raw.command);
  if (command.name !== 'usage') throw new Error('invalid_response');
  const data = object(command.data);
  // Native 1.4.6 emits quota groups directly in command.data. Retain the
  // previously accepted wrapper, but never choose between ambiguous payloads.
  const wrapped = Object.hasOwn(data, 'quota');
  if (wrapped && Object.hasOwn(data, 'groups')) throw new Error('invalid_response');
  if (wrapped && data.quota === null) throw new Error('unsupported');
  const quota = wrapped ? object(data.quota) : data;
  if (!Object.hasOwn(quota, 'groups')) throw new Error('invalid_response');
  if (!Array.isArray(quota.groups) || quota.groups.length > 32) throw new Error('invalid_response');
  const windows: ProxyOfficialQuotaWindow[] = [];
  const seen = new Map<string, string>();
  for (const input of quota.groups) {
    const group = object(input);
    if (!safeText(group.name) || !Array.isArray(group.buckets) || group.buckets.length > 64) throw new Error('invalid_response');
    for (const inputBucket of group.buckets) {
      const bucket = object(inputBucket);
      if (!safeText(bucket.name) || bucket.id != null && !safeText(bucket.id)
        || bucket.window != null && !safeText(bucket.window)
        || bucket.disabled != null && typeof bucket.disabled !== 'boolean') throw new Error('invalid_response');
      if (bucket.disabled === true) continue;
      const remaining = bucket.remaining_fraction;
      if (remaining != null && (typeof remaining !== 'number' || !Number.isFinite(remaining) || remaining < 0 || remaining > 1)) {
        throw new Error('invalid_response');
      }
      const reset = bucket.reset_time;
      const resetAt = reset == null ? null : typeof reset === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/u.test(reset) ? Date.parse(reset) : NaN;
      if (resetAt !== null && (!Number.isSafeInteger(resetAt) || resetAt < 0)) throw new Error('invalid_response');
      const window = typeof bucket.window === 'string' ? bucket.window : '';
      const duration = /^(?:5h|5 hours)$/iu.test(window) ? 300 : /^(?:weekly|7d|7 days)$/iu.test(window) ? 10_080 : null;
      const id = createHash('sha256').update(JSON.stringify([group.name, bucket.id ?? bucket.name, window])).digest('hex');
      const value = { id, label: window ? `${bucket.name} - ${window}` : bucket.name,
        // Native omitempty can omit a zero fraction and an amount-only bucket
        // has no denominator. Missing fraction is unknown, not invented 0%.
        usedRatio: typeof remaining === 'number' ? 1 - remaining : null,
        resetAt, windowDurationMinutes: duration };
      const encoded = JSON.stringify(value);
      const previous = seen.get(id);
      if (previous !== undefined) {
        if (previous !== encoded) throw new Error('invalid_response');
        continue;
      }
      seen.set(id, encoded);
      windows.push(value);
      if (windows.length > 64) throw new Error('invalid_response');
    }
  }
  if (!windows.length) throw new Error('unsupported');
  // G1 credits are not currency balances. Do not turn creditsJSON into USD.
  const result = { windows, balances: [] };
  if (!isProxyOfficialQuotaData(result)) throw new Error('invalid_response');
  return result;
}

/** Changelog is a top-level metadata command, safe even before print-mode
 * quota support existed. Older CLIs must never receive a /usage prompt. */
export function supportsAntigravityCliQuota(changelog: string): boolean {
  const match = /^(?:#{1,2}\s*)?v?(\d+)\.(\d+)\.(\d+)(?::|\s|$)/u.exec(changelog.trimStart());
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  if (![major, minor, patch].every(Number.isSafeInteger)) return false;
  return major === 1 && (minor! > 1 || minor === 1 && patch! >= 11);
}
