export type NativeQuestion = { id: string; question: string; options: Array<{ id: string; label: string; description?: string }>;
  multi_select?: boolean; allow_other?: boolean };

export function otherInputId(questions: NativeQuestion[], index: number): string {
  const ids = new Set(questions.map(question => question.id));
  let prefix = 'gian-kimi-other-';
  while (questions.some((_, position) => ids.has(`${prefix}${position}`))) prefix = `_${prefix}`;
  return `${prefix}${index}`;
}

export function interactionEndpoint(sessionId: string, interactionId: string): string {
  if (!sessionId || !interactionId) throw new Error('Kimi interaction requires native session and interaction IDs.');
  return `/api/v1/sessions/${encodeURIComponent(sessionId)}/interactions/${encodeURIComponent(interactionId)}`;
}

/** Called only for an explicit Host action. No response is generated merely
 * because the native server requested an approval. */
export function approvalResponse(action: string, feedback?: unknown): Record<string, unknown> {
  if (action !== 'approved' && action !== 'rejected') throw new Error('Kimi approval action was not advertised.');
  return { kind: 'approval', decision: action,
    ...(typeof feedback === 'string' && feedback !== '' ? { feedback } : {}) };
}

export function questionResponse(action: string, questions: NativeQuestion[], values: Record<string, unknown>): Record<string, unknown> {
  if (action === 'decline') return { kind: 'question', dismissed: true };
  if (action !== 'accept' || questions.length === 0 || questions.length > 4) throw new Error('Invalid Kimi question action or questions.');
  const note = values.note;
  if (note !== undefined && typeof note !== 'string') throw new Error('Invalid Kimi question free-text answer.');
  const otherText = typeof note === 'string' && note !== '' ? note : undefined;
  const otherTargets = questions.filter(question => question.allow_other === true);
  if (otherText !== undefined && otherTargets.length !== 1) throw new Error('Kimi question free-text answer is ambiguous.');
  const answers: Record<string, unknown> = {};
  for (const [index, question] of questions.entries()) {
    if (!question.id || Object.hasOwn(answers, question.id) || !Array.isArray(question.options)) throw new Error('Invalid Kimi question identity.');
    const choices = new Set(question.options.map(option => option.id));
    if (choices.size !== question.options.length || [...choices].some(choice => !choice)) throw new Error('Invalid Kimi question options.');
    const value = values[question.id];
    const individual = values[otherInputId(questions, index)];
    if (individual !== undefined && typeof individual !== 'string') throw new Error('Invalid Kimi question free-text answer.');
    if (typeof individual === 'string' && individual !== '' && question.allow_other !== true) throw new Error('Kimi question does not allow a free-text answer.');
    if (typeof individual === 'string' && individual !== '' && otherText !== undefined) throw new Error('Kimi question free-text answer is ambiguous.');
    const other = typeof individual === 'string' && individual !== '' ? individual
      : otherText !== undefined && question === otherTargets[0] ? otherText : undefined;
    if (question.multi_select === true) {
      if (value !== undefined && (!Array.isArray(value) || value.some(option => typeof option !== 'string' || !choices.has(option)))) throw new Error('Invalid Kimi question selection.');
      const selected = (value ?? []) as string[];
      if (new Set(selected).size !== selected.length || (selected.length === 0 && other === undefined)) throw new Error('Invalid Kimi question selection.');
      answers[question.id] = other === undefined ? { kind: 'multi', option_ids: selected }
        : { kind: 'multi_with_other', option_ids: selected, other_text: other };
    } else if (other !== undefined) {
      if (value !== undefined && value !== '') throw new Error('Kimi single-select answer is ambiguous.');
      answers[question.id] = { kind: 'other', text: other };
    } else {
      if (typeof value !== 'string' || !choices.has(value)) throw new Error('Invalid Kimi question selection.');
      answers[question.id] = { kind: 'single', option_id: value };
    }
  }
  return { kind: 'question', answers };
}
