import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { TokenUsageUpdate } from '@gian/shared';
import { claudeHistoryProjectDir } from '../src/protocol/native-history.js';
import { ClaudeStreamRuntime } from '../src/runtime/claude-stream-runtime.js';

// The streaming runtime against a scriptable fake Claude. Each user message
// is a JSON list of steps the fake performs as one run (see the fixture).

const FAKE = resolve('test/fixtures/fake-claude-scripted.mjs');
const SESSION = 'session-stream';
const NATIVE = '00000000-0000-4000-8000-000000000201';

type Frame = Record<string, any>;

interface Harness {
  runtime: ClaudeStreamRuntime;
  dir: string;
  texts: Array<{ text: string; itemId: string }>;
  replies: string[];
  failures: string[];
  exits: unknown[][];
  usage: TokenUsageUpdate[];
  debug: string[];
  launches(): string[][];
  frames(): Frame[];
  /** Start a turn and wait until the runtime ends it. */
  turn(steps: unknown, options?: Parameters<ClaudeStreamRuntime['sendMessage']>[2]): Promise<string>;
  waitFor(predicate: () => boolean, label: string): Promise<void>;
}

function readJsonLines(path: string): unknown[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

async function withRuntime(
  run: (h: Harness) => Promise<void>,
  options: { runtime?: ConstructorParameters<typeof ClaudeStreamRuntime>[0]; spawn?: Partial<Parameters<ClaudeStreamRuntime['spawnSession']>[0]> } = {},
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'cc-stream-runtime-'));
  const home = join(dir, 'home');
  const cwd = join(dir, 'work');
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const argvLog = join(dir, 'argv.jsonl');
  const framesLog = join(dir, 'frames.jsonl');
  const saved: Record<string, string | undefined> = {
    CLAUDE_BIN: process.env.CLAUDE_BIN,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    HOME: process.env.HOME,
    FAKE_CLAUDE_ARGV_LOG: process.env.FAKE_CLAUDE_ARGV_LOG,
    FAKE_CLAUDE_FRAMES_LOG: process.env.FAKE_CLAUDE_FRAMES_LOG,
  };
  process.env.CLAUDE_BIN = FAKE;
  process.env.HOME = home;
  delete process.env.CLAUDE_CONFIG_DIR;
  process.env.FAKE_CLAUDE_ARGV_LOG = argvLog;
  process.env.FAKE_CLAUDE_FRAMES_LOG = framesLog;

  const runtime = new ClaudeStreamRuntime(options.runtime ?? {});
  const h: Harness = {
    runtime,
    dir: cwd,
    texts: [],
    replies: [],
    failures: [],
    exits: [],
    usage: [],
    debug: [],
    launches: () => readJsonLines(argvLog) as string[][],
    frames: () => readJsonLines(framesLog) as Frame[],
    async turn(steps, sendOptions = { permissionMode: 'default' }) {
      const ended = new Promise<string>((done) => {
        const settle = (outcome: string) => () => {
          runtime.off('channelReply', onReply);
          runtime.off('turnFailed', onFailed);
          runtime.off('processExited', onExited);
          done(outcome);
        };
        const onReply = settle('completed');
        const onFailed = settle('failed');
        const onExited = settle('exited');
        runtime.on('channelReply', onReply);
        runtime.on('turnFailed', onFailed);
        runtime.on('processExited', onExited);
      });
      await runtime.sendMessage(SESSION, typeof steps === 'string' ? steps : JSON.stringify(steps), sendOptions);
      return ended;
    },
    async waitFor(predicate, label) {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (predicate()) return;
        await new Promise((done) => setTimeout(done, 10));
      }
      throw new Error(`timed out: ${label}`);
    },
  };
  runtime.on('assistantText', (_s, text, itemId) => h.texts.push({ text, itemId }));
  runtime.on('channelReply', (_s, text) => h.replies.push(text));
  runtime.on('turnFailed', (_s, detail) => h.failures.push(detail));
  runtime.on('processExited', (...args) => h.exits.push(args));
  runtime.on('tokenUsage', (_s, usage) => h.usage.push(usage));
  runtime.on('debug', (message) => h.debug.push(message));

  try {
    await runtime.spawnSession({
      sessionId: SESSION,
      claudeSessionId: NATIVE,
      cwd,
      model: null,
      isResume: false,
      ...options.spawn,
    });
    await run(h);
  } finally {
    await runtime.stop();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

const userFrames = (frames: Frame[]) => frames.filter((frame) => frame.type === 'user');
const controls = (frames: Frame[], subtype: string) => frames
  .filter((frame) => frame.type === 'control_request' && frame.request?.subtype === subtype)
  .map((frame) => frame.request);
const flag = (args: string[], name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

test('a steer folded into the running turn ends with one reply', async () => {
  await withRuntime(async (h) => {
    const ended = h.turn([{ text: 'working' }, { waitForSteer: true }, { result: 'steered' }]);
    await h.waitFor(() => h.texts.length > 0, 'first text');
    await h.runtime.steer(SESSION, 'also do this');
    assert.equal(await ended, 'completed');
    await new Promise((done) => setTimeout(done, 100));
    assert.deepEqual(h.replies, [''], 'text already streamed is not repeated');
    assert.equal(h.launches().length, 1);
    assert.deepEqual(userFrames(h.frames()).map((frame) => frame.message.content), [
      JSON.stringify([{ text: 'working' }, { waitForSteer: true }, { result: 'steered' }]),
      'also do this',
    ]);
  });
});

test('a steer that arrives as the run ends runs once more inside the same turn', async () => {
  await withRuntime(async (h) => {
    const ended = h.turn([{ wait: 150 }, { result: 'first run' }]);
    await h.waitFor(() => userFrames(h.frames()).length === 1, 'opening message');
    await h.runtime.steer(SESSION, 'late steer');
    assert.equal(await ended, 'completed');
    await new Promise((done) => setTimeout(done, 100));
    assert.deepEqual(h.replies, ['done'], 'the turn ends after the extra run, not after the first result');
    assert.deepEqual(h.failures, []);
  });
});

test('approvals: allow passes the input, deny passes the reason, answers join AskUserQuestion input', async () => {
  await withRuntime(async (h) => {
    const writeInput = { file_path: '/tmp/x', content: 'hi' };
    const question = { questions: [{ question: 'Color?', options: [{ label: 'Red' }, { label: 'Blue' }], multiSelect: true }] };
    h.runtime.on('permissionRequest', (sessionId, requestId, toolName) => {
      if (toolName === 'Write') void h.runtime.respondPermission(sessionId, requestId, 'allow');
      if (toolName === 'Bash') void h.runtime.respondPermission(sessionId, requestId, 'deny', { message: 'not now' });
      if (toolName === 'AskUserQuestion') {
        void h.runtime.respondPermission(sessionId, requestId, 'allow', { answers: { 'Color?': ['Red', 'Blue'] } });
      }
    });
    assert.equal(await h.turn([
      { ask: { tool: 'Write', input: writeInput } },
      { ask: { tool: 'Bash', input: { command: 'rm x' } } },
      { ask: { tool: 'AskUserQuestion', input: question } },
      { result: 'ok' },
    ]), 'completed');
    const answers = h.frames()
      .filter((frame) => frame.type === 'control_response')
      .map((frame) => frame.response.response);
    assert.deepEqual(answers, [
      { behavior: 'allow', updatedInput: writeInput },
      { behavior: 'deny', message: 'not now' },
      { behavior: 'allow', updatedInput: { ...question, answers: { 'Color?': 'Red, Blue' } } },
    ]);
  });
});

test('a withdrawn approval request reaches the service and a late answer is dropped', async () => {
  await withRuntime(async (h) => {
    const requested: string[] = [];
    const cancelled: string[] = [];
    h.runtime.on('permissionRequest', (_s, requestId) => requested.push(requestId));
    h.runtime.on('permissionCancelled', (_s, requestId) => cancelled.push(requestId));
    assert.equal(await h.turn([{ askThenCancel: { tool: 'Bash', input: { command: 'ls' } } }, { result: 'ok' }]), 'completed');
    assert.equal(requested.length, 1);
    assert.deepEqual(cancelled, requested);
    await h.runtime.respondPermission(SESSION, requested[0]!, 'allow');
    assert.equal(h.frames().some((frame) => frame.type === 'control_response'), false);
  });
});

test('usage is reported per turn although Claude reports running totals', async () => {
  await withRuntime(async (h) => {
    const total = (input: number, output: number) => ({
      'claude-sonnet-4-6': { inputTokens: input, outputTokens: output, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    });
    await h.turn([{ result: 'one', modelUsage: total(100, 10) }]);
    await h.turn([{ result: 'two', modelUsage: total(250, 30) }]);
    // A /clear inside Claude resets the running total.
    await h.turn([{ result: 'three', modelUsage: total(40, 5) }]);
    const deltas = h.usage.flatMap((usage) => (usage.conversation ? [usage.conversation] : []));
    assert.deepEqual(deltas.map((delta) => [delta.inputTokens, delta.outputTokens]), [[100, 10], [150, 20], [40, 5]]);
  });
});

test('a resumed session measures usage from the total its transcript saved', async () => {
  await withRuntime(async (h) => {
    const projectDir = claudeHistoryProjectDir(h.dir);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, `${NATIVE}.jsonl`), `${JSON.stringify({
      type: 'cost-state',
      modelUsage: { 'claude-sonnet-4-6': { inputTokens: 1000, outputTokens: 100 } },
    })}\n`);
    await h.turn([{
      result: 'resumed',
      modelUsage: { 'claude-sonnet-4-6': { inputTokens: 1100, outputTokens: 120 } },
    }]);
    const delta = h.usage.find((usage) => usage.conversation)?.conversation;
    assert.equal(delta?.inputTokens, 100);
    assert.equal(delta?.outputTokens, 20);
    assert.equal(flag(h.launches()[0]!, '--resume'), NATIVE);
  }, { spawn: { isResume: true } });
});

test('model, mode and effort change in place; launch-only flags restart with --resume', async () => {
  await withRuntime(async (h) => {
    await h.turn('one', { permissionMode: 'default', effort: 'high' });
    h.runtime.setSessionModel(SESSION, 'opus');
    await h.turn('two', { permissionMode: 'acceptEdits', effort: 'low' });
    assert.equal(h.launches().length, 1, 'settings changed without a restart');
    assert.deepEqual(controls(h.frames(), 'set_model'), [{ subtype: 'set_model', model: 'opus' }]);
    assert.deepEqual(controls(h.frames(), 'set_permission_mode'), [{ subtype: 'set_permission_mode', mode: 'acceptEdits' }]);
    assert.deepEqual(controls(h.frames(), 'apply_flag_settings'), [{ subtype: 'apply_flag_settings', settings: { effortLevel: 'low' } }]);

    await h.turn('bypass', { permissionMode: 'bypassPermissions', effort: 'low' });
    const extra = join(h.dir, 'extra');
    await h.turn('folder', { permissionMode: 'bypassPermissions', effort: 'low', additionalDirectories: [extra] });
    await h.turn('default effort', { permissionMode: 'bypassPermissions', effort: null, additionalDirectories: [extra] });
    const launches = h.launches();
    assert.equal(launches.length, 4);
    const [first, bypass, folder, noEffort] = launches as [string[], string[], string[], string[]];
    assert.equal(flag(first, '--session-id'), NATIVE);
    assert.equal(flag(first, '--effort'), 'high');
    for (const args of [bypass, folder, noEffort]) {
      assert.equal(flag(args, '--resume'), NATIVE);
      assert.equal(flag(args, '--model'), 'opus');
      assert.ok(args.includes('--dangerously-skip-permissions'));
    }
    assert.equal(flag(folder, '--add-dir'), extra);
    assert.equal(flag(noEffort, '--effort'), undefined);
    assert.deepEqual(h.failures, []);
  });
});

test('a process that dies while idle reports nothing; the next turn resumes', async () => {
  await withRuntime(async (h) => {
    await h.turn([{ result: 'ok' }, { exitAfter: 30 }]);
    await h.waitFor(() => h.debug.some((message) => /exited while idle/.test(message)), 'idle exit');
    assert.deepEqual(h.exits, []);
    assert.equal(await h.turn('again'), 'completed');
    assert.equal(flag(h.launches()[1]!, '--resume'), NATIVE);
  });
});

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const idleStops = (h: Harness) => h.debug.filter((message) => /Stopping idle Claude process/.test(message)).length;

test('an idle process is stopped after the idle timeout; the next turn resumes', async () => {
  await withRuntime(async (h) => {
    assert.equal(await h.turn('first'), 'completed');
    await h.waitFor(() => idleStops(h) === 1, 'idle stop');
    assert.equal(await h.turn('second'), 'completed');
    assert.equal(flag(h.launches()[1]!, '--resume'), NATIVE);
  }, { runtime: { idleTimeoutMs: 50 } });
});

test('the idle stop waits for background tasks and for the run Claude starts when they end', async () => {
  await withRuntime(async (h) => {
    const reviewed = [{ wait: 150 }, { text: 'background work reviewed' }, { result: 'reviewed' }];
    assert.equal(await h.turn([{ background: { id: 'bg1', after: 250, then: reviewed } }, { result: 'started' }]), 'completed');
    // The turn is over but its background task still runs, well past the
    // idle timeout: stopping the process now would kill the task.
    await sleep(150);
    assert.equal(idleStops(h), 0, 'stopped while a background task was running');
    await h.waitFor(() => h.debug.some((message) => /Background tasks finished/.test(message)), 'background task end');
    // Claude reacts to the finished task with a run of its own, which also
    // outlasts the idle timeout.
    await sleep(100);
    assert.equal(idleStops(h), 0, 'stopped during a run Claude started on its own');
    await h.waitFor(() => idleStops(h) === 1, 'idle stop after that run');
    const position = (pattern: RegExp) => h.debug.findIndex((message) => pattern.test(message));
    assert.ok(position(/Result of a run outside the active turn/) < position(/Stopping idle Claude process/));
    // That run belongs to no Gian turn: it reaches Gian through native
    // history replay, not as output of the finished turn.
    assert.ok(!h.texts.some(({ text }) => text === 'background work reviewed'));
    assert.deepEqual(h.exits, []);
    assert.equal(h.launches().length, 1);
  }, { runtime: { idleTimeoutMs: 50 } });
});

test('a turn started while a background task runs keeps the process and the task', async () => {
  await withRuntime(async (h) => {
    assert.equal(await h.turn([{ background: { id: 'bg2', after: 200 } }, { result: 'started' }]), 'completed');
    await sleep(100);
    assert.equal(await h.turn('meanwhile'), 'completed');
    await h.waitFor(() => h.debug.some((message) => /Background tasks finished/.test(message)), 'background task end');
    await h.waitFor(() => idleStops(h) === 1, 'idle stop after the task');
    assert.equal(h.launches().length, 1);
  }, { runtime: { idleTimeoutMs: 50 } });
});

test('resetClaudeSessionId (/clear) starts the next turn as a fresh session', async () => {
  await withRuntime(async (h) => {
    await h.turn('before clear');
    const fresh = '00000000-0000-4000-8000-000000000202';
    h.runtime.resetClaudeSessionId(SESSION, fresh);
    await h.turn('after clear');
    const second = h.launches()[1]!;
    assert.equal(flag(second, '--session-id'), fresh);
    assert.equal(second.includes('--resume'), false);
  });
});

test('host MCP servers go in a private config file that leaves with the process', async () => {
  await withRuntime(async (h) => {
    await h.turn('with mcp');
    const args = h.launches()[0]!;
    const configPath = flag(args, '--mcp-config')!;
    assert.ok(args.includes('--strict-mcp-config'));
    assert.equal(statSync(configPath).mode & 0o777, 0o600);
    assert.match(readFileSync(configPath, 'utf8'), /Bearer secret/);
    assert.equal(args.some((arg) => arg.includes('Bearer secret')), false, 'headers never reach argv');
    h.runtime.killSession(SESSION);
    await h.waitFor(() => !existsSync(configPath), 'config file removal');
  }, {
    spawn: { mcpServers: [{ name: 'gian-tools', url: 'http://127.0.0.1:9/mcp', headers: { Authorization: 'Bearer secret' } }] },
  });
});

test('partial text streams once; the final assistant message does not repeat it', async () => {
  await withRuntime(async (h) => {
    assert.equal(await h.turn([{ stream: 'hello world' }, { result: 'hello world' }]), 'completed');
    assert.equal(h.texts.map((part) => part.text).join(''), 'hello world');
    assert.equal(h.texts.length, 2);
    assert.equal(new Set(h.texts.map((part) => part.itemId)).size, 1, 'deltas share one content item');
    assert.deepEqual(h.replies, ['']);
  });
});
