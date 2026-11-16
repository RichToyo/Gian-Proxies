import { isAbsolute } from 'node:path';
import type { OuterInputItem } from '../core/input.js';

type Frame = Record<string, unknown>;
const KEY = 'gian.input.v1';
function object(value: unknown): value is Frame { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function id(value: unknown): value is string { return typeof value === 'string' && value !== ''; }

function normalize(value: OuterInputItem): Frame {
  if (value.type === 'text' && id(value.text)) return { type: 'text', text: value.text };
  if ((value.type === 'localFile' || value.type === 'localImage') && id(value.path)
    && isAbsolute(value.path) && !value.path.split('/').includes('..')) {
    if (value.size !== undefined && (!Number.isSafeInteger(value.size) || (value.size as number) < 0)) throw new Error('Invalid Gian input metadata size.');
    return { type: value.type, path: value.path,
      ...(id(value.name) ? { name: value.name } : {}), ...(id(value.mime) ? { mime: value.mime } : {}),
      ...(typeof value.size === 'number' ? { size: value.size } : {}) };
  }
  if (value.type === 'skill' && id(value.name) && id(value.path)) return { type: 'skill', name: value.name, path: value.path };
  throw new Error('Gian input cannot be represented in Kimi metadata.');
}

/** Only user-submitted, protocol-shaped input is stored in native client
 * metadata. No credentials, environment or Provider configuration are added. */
export function conversationInputMetadata(promptId: string, input: OuterInputItem[]): Frame {
  if (!id(promptId) || input.length === 0) throw new Error('Invalid Gian input metadata identity.');
  const normalized = input.map(normalize);
  // Native history already stores user text. Retain only segment lengths so
  // metadata neither duplicates prompt contents nor doubles large requests.
  const metadata = { [KEY]: { promptId, input: normalized.map(value => value.type === 'text'
    ? { type: 'text', length: (value.text as string).length } : value) } };
  if (Buffer.byteLength(JSON.stringify(metadata), 'utf8') > 1024 * 1024) throw new Error('Gian input metadata exceeds its size budget.');
  return metadata;
}

/** Restore metadata only when its prompt, text, attachment kinds and skill
 * identities agree with native history. Missing metadata is not fabricated. */
export function restoreConversationInput(item: Frame): Frame[] | null {
  if (!object(item.metadata) || !Object.hasOwn(item.metadata, KEY)) return null;
  const stored = item.metadata[KEY];
  if (!object(stored) || !id(stored.promptId) || !Array.isArray(stored.input) || !Array.isArray(item.prompt_ids)
    || !item.prompt_ids.includes(stored.promptId) || !Array.isArray(item.attachments) || !Array.isArray(item.skills)
    || typeof item.text !== 'string') throw new Error('Invalid Gian input metadata in Kimi history.');
  if (Buffer.byteLength(JSON.stringify(stored), 'utf8') > 1024 * 1024) throw new Error('Gian input metadata exceeds its size budget.');
  let cursor = 0;
  let remainingText = stored.input.filter(value => object(value) && value.type === 'text').length;
  const input = stored.input.map(value => {
    if (!object(value)) throw new Error('Invalid Gian input metadata item.');
    if (value.type === 'text') {
      if (!Number.isSafeInteger(value.length) || (value.length as number) <= 0) throw new Error('Invalid Gian input metadata text length.');
      const end = cursor + (value.length as number);
      const text = (item.text as string).slice(cursor, end);
      if (text.length !== value.length) throw new Error('Gian input metadata does not match Kimi history.');
      cursor = end; remainingText -= 1;
      if (remainingText > 0) {
        if ((item.text as string)[cursor] !== '\n') throw new Error('Gian input metadata does not match Kimi history.');
        cursor += 1;
      }
      return { type: 'text', text };
    }
    return normalize(value as OuterInputItem);
  });
  const text = input.filter(value => value.type === 'text').map(value => value.text).join('\n');
  const attachments = input.filter(value => value.type === 'localFile' || value.type === 'localImage');
  const skills = input.filter(value => value.type === 'skill');
  if (text !== item.text || attachments.length !== item.attachments.length || skills.length !== item.skills.length) {
    throw new Error('Gian input metadata does not match Kimi history.');
  }
  for (const [index, attachment] of attachments.entries()) {
    const native = item.attachments[index];
    if (!object(native) || native.kind !== (attachment.type === 'localImage' ? 'image' : 'file')) throw new Error('Gian attachment metadata does not match Kimi history.');
  }
  for (const [index, skill] of skills.entries()) {
    const native = item.skills[index];
    if (!object(native) || native.name !== skill.name || (native.path !== undefined && native.path !== skill.path)) {
      throw new Error('Gian skill metadata does not match Kimi history.');
    }
  }
  return input;
}
