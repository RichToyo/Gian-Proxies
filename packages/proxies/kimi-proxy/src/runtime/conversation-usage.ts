/** Kimi conversation turn usage is a native per-turn delta. Context occupancy
 * is a separate feed and must never be counted as token consumption. */
export function projectConversationUsage(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const usage = value as Record<string, unknown>;
  const fields = ['input_other', 'input_cache_read', 'input_cache_creation', 'output'] as const;
  if (fields.some(field => !Number.isSafeInteger(usage[field]) || (usage[field] as number) < 0)) return null;
  const input = (usage.input_other as number) + (usage.input_cache_read as number) + (usage.input_cache_creation as number);
  const output = usage.output as number;
  const total = input + output;
  if (!Number.isSafeInteger(input) || !Number.isSafeInteger(total)) return null;
  return { conversation: { mode: 'delta', inputTokens: input, outputTokens: output,
    cachedInputTokens: usage.input_cache_read, totalTokens: total } };
}
