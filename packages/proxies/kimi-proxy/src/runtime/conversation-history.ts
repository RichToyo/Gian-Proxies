/** Read 2.6.2 conversation pages using the native ordinal cursor. Pages are
 * oldest-first but requested newest page first. Do not synthesize event seqs. */
type NativeTurn = Record<string, unknown> & { turn_id: string; ordinal: number; items: unknown[] };
type GetPage = (path: string, query: Record<string, number>) => Promise<unknown>;

export async function fetchConversationHistory(get: GetPage, sessionId: string, agentId = 'main'): Promise<NativeTurn[]> {
  if (!sessionId || !agentId) throw new Error('Kimi conversation history requires native session and agent IDs.');
  const path = `/api/v1/sessions/${encodeURIComponent(sessionId)}/agents/${encodeURIComponent(agentId)}/turns`;
  const pages: NativeTurn[][] = [];
  const seen = new Set<string>();
  let before: number | undefined;
  for (let pageNumber = 0; pageNumber < 1_000; pageNumber += 1) {
    const raw = await get(path, { page_size: 200, ...(before === undefined ? {} : { before_ordinal: before }) });
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('Invalid Kimi conversation history page.');
    const page = raw as Record<string, unknown>;
    if (!Array.isArray(page.turns) || typeof page.has_more !== 'boolean') throw new Error('Invalid Kimi conversation history page.');
    let previous = -1;
    const turns: NativeTurn[] = [];
    for (const value of page.turns) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid Kimi conversation turn.');
      const turn = value as Record<string, unknown>;
      if (typeof turn.turn_id !== 'string' || turn.turn_id.length === 0 || seen.has(turn.turn_id)
        || !Number.isSafeInteger(turn.ordinal) || (turn.ordinal as number) < 0 || (turn.ordinal as number) <= previous
        || (before !== undefined && (turn.ordinal as number) >= before) || !Array.isArray(turn.items)) {
        throw new Error('Invalid Kimi conversation turn order or identity.');
      }
      previous = turn.ordinal as number;
      seen.add(turn.turn_id);
      turns.push(turn as NativeTurn);
    }
    pages.unshift(turns);
    if (!page.has_more) return pages.flat();
    if (turns.length === 0) throw new Error('Kimi conversation history cannot advance its native cursor.');
    before = turns[0]!.ordinal;
  }
  throw new Error('Kimi conversation history exceeded its page safety limit.');
}
