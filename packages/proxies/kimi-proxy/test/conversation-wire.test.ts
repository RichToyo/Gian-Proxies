import assert from 'node:assert/strict';
import { test } from 'node:test';

import { conversationSubscription, parseConversationControl } from '../src/runtime/conversation-wire.js';

// Control shapes match kap-server 2.6.2 ws-control.ts and wsConnectionV1.test.ts.
test('2.6.2 subscribes one session with a native request id', () => {
  assert.deepEqual(conversationSubscription('subscribe', 'sub', 's1'), { type: 'subscribe', request_id: 'sub', session_id: 's1' });
  assert.deepEqual(conversationSubscription('unsubscribe', 'r2', 's1'), { type: 'unsubscribe', request_id: 'r2', session_id: 's1' });
  assert.throws(() => conversationSubscription('subscribe', '', 's1'));
  assert.throws(() => conversationSubscription('subscribe', 'sub', ''));
});

test('2.6.2 control responses preserve request and error identities', () => {
  assert.deepEqual(parseConversationControl('{"type":"response","request_id":"sub","code":0}'), { type: 'response', requestId: 'sub', code: 0 });
  assert.deepEqual(parseConversationControl('{"type":"response","request_id":"r1","code":40406,"msg":"task not found"}'), { type: 'response', requestId: 'r1', code: 40406, message: 'task not found' });
  assert.deepEqual(parseConversationControl('{"type":"ping"}'), { type: 'ping' });
  assert.throws(() => parseConversationControl('{"type":"response","request_id":"r1","code":"0"}'));
  assert.throws(() => parseConversationControl('{"type":"response","code":0}'));
});

test('unsequenced data is retained without inventing cursors', () => {
  const frame = { type: 'turns', session_id: 's1', agent_id: 'main', turns: [], has_more: false };
  assert.deepEqual(parseConversationControl(JSON.stringify(frame)), { type: 'other', frame });
  assert.throws(() => parseConversationControl('[]'));
  assert.throws(() => parseConversationControl('{}'));
});
