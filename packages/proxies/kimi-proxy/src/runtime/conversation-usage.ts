/** Kimi 2.7 reports token usage only per native turn (`turn.usage`, the sum
 * of its steps); the session wire carries no conversation totals. A Gian
 * turn can span several native turns (background-task continuations), so
 * its usage is the sum of those turns, sent once as a `delta`. Context
 * occupancy is a separate feed and is never counted as consumption. */

const FIELDS = ['input_other', 'input_cache_read', 'input_cache_creation', 'output'] as const;

function nativeUsage(value: unknown): Record<(typeof FIELDS)[number], number> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const usage = value as Record<string, unknown>;
  if (FIELDS.some(field => !Number.isSafeInteger(usage[field]) || (usage[field] as number) < 0)) return null;
  return Object.fromEntries(FIELDS.map(field => [field, usage[field] as number])) as Record<(typeof FIELDS)[number], number>;
}

export function sumConversationUsage(values: readonly unknown[]): Record<string, unknown> | null {
  const totals = { input_other: 0, input_cache_read: 0, input_cache_creation: 0, output: 0 };
  let seen = false;
  for (const value of values) {
    const usage = nativeUsage(value);
    if (!usage) continue;
    seen = true;
    for (const field of FIELDS) totals[field] += usage[field];
  }
  if (!seen) return null;
  const input = totals.input_other + totals.input_cache_read + totals.input_cache_creation;
  const total = input + totals.output;
  if (!Number.isSafeInteger(input) || !Number.isSafeInteger(total)) return null;
  return { conversation: { mode: 'delta', inputTokens: input, outputTokens: totals.output,
    cachedInputTokens: totals.input_cache_read, totalTokens: total } };
}

/** Event identity shared by live projection and replay. */
export function conversationUsageEventSource(nativeTurnIds: readonly string[], data: Record<string, unknown>): unknown {
  return ['turn-usage', [...nativeTurnIds].sort(), data];
}
