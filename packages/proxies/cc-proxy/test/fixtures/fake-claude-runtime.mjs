#!/usr/bin/env node
/** Fake Claude Code runtime for cc-proxy protocol-v2 CLI tests.
 *
 *  It intentionally never contacts a Provider. It answers `--help` for
 *  billing-safe capability discovery and speaks Claude's streaming-input
 *  protocol (`-p --input-format stream-json --output-format stream-json`):
 *  control requests are answered, every user message is echoed back when
 *  `--replay-user-messages` is set, and each message gets one deterministic
 *  turn. The process stays up until stdin ends, like the real CLI. */

import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);

function delayFromEnv(name) {
  const raw = Number(process.env[name] ?? '0');
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

if (args.includes('--help')) {
  // Test seam: FAKE_CLAUDE_HELP_DELAY_MS delays the capability probe ONLY
  // (never the turn stream), so tests can hold a normal Proxy request open
  // deterministically (e.g. a cold catalog.list probe) while a queued
  // request overlaps it.
  const helpDelayMs = delayFromEnv('FAKE_CLAUDE_HELP_DELAY_MS');
  if (helpDelayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, helpDelayMs));
  }
  process.stdout.write(`Usage: claude [options]\n
  --permission-mode <mode>  Permission mode to use for the session (choices: "acceptEdits", "bypassPermissions", "default", "plan")\n
  --effort <level>          Reasoning effort (choices: "low", "medium", "high", "max")\n`);
  process.exit(0);
}

if (!args.includes('--input-format')) process.exit(0);

// Test seam: FAKE_CLAUDE_ARGV_LOG records every streaming launch's argv.
if (process.env.FAKE_CLAUDE_ARGV_LOG) {
  appendFileSync(process.env.FAKE_CLAUDE_ARGV_LOG, `${JSON.stringify(args)}\n`);
}

const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const replay = args.includes('--replay-user-messages');
const sessionFlag = args.indexOf('--resume') >= 0 ? '--resume' : '--session-id';
const sessionId = args[args.indexOf(sessionFlag) + 1] ?? 'fake-session';
// Test seam: FAKE_CLAUDE_TURN_DELAY_MS delays each turn's output so
// concurrency tests can overlap a slow turn with a queued request
// deterministically. The default keeps the historical 30ms cadence.
const turnDelayMs = 30 + delayFromEnv('FAKE_CLAUDE_TURN_DELAY_MS');
// Test seam: FAKE_CLAUDE_STREAM=1 sends partial stream deltas first.
const stream = process.env.FAKE_CLAUDE_STREAM === '1';

let turnTimer = null;
let messageCount = 0;

function runTurn() {
  messageCount += 1;
  const messageId = `msg_fake_${messageCount}`;
  write({ type: 'system', subtype: 'init', model: 'claude-sonnet-4-6', session_id: sessionId });
  turnTimer = setTimeout(() => {
    turnTimer = null;
    if (stream) {
      write({ type: 'stream_event', event: { type: 'message_start', message: { id: messageId } } });
      write({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'thinking with fake claude' } } });
      write({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'hello from ' } } });
      write({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'fake claude' } } });
    }
    write({
      type: 'assistant',
      message: {
        id: messageId,
        model: 'claude-sonnet-4-6',
        usage: { input_tokens: 10 },
        content: [
          { type: 'thinking', id: `think_fake_${messageCount}`, thinking: 'thinking with fake claude' },
          { type: 'text', id: `text_fake_${messageCount}`, text: 'hello from fake claude' },
        ],
      },
    });
    write({ type: 'web_search', query: 'diagnostic unknown event' });
    write({
      type: 'result',
      subtype: 'success',
      result: 'hello from fake claude',
      session_id: sessionId,
      usage: { input_tokens: 10, output_tokens: 4 },
    });
  }, turnDelayMs);
}

const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  let frame;
  try { frame = JSON.parse(line); } catch { return; }
  if (frame.type === 'control_request') {
    const subtype = frame.request?.subtype;
    const answer = (response) => write({
      type: 'control_response',
      response: { subtype: 'success', request_id: frame.request_id, response },
    });
    if (subtype === 'interrupt') {
      answer({ still_queued: [] });
      if (turnTimer) {
        clearTimeout(turnTimer);
        turnTimer = null;
        write({ type: 'result', subtype: 'error_during_execution', is_error: true, result: '', session_id: sessionId });
      }
      return;
    }
    if (['initialize', 'set_model', 'set_permission_mode', 'apply_flag_settings'].includes(subtype)) {
      answer({});
      return;
    }
    write({
      type: 'control_response',
      response: { subtype: 'error', request_id: frame.request_id, error: `${subtype} is not supported in this context` },
    });
    return;
  }
  if (frame.type === 'user') {
    if (replay) write({ type: 'user', isReplay: true, uuid: frame.uuid, message: frame.message, session_id: sessionId });
    runTurn();
  }
});
// Like the real CLI: end of input ends the process once output is flushed.
input.on('close', () => {
  if (turnTimer) clearTimeout(turnTimer);
  setTimeout(() => process.exit(0), 10);
});
