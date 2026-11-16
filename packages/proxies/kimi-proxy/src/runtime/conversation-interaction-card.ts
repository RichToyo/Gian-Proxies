import { otherInputId, type NativeQuestion } from './conversation-interaction.js';

type Frame = Record<string, unknown>;
function object(value: unknown): value is Frame { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function id(value: unknown): value is string { return typeof value === 'string' && value !== ''; }

/** Convert a pending native interaction to an explicit Gian card. This function
 * creates no response and never chooses an approval action. */
export function projectConversationInteraction(frame: Frame): { data: Frame; questions?: NativeQuestion[] } {
  if (frame.type !== 'interaction' || frame.status !== 'pending' || !id(frame.interaction_id) || !object(frame.request)) {
    throw new Error('Invalid pending Kimi interaction.');
  }
  if (frame.kind === 'approval') {
    if (!id(frame.request.tool_name) || typeof frame.request.action !== 'string') throw new Error('Invalid Kimi approval request.');
    const interactionId = `apr:${frame.interaction_id}`;
    return { data: { interactionId, title: frame.request.tool_name, description: `Kimi requests: ${frame.request.action}`,
      presentation: { kind: 'permission', tone: 'warning' }, inputs: [],
      actions: [{ id: 'approved', label: 'Allow', style: 'primary' }, { id: 'rejected', label: 'Deny', style: 'danger' }],
      context: { approvalId: frame.interaction_id, toolName: frame.request.tool_name,
        ...(frame.request.tool_input_display === undefined ? {} : { input: frame.request.tool_input_display }),
        ...(typeof frame.request.expires_at === 'string' ? { expiresAt: frame.request.expires_at } : {}) } } };
  }
  if (frame.kind !== 'question' || !Array.isArray(frame.request.questions)
    || frame.request.questions.length < 1 || frame.request.questions.length > 4) throw new Error('Invalid Kimi question request.');
  const questions: NativeQuestion[] = [];
  for (const value of frame.request.questions) {
    if (!object(value) || !id(value.id) || !id(value.question) || !Array.isArray(value.options)
      || value.options.length < 2 || value.options.length > 4) throw new Error('Invalid Kimi question.');
    const options = value.options.map(option => {
      if (!object(option) || !id(option.id) || !id(option.label)) throw new Error('Invalid Kimi question option.');
      return { id: option.id, label: option.label, ...(typeof option.description === 'string' ? { description: option.description } : {}) };
    });
    if (new Set(options.map(option => option.id)).size !== options.length || questions.some(question => question.id === value.id)) throw new Error('Duplicate Kimi question identity.');
    questions.push({ id: value.id, question: value.question, options,
      ...(value.multi_select === true ? { multi_select: true } : {}), ...(value.allow_other === true ? { allow_other: true } : {}) });
  }
  const inputs: Frame[] = [];
  for (const [index, question] of questions.entries()) {
    const descriptions = question.options.filter(option => option.description).map(option => `${option.label}: ${option.description}`);
    inputs.push({ id: question.id, type: question.multi_select ? 'multi_select' : 'single_select',
      label: question.question, required: !question.allow_other,
      choices: question.options.map(option => ({ value: option.id, displayName: option.label })),
      ...(descriptions.length ? { description: descriptions.join('\n') } : {}) });
    if (question.allow_other) inputs.push({ id: otherInputId(questions, index), type: 'text',
      label: `Other answer: ${question.question}`, required: false });
  }
  return { questions, data: { interactionId: `q:${frame.interaction_id}`, title: 'Question',
    presentation: { kind: 'questions', tone: 'info' }, inputs,
    actions: [{ id: 'accept', label: 'Submit', style: 'primary' }, { id: 'decline', label: 'Dismiss', style: 'danger' }],
    context: { questionId: frame.interaction_id, 'gian.cancelInputOptionalActions': ['decline'] } } };
}
