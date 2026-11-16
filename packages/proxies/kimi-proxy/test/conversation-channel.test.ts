import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KimiConversationChannel } from '../src/runtime/conversation-channel.js';

test('subscription waits for native ACK and snapshot and filters unrelated sessions', async () => {
  const sent: Record<string, unknown>[] = [];
  const received: Record<string, unknown>[] = [];
  const channel = new KimiConversationChannel(frame => sent.push(frame), frame => received.push(frame));
  const ack = channel.subscribe('s1');
  assert.deepEqual(sent, [{ type: 'subscribe', request_id: 'gian-1', session_id: 's1' }]);
  channel.receive(JSON.stringify({ type: 'response', request_id: 'gian-1', code: 0 }));
  let accepted = false;
  void ack.then(() => { accepted = true; });
  await Promise.resolve();
  assert.equal(accepted, false);
  channel.receive(JSON.stringify({ type: 'turns', session_id: 's1', agent_id: 'main', turns: [], has_more: false }));
  await ack;
  const refresh = channel.refresh('s1');
  assert.deepEqual(sent.at(-1), { type: 'unsubscribe', request_id: 'gian-2', session_id: 's1' });
  channel.receive('{"type":"response","request_id":"gian-2","code":0}');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sent.at(-1), { type: 'subscribe', request_id: 'gian-3', session_id: 's1' });
  channel.receive('{"type":"response","request_id":"gian-3","code":0}');
  channel.receive(JSON.stringify({ type: 'turns', session_id: 's1', agent_id: 'main', turns: [], has_more: false }));
  await refresh;
  channel.receive(JSON.stringify({ type: 'turns', session_id: 's2', turns: [], has_more: false }));
  channel.receive(JSON.stringify({ type: 'turns', session_id: 's1', turns: [], has_more: false }));
  channel.receive('{"type":"ping"}');
  assert.deepEqual(received, [{ type: 'turns', session_id: 's1', agent_id: 'main', turns: [], has_more: false },
    { type: 'turns', session_id: 's1', agent_id: 'main', turns: [], has_more: false }, { type: 'turns', session_id: 's1', turns: [], has_more: false }]);
  assert.deepEqual(sent.at(-1), { type: 'pong' });
  channel.forget('s1');
  assert.deepEqual(sent.at(-1), { type: 'unsubscribe', request_id: 'gian-4', session_id: 's1' });
  channel.close();
});

test('negative ACK and disconnect reject pending subscriptions', async () => {
  const channel = new KimiConversationChannel(() => {}, () => {});
  const rejected = channel.subscribe('s1');
  channel.receive('{"type":"response","request_id":"gian-1","code":40401}');
  await assert.rejects(rejected, /40401/);
  const detached = channel.subscribe('s2');
  channel.close();
  await assert.rejects(detached, /closed before subscription/);
  await assert.rejects(channel.subscribe('s3'), /closed/);
});

test('a failed native history snapshot cannot admit a prompt', async () => {
  const channel = new KimiConversationChannel(() => {}, () => {});
  const pending = channel.subscribe('s1');
  channel.receive('{"type":"response","request_id":"gian-1","code":0}');
  channel.receive('{"type":"turns.failed","session_id":"s1","agent_id":"main","code":50001,"msg":"history unavailable"}');
  await assert.rejects(pending, /snapshot failed/);
  channel.close();
});
