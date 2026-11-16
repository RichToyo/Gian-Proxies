import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectConversationItem } from '../src/runtime/conversation-item.js';

test('live and replay use the same immutable native text identity', () => {
  const item = { item_id: 'msg1', type: 'assistant_message', status: 'ended', text: 'Hello' };
  const live = projectConversationItem('s1', 'p1', item);
  assert.deepEqual(live, projectConversationItem('s1', 'p1', structuredClone(item)));
  assert.equal(live?.method, 'content.completed');
  assert.deepEqual(live?.data, { contentId: 'kimi:p1:msg1', kind: 'text', format: 'markdown', content: 'Hello' });
  assert.notEqual(live?.eventId, projectConversationItem('s1', 'p1', { ...item, text: 'Hello again' })?.eventId);
  assert.equal(projectConversationItem('s1', 'p1', { ...item, status: 'running' }), null);
});

test('native tool outcome is required before claiming completion', () => {
  const tool = { item_id: 'tool1', type: 'tool_call', name: 'Bash', status: 'running', input: { command: 'pwd' } };
  assert.equal(projectConversationItem('s1', 'p1', tool)?.data.status, 'running');
  assert.equal(projectConversationItem('s1', 'p1', { ...tool, status: 'ended', outcome: 'completed' })?.data.status, 'succeeded');
  assert.equal(projectConversationItem('s1', 'p1', { ...tool, status: 'ended', outcome: 'interrupted' })?.data.status, 'cancelled');
  assert.throws(() => projectConversationItem('s1', 'p1', { ...tool, status: 'ended' }), /outcome/);
});
