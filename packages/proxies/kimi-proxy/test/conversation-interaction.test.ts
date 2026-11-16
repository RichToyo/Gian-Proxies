import assert from 'node:assert/strict';
import { test } from 'node:test';
import { approvalResponse, interactionEndpoint, questionResponse } from '../src/runtime/conversation-interaction.js';

// Native shapes come from kap-server 2.6.2 protocol/interaction.ts and question.ts.
test('approval requires an explicit advertised action', () => {
  assert.deepEqual(approvalResponse('approved'), { kind: 'approval', decision: 'approved' });
  assert.deepEqual(approvalResponse('rejected', 'No'), { kind: 'approval', decision: 'rejected', feedback: 'No' });
  assert.throws(() => approvalResponse(''), /not advertised/);
  assert.equal(interactionEndpoint('s/1', 'i/2'), '/api/v1/sessions/s%2F1/interactions/i%2F2');
});

test('question selections use native interaction bodies and reject ambiguity', () => {
  const questions = [{ id: 'q1', question: 'Pick', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], multi_select: true, allow_other: true }];
  assert.deepEqual(questionResponse('decline', questions, {}), { kind: 'question', dismissed: true });
  assert.deepEqual(questionResponse('accept', questions, { q1: ['a'], note: 'custom' }),
    { kind: 'question', answers: { q1: { kind: 'multi_with_other', option_ids: ['a'], other_text: 'custom' } } });
  assert.throws(() => questionResponse('accept', questions, { q1: ['unknown'] }), /selection/);
  assert.throws(() => questionResponse('accept', [questions[0]!, { ...questions[0]!, id: 'q2' }], { note: 'ambiguous' }), /ambiguous/);
  assert.deepEqual(questionResponse('accept', [{ id: 'one', question: 'Pick', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }], { one: 'a' }),
    { kind: 'question', answers: { one: { kind: 'single', option_id: 'a' } } });
});
