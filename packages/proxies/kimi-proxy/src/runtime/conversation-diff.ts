import { renderUnifiedDiff } from '../core/diff.js';

type Request = (path: string, query: Record<string, string | number>, timeoutMs: number) => Promise<unknown>;
type Diff = { diff: string; truncated: boolean; files: Array<{ path: string; status: string }> };
function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }

/** Kimi 2.6.2 file history uses turn_number and start/end phases. A missing
 * checkpoint is unknown, not an empty successful diff. */
export async function fetchConversationDiff(request: Request, sessionId: string, turnNumber: number): Promise<Diff | null> {
  if (!sessionId || !Number.isSafeInteger(turnNumber) || turnNumber < 0) throw new Error('Invalid Kimi file-history identity.');
  const root = `/api/v1/sessions/${encodeURIComponent(sessionId)}/file-history`;
  const deadline = Date.now() + 8_000;
  const raw = await request(`${root}/changes`, { turn_number: turnNumber }, 5_000);
  if (!object(raw) || typeof raw.recorded !== 'boolean' || !Array.isArray(raw.changes)) throw new Error('Invalid Kimi file-history response.');
  if (!raw.recorded) return null;
  const files: Diff['files'] = [], patches: string[] = [];
  let truncated = raw.changes.length > 20;
  for (const value of raw.changes.slice(0, 20)) {
    if (!object(value) || typeof value.path !== 'string' || !value.path
      || !['added', 'modified', 'deleted'].includes(String(value.status))) throw new Error('Invalid Kimi file-history change.');
    files.push({ path: value.path, status: value.status as string });
    if (value.binary === true || value.oversize === true || Date.now() >= deadline) { truncated = true; continue; }
    try {
      const start = await request(`${root}/content`, { turn_number: turnNumber, path: value.path, phase: 'start' }, Math.min(5_000, Math.max(1, deadline - Date.now())));
      if (Date.now() >= deadline) { truncated = true; continue; }
      const end = await request(`${root}/content`, { turn_number: turnNumber, path: value.path, phase: 'end' }, Math.min(5_000, Math.max(1, deadline - Date.now())));
      if (!object(start) || !object(end) || (start.content !== null && !object(start.content))
        || (end.content !== null && !object(end.content))) throw new Error('Invalid Kimi file-history content.');
      if (start.content === null && value.status !== 'added') { truncated = true; continue; }
      if (end.content === null && value.status !== 'deleted') { truncated = true; continue; }
      if ((object(start.content) && typeof start.content.content !== 'string')
        || (object(end.content) && typeof end.content.content !== 'string')) { truncated = true; continue; }
      const before = object(start.content) && typeof start.content.content === 'string' ? start.content.content : '';
      const after = object(end.content) && typeof end.content.content === 'string' ? end.content.content : '';
      if ((object(start.content) && start.content.binary === true) || (object(end.content) && end.content.binary === true)) { truncated = true; continue; }
      const patch = renderUnifiedDiff(value.path, before, after);
      if (patch.truncated) truncated = true;
      if (patch.diff) patches.push(patch.diff);
    } catch { truncated = true; }
  }
  return { diff: patches.join('\n'), truncated, files };
}
