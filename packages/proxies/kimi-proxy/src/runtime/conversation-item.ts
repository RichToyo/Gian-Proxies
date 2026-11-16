import { createHash } from 'node:crypto';

type NativeItem = Record<string, unknown>;
export type ItemProjection = { method: 'content.completed' | 'activity.updated'; eventId: string; data: Record<string, unknown> };

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

function bounded(value: unknown): unknown {
  const json = JSON.stringify(value ?? null);
  return Buffer.byteLength(json, 'utf8') <= 64 * 1024 ? value : { truncated: true, originalBytes: Buffer.byteLength(json, 'utf8'), preview: json.slice(0, 2_000) };
}

/** Project native persisted item facts identically for live completion and
 * replay. Non-terminal text is streamed separately, and unknown item types
 * remain unclaimed rather than being represented as successful work. */
export function projectConversationItem(nativeSessionId: string, promptId: string, item: NativeItem): ItemProjection | null {
  if (!nativeSessionId || !promptId || typeof item.item_id !== 'string' || !item.item_id) throw new Error('Invalid Kimi item identity.');
  if (item.type === 'system') {
    if (item.status !== 'ended' || item.outcome !== 'completed' || !['compaction', 'fork_boundary'].includes(String(item.kind))) {
      throw new Error('Invalid Kimi system item.');
    }
    const title = item.kind === 'compaction' ? 'Context compaction' : 'Conversation fork';
    const message = item.kind === 'compaction'
      ? typeof item.summary === 'string' && item.summary !== '' ? item.summary : 'Kimi compacted the conversation context.'
      : 'Kimi recorded a conversation fork boundary.';
    const bytes = Buffer.from(message, 'utf8');
    const truncated = bytes.length > 64 * 1024;
    const data = { activityId: `system:${promptId}:${item.item_id}`, kind: `kimi:${String(item.kind)}`, title, status: 'succeeded',
      presentation: { type: 'notice', data: { message: truncated ? bytes.subarray(0, 64 * 1024).toString('utf8') : message,
        ...(truncated ? { truncated: true } : {}) } } };
    return { method: 'activity.updated', eventId: `evt-${digest([nativeSessionId, promptId, ['system', item.item_id, data]])}`, data };
  }
  if (item.type === 'notification') {
    if (typeof item.title !== 'string' || !item.title || typeof item.body !== 'string' || item.status !== 'ended'
      || item.outcome !== 'completed' || !['info', 'warning', 'error'].includes(String(item.severity))) {
      throw new Error('Invalid Kimi native notification.');
    }
    const bytes = Buffer.from(item.body, 'utf8');
    const truncated = bytes.length > 64 * 1024;
    const message = truncated ? bytes.subarray(0, 64 * 1024).toString('utf8') : item.body;
    const data = { activityId: `notice:${promptId}:${item.item_id}`, kind: 'kimi:notification', title: item.title,
      status: item.severity === 'error' ? 'failed' : 'succeeded',
      presentation: { type: 'notice', data: { message, ...(truncated ? { truncated: true } : {}) } } };
    return { method: 'activity.updated', eventId: `evt-${digest([nativeSessionId, promptId, ['notification', item.item_id, data]])}`, data };
  }
  if (item.type === 'assistant_message' || item.type === 'reasoning') {
    if (item.status !== 'ended') return null;
    if (typeof item.text !== 'string') throw new Error('Invalid Kimi text item.');
    const kind = item.type === 'assistant_message' ? 'text' : 'reasoning';
    const data = { contentId: `kimi:${promptId}:${item.item_id}`, kind,
      ...(kind === 'text' ? { format: 'markdown' } : {}), content: item.text };
    return { method: 'content.completed', eventId: `evt-${digest([nativeSessionId, promptId, item.item_id, 'content.completed', data])}`, data };
  }
  if (item.type !== 'tool_call') return null;
  if (typeof item.name !== 'string' || !item.name || (item.status !== 'running' && item.status !== 'ended')) throw new Error('Invalid Kimi tool item.');
  let status: 'running' | 'succeeded' | 'failed' | 'cancelled';
  if (item.status === 'running') status = 'running';
  else if (item.outcome === 'completed') status = 'succeeded';
  else if (item.outcome === 'failed') status = 'failed';
  else if (item.outcome === 'interrupted') status = 'cancelled';
  else throw new Error('Kimi ended tool has no recognized outcome.');
  const data = { activityId: `kimi:${promptId}:${item.item_id}`, kind: `tool:${item.name}`, title: item.name, status,
    presentation: { type: 'tool', data: { name: item.name,
      ...(item.input !== undefined ? { input: bounded(item.input) }
        : typeof item.input_text === 'string' && item.input_text !== '' ? { input: bounded(item.input_text) } : {}),
      ...(item.output === undefined ? {} : { output: bounded(item.output) }),
      ...(typeof item.error === 'string' ? { error: item.error } : {}) } } };
  return { method: 'activity.updated', eventId: `evt-${digest([nativeSessionId, promptId, item.item_id, 'activity.updated', data])}`, data };
}
