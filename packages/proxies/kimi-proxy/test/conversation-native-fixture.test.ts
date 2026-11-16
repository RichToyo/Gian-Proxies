import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { proxyNotificationSchema } from '@gian/proxy-protocol';
import { KimiConversationTurn } from '../src/runtime/conversation-turn.js';

// Captured from official Kimi 2.6.2 on hosted macOS ARM64 with an isolated
// local mock model. Only session_id was replaced; no real Provider was used.
// Evidence: RichLogic/Gian-Dev Actions run 43917143747.
test('official 2.6.2 native text turn projects faithfully', async () => {
  const native = JSON.parse(readFileSync(resolve('test/fixtures/native-conversation-2.6.2.json'), 'utf8')) as Array<Record<string, unknown>>;
  const events: Array<{ method: string; params: Record<string, unknown> }> = [];
  let sequence = 0, finalized = 0;
  const turn = new KimiConversationTurn({ sessionId: 'gian-session', nativeSessionId: 'fixture-session', streamId: 'stream',
    turnId: 'gian-turn', promptId: 'gian-probe-prompt', nextSequence: () => ++sequence,
    emit: event => events.push(event), onFinalized: () => { finalized += 1; } });
  for (const frame of native) turn.receive(frame);
  await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
  assert.equal(finalized, 1);
  assert.equal(turn.getNativeTurnNumber(), 0);
  assert.deepEqual(events.map(event => event.method), ['content.delta', 'content.delta', 'content.completed', 'usage.updated', 'turn.completed']);
  assert.equal((events.find(event => event.method === 'content.completed')?.params.data as Record<string, unknown>).content, 'hello world');
  assert.deepEqual((events.find(event => event.method === 'usage.updated')?.params.data as Record<string, unknown>).conversation,
    { mode: 'delta', inputTokens: 10, outputTokens: 4, cachedInputTokens: 0, totalTokens: 14 });
  for (const event of events) proxyNotificationSchema.parse({ jsonrpc: '2.0', ...event });
});
