import assert from 'node:assert/strict';
import { test } from 'node:test';
import { replayEventSchemaUnion } from '@gian/proxy-protocol';
import { buildConversationReplay } from '../src/runtime/conversation-replay.js';
import { projectConversationItem } from '../src/runtime/conversation-item.js';
import { conversationInputMetadata } from '../src/runtime/conversation-input-metadata.js';

test('native replay shares terminal and content identities with live projection', () => {
  const time = '2026-11-16T12:00:00Z';
  const text = { type: 'assistant_message', item_id: 'answer', status: 'ended', text: 'Hello', created_at: time };
  const turn = { turn_id: 'native-turn', started_at: time, status: 'ended', outcome: 'completed', items: [
    { type: 'user_message', item_id: 'user', placement: 'opener', prompt_ids: ['p'], text: 'Hi', attachments: [], skills: [], created_at: time }, text,
  ] };
  const events = buildConversationReplay({ sessionId: 's', nativeSessionId: 'native', replayStreamId: 'replay', turns: [turn], messages: [] });
  assert.deepEqual(events.map(event => event.method), ['turn.started', 'input.recorded', 'content.completed', 'turn.completed']);
  assert.equal(events[2]!.eventId, projectConversationItem('native', 'p', text)?.eventId);
  for (const event of events) replayEventSchemaUnion.parse(event);
});

test('unattributable or unrepresentable native inputs never become invented replay', () => {
  const time = '2026-11-16T12:00:00Z';
  const opener = { type: 'user_message', item_id: 'user', placement: 'opener', prompt_ids: ['p'], text: 'Hi', attachments: [{ file_id: 'f1' }], skills: [], created_at: time };
  const turn = { turn_id: 't1', started_at: time, status: 'ended', outcome: 'completed', items: [opener] };
  const context = { sessionId: 's', nativeSessionId: 'native', replayStreamId: 'replay', turns: [turn], messages: [] };
  const events = buildConversationReplay(context);
  assert.deepEqual(events.find(event => event.method === 'input.recorded')?.data.input, [{ type: 'text', text: 'Hi' }]);
  assert.equal((events.find(event => event.method === 'activity.updated')?.data.presentation as { data: { message: string } }).data.message.includes('attachment paths'), true);
  for (const event of events) replayEventSchemaUnion.parse(event);
  assert.throws(() => buildConversationReplay({ ...context, turns: [{ ...turn, items: [{ ...opener, prompt_ids: ['p', 'other'] }] }] }), /faithfully identify/);
});

test('new native metadata restores the exact submitted local image and skill', () => {
  const time = '2026-11-16T12:00:00Z';
  const input = [{ type: 'text', text: 'Inspect' }, { type: 'localImage', path: '/workspace/a.png' },
    { type: 'skill', name: 'audit', path: '/workspace/skills/audit' }];
  const opener = { type: 'user_message', item_id: 'u', placement: 'opener', prompt_ids: ['p'], text: 'Inspect',
    attachments: [{ kind: 'image', file_id: 'f1' }], skills: [{ name: 'audit', path: '/workspace/skills/audit' }],
    metadata: conversationInputMetadata('p', input), created_at: time };
  const turn = { turn_id: 't', started_at: time, status: 'ended', outcome: 'completed', items: [opener] };
  const events = buildConversationReplay({ sessionId: 's', nativeSessionId: 'native', replayStreamId: 'replay', turns: [turn], messages: [] });
  assert.deepEqual(events.find(event => event.method === 'input.recorded')?.data.input, input);
  for (const event of events) replayEventSchemaUnion.parse(event);
});

test('owned background notification history stays in the original Gian turn', () => {
  const time = '2026-11-16T12:00:00Z';
  const primary = { turn_id: 't1', started_at: time, status: 'ended', outcome: 'completed', items: [
    { type: 'user_message', item_id: 'u', placement: 'opener', prompt_ids: ['p'], text: 'Run', attachments: [], skills: [], created_at: time },
    { type: 'tool_call', item_id: 'tool', name: 'Agent', status: 'ended', outcome: 'completed', task_id: 'bg', created_at: time },
  ] };
  const notice = { type: 'notification', item_id: 'n', status: 'ended', outcome: 'completed', title: 'Done', body: 'Finished',
    severity: 'info', task_id: 'bg', source: { kind: 'background_task', id: 'bg' }, created_at: time };
  const answer = { type: 'assistant_message', item_id: 'answer', status: 'ended', text: 'Noted', created_at: time };
  const continuation = { turn_id: 't2', started_at: time, status: 'ended', outcome: 'completed', items: [notice, answer] };
  const context = { sessionId: 's', nativeSessionId: 'native', replayStreamId: 'replay', turns: [primary, continuation], messages: [] };
  const events = buildConversationReplay(context);
  assert.equal(events.filter(event => event.method === 'turn.started').length, 1);
  assert.equal(events.filter(event => event.method === 'turn.completed').length, 1);
  assert.equal(events.find(event => event.method === 'content.completed')?.eventId, projectConversationItem('native', 'p', answer)?.eventId);
  assert.equal(events.find(event => event.eventId === projectConversationItem('native', 'p', notice)?.eventId)?.method, 'activity.updated');
  for (const event of events) replayEventSchemaUnion.parse(event);
  assert.throws(() => buildConversationReplay({ ...context, turns: [primary, { ...continuation,
    items: [{ ...notice, task_id: 'foreign', source: { kind: 'background_task', id: 'foreign' } }, answer] }] }), /attribute/);
});

test('native system compaction history retains its own native turn identity', () => {
  const time = '2026-11-16T12:00:00Z';
  const turn = { turn_id: 'system-turn', kind: 'system', started_at: time, status: 'ended', outcome: 'completed',
    items: [{ type: 'system', kind: 'compaction', item_id: 'compact', status: 'ended', outcome: 'completed', created_at: time, summary: 'Summary' }] };
  const events = buildConversationReplay({ sessionId: 's', nativeSessionId: 'native', replayStreamId: 'replay', turns: [turn], messages: [] });
  assert.deepEqual(events.map(event => event.method), ['turn.started', 'activity.updated', 'turn.completed']);
  assert.ok(events.every(event => event.sourceTurnId === 'system-turn'));
  for (const event of events) replayEventSchemaUnion.parse(event);
});
