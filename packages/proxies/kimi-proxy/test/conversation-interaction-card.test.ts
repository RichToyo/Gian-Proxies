import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectConversationInteraction } from '../src/runtime/conversation-interaction-card.js';
import { questionResponse } from '../src/runtime/conversation-interaction.js';
import { proxyNotificationSchema } from '@gian/proxy-protocol';

function validateCard(data: Record<string, unknown>): void {
  proxyNotificationSchema.parse({ jsonrpc: '2.0', method: 'interaction.requested', params: {
    eventId: 'evt-1', sessionId: 's', streamId: 'stream', sequence: 1,
    turnId: 'turn', sourceTurnId: 'prompt', emittedAt: '2026-11-16T12:00:00Z', data,
  } });
}

test('native approval produces explicit actions and no automatic answer', () => {
  const result = projectConversationInteraction({ type: 'interaction', status: 'pending', kind: 'approval', interaction_id: 'i1',
    request: { tool_name: 'Bash', action: 'run pwd', expires_at: '2026-11-16T12:00:00Z' } });
  assert.equal(result.data.interactionId, 'apr:i1');
  validateCard(result.data);
  assert.deepEqual((result.data.actions as Array<Record<string, unknown>>).map(action => action.id), ['approved', 'rejected']);
  assert.equal('decision' in result.data, false);
});

test('separate native free-text answers remain attributable to their question', () => {
  const result = projectConversationInteraction({ type: 'interaction', status: 'pending', kind: 'question', interaction_id: 'i2',
    request: { questions: [
      { id: 'q1', question: 'First?', allow_other: true, options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
      { id: 'q2', question: 'Second?', allow_other: true, multi_select: true, options: [{ id: 'c', label: 'C' }, { id: 'd', label: 'D' }] },
    ] } });
  assert.deepEqual((result.data.inputs as Array<Record<string, unknown>>).map(input => input.id), ['q1', 'gian-kimi-other-0', 'q2', 'gian-kimi-other-1']);
  validateCard(result.data);
  assert.deepEqual(questionResponse('accept', result.questions!, { 'gian-kimi-other-0': 'custom one', q2: ['c'], 'gian-kimi-other-1': 'custom two' }),
    { kind: 'question', answers: { q1: { kind: 'other', text: 'custom one' }, q2: { kind: 'multi_with_other', option_ids: ['c'], other_text: 'custom two' } } });
});
