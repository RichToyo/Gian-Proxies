import assert from 'node:assert/strict';
import { test } from 'node:test';
import { conversationInputMetadata, restoreConversationInput } from '../src/runtime/conversation-input-metadata.js';

test('native client metadata preserves local input identity and order', () => {
  const input = [{ type: 'text', text: 'Inspect' }, { type: 'localImage', path: '/workspace/image.png', name: 'image.png' },
    { type: 'skill', name: 'audit', path: '/workspace/skills/audit' }];
  const item = { prompt_ids: ['p'], text: 'Inspect', attachments: [{ kind: 'image', file_id: 'f1' }],
    skills: [{ name: 'audit', path: '/workspace/skills/audit' }], metadata: conversationInputMetadata('p', input) };
  assert.deepEqual(restoreConversationInput(item), input);
  assert.throws(() => restoreConversationInput({ ...item, text: 'other' }), /does not match/);
  assert.throws(() => restoreConversationInput({ ...item, prompt_ids: ['different'] }), /Invalid/);
});

test('missing or mismatched native metadata cannot invent a local path', () => {
  assert.equal(restoreConversationInput({}), null);
  const input = [{ type: 'localFile', path: '/workspace/report.txt' }];
  const item = { prompt_ids: ['p'], text: '', attachments: [{ kind: 'image' }], skills: [], metadata: conversationInputMetadata('p', input) };
  assert.throws(() => restoreConversationInput(item), /attachment metadata/);
  assert.throws(() => conversationInputMetadata('p', [{ type: 'localFile', path: '/workspace/../secret' }]), /represented/);
});

test('text segments are reconstructed without storing duplicate user text', () => {
  const input = [{ type: 'text', text: 'first\nline' }, { type: 'text', text: 'second 😀' }];
  const metadata = conversationInputMetadata('p', input);
  assert.equal(JSON.stringify(metadata).includes('first'), false);
  assert.deepEqual(restoreConversationInput({ prompt_ids: ['p'], text: 'first\nline\nsecond 😀', attachments: [], skills: [], metadata }), input);
});
