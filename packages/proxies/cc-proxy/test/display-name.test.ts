import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { sanitizeDisplayName } from '../src/runtime/claude-discovery.js';
import { ClaudeStreamRuntime } from '../src/runtime/claude-stream-runtime.js';

// SESSION-NAME-001: the Claude CLI `--name` value is sanitized before it hits
// the argv so a pasted multi-line name can't smuggle extra args / blow up the
// terminal title.
test('sanitizeDisplayName trims surrounding whitespace', () => {
  assert.equal(sanitizeDisplayName('  hello world  '), 'hello world');
});

test('sanitizeDisplayName replaces control chars (CR/LF/tab) with spaces', () => {
  assert.equal(sanitizeDisplayName('a\nb\tc\rd'), 'a b c d');
});

test('sanitizeDisplayName returns null for empty / whitespace / nullish', () => {
  assert.equal(sanitizeDisplayName(''), null);
  assert.equal(sanitizeDisplayName('   '), null);
  assert.equal(sanitizeDisplayName('\n\t'), null);
  assert.equal(sanitizeDisplayName(null), null);
  assert.equal(sanitizeDisplayName(undefined), null);
});

test('sanitizeDisplayName caps length at 200 chars', () => {
  assert.equal(sanitizeDisplayName('x'.repeat(300))!.length, 200);
});

test('sanitizeDisplayName preserves unicode', () => {
  assert.equal(sanitizeDisplayName('Séance 🚀'), 'Séance 🚀');
});

test('the first launch receives sanitized --name; a resumed launch never reasserts a stale name', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gian-claude-name-argv-'));
  const argvLog = join(dir, 'argv.jsonl');
  const previous = {
    CLAUDE_BIN: process.env.CLAUDE_BIN,
    FAKE_CLAUDE_ARGV_LOG: process.env.FAKE_CLAUDE_ARGV_LOG,
  };
  process.env.CLAUDE_BIN = resolve('test/fixtures/fake-claude-runtime.mjs');
  process.env.FAKE_CLAUDE_ARGV_LOG = argvLog;
  // A short idle timeout stops the process between the two turns, so the
  // second turn has to resume the native session in a new process.
  const runtime = new ClaudeStreamRuntime({ idleTimeoutMs: 50 });
  const nativeSessionId = '00000000-0000-4000-8000-000000000031';
  const launches = () => readFileSync(argvLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string[]);

  try {
    await runtime.spawnSession({
      sessionId: 'session-name-argv',
      claudeSessionId: nativeSessionId,
      cwd: dir,
      model: null,
      isResume: false,
    });

    let replied = new Promise<void>(resolve => runtime.once('channelReply', () => resolve()));
    await runtime.sendMessage('session-name-argv', 'first', {
      permissionMode: 'bypassPermissions',
      displayName: '  My\nClaude Session  ',
    });
    await replied;
    const firstArgs = launches()[0]!;
    assert.deepEqual(
      firstArgs.slice(firstArgs.indexOf('--session-id'), firstArgs.indexOf('--session-id') + 4),
      ['--session-id', nativeSessionId, '--name', 'My Claude Session'],
    );
    assert.equal(firstArgs.includes('--resume'), false);
    assert.equal(firstArgs.includes('first'), false, 'the prompt never travels in argv');

    await new Promise<void>((resolve) => {
      const onDebug = (message: string) => {
        if (!/exited/.test(message)) return;
        runtime.off('debug', onDebug);
        resolve();
      };
      runtime.on('debug', onDebug);
    });

    replied = new Promise<void>(resolve => runtime.once('channelReply', () => resolve()));
    await runtime.sendMessage('session-name-argv', 'resume', {
      permissionMode: 'bypassPermissions',
      displayName: 'Stale Gian Name',
    });
    await replied;
    const all = launches();
    assert.equal(all.length, 2, 'the idle stop forced exactly one new launch');
    const resumeArgs = all[1]!;
    assert.deepEqual(
      resumeArgs.slice(resumeArgs.indexOf('--resume'), resumeArgs.indexOf('--resume') + 2),
      ['--resume', nativeSessionId],
    );
    assert.equal(resumeArgs.includes('--name'), false);
  } finally {
    await runtime.stop();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
