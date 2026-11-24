#!/usr/bin/env node
/** Scriptable fake Claude Code for the streaming runtime tests.
 *
 *  Speaks the streaming-input protocol. Each user message is a JSON list of
 *  steps the fake performs as one run; a message that is not JSON just gets a
 *  successful result. Messages are consumed one run at a time: a message that
 *  arrives during a run waits (and is echoed) until the run ends, unless the
 *  run has a `waitForSteer` step, which folds it in. Every launch's argv goes
 *  to FAKE_CLAUDE_ARGV_LOG and every stdin frame to FAKE_CLAUDE_FRAMES_LOG.
 *
 *  Steps:
 *    { text }            assistant message with one text block
 *    { stream }          the same text as partial deltas, then the message
 *    { ask: { tool, input } }  can_use_tool; the answer becomes a tool_result
 *    { askThenCancel: { tool, input } }  can_use_tool, then withdraw it
 *    { waitForSteer: true }  fold the next queued user message into this run
 *    { wait: ms }
 *    { result, isError?, modelUsage? }  end the run (default: success "done")
 *    { exitAfter: ms }   exit with code 0 after the run, while idle
 *    { background: { id, after, then? } }  start a background task that
 *                        finishes `after` ms later; Claude then starts a run
 *                        of its own (no user message) with the `then` steps,
 *                        as Claude Code does when a background task ends
 */

import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
if (args.includes('--help')) process.exit(0);
if (!args.includes('--input-format')) process.exit(0);
const runtimeLaunch = args.includes('-p');
if (runtimeLaunch && process.env.FAKE_CLAUDE_ARGV_LOG) {
  appendFileSync(process.env.FAKE_CLAUDE_ARGV_LOG, `${JSON.stringify(args)}\n`);
}

const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const queue = [];
let running = false;
let nextRequest = 0;
let messageCount = 0;
const pendingAnswers = new Map();
let wakeSteer = null;
const backgroundTasks = new Map();

function announceBackgroundTasks() {
  write({ type: 'system', subtype: 'background_tasks_changed', tasks: [...backgroundTasks.values()] });
}

function steps(frame) {
  const content = typeof frame.message?.content === 'string' ? frame.message.content : '';
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) return parsed;
  } catch { /* plain text */ }
  return [{ result: 'done' }];
}

function ask(tool, input) {
  nextRequest += 1;
  const requestId = `perm-${nextRequest}`;
  write({ type: 'control_request', request_id: requestId, request: { subtype: 'can_use_tool', tool_name: tool, input, tool_use_id: `tool-${nextRequest}` } });
  return requestId;
}

async function run(frame) {
  running = true;
  // A run Claude starts on its own consumes no user message.
  if (!frame.autonomous) write({ type: 'user', isReplay: true, uuid: frame.uuid, message: frame.message });
  write({ type: 'system', subtype: 'init', model: 'claude-sonnet-4-6' });
  let ended = false;
  let exitAfter = null;
  for (const step of steps(frame)) {
    messageCount += 1;
    const messageId = `msg_${messageCount}`;
    if (step.text !== undefined) {
      write({ type: 'assistant', message: { id: messageId, content: [{ type: 'text', text: step.text }] } });
    } else if (step.stream !== undefined) {
      write({ type: 'stream_event', event: { type: 'message_start', message: { id: messageId } } });
      const half = Math.ceil(step.stream.length / 2);
      for (const part of [step.stream.slice(0, half), step.stream.slice(half)]) {
        write({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: part } } });
      }
      write({ type: 'assistant', message: { id: messageId, content: [{ type: 'text', text: step.stream }] } });
    } else if (step.ask) {
      const requestId = ask(step.ask.tool, step.ask.input);
      const answer = await new Promise((resolve) => pendingAnswers.set(requestId, resolve));
      write({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `tool-${nextRequest}`, content: JSON.stringify(answer), is_error: answer.behavior !== 'allow' }] } });
    } else if (step.askThenCancel) {
      const requestId = ask(step.askThenCancel.tool, step.askThenCancel.input);
      await new Promise((resolve) => setTimeout(resolve, 30));
      write({ type: 'control_cancel_request', request_id: requestId });
    } else if (step.waitForSteer) {
      if (queue.length === 0) await new Promise((resolve) => { wakeSteer = resolve; });
      const steer = queue.shift();
      write({ type: 'user', isReplay: true, uuid: steer.uuid, message: steer.message });
    } else if (step.wait !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, step.wait));
    } else if (step.result !== undefined) {
      write({
        type: 'result',
        subtype: step.isError ? 'error_during_execution' : 'success',
        is_error: step.isError === true,
        result: step.result,
        ...(step.modelUsage ? { modelUsage: step.modelUsage } : {}),
      });
      ended = true;
    } else if (step.exitAfter !== undefined) {
      exitAfter = step.exitAfter;
    } else if (step.background) {
      const { id, after, then } = step.background;
      const toolUseId = `toolu_${id}`;
      backgroundTasks.set(id, { task_id: id, task_type: 'local_bash', description: `background ${id}` });
      announceBackgroundTasks();
      write({ type: 'system', subtype: 'task_started', task_id: id, tool_use_id: toolUseId, description: `background ${id}`, is_backgrounded: true, task_type: 'local_bash' });
      setTimeout(() => {
        backgroundTasks.delete(id);
        write({ type: 'system', subtype: 'task_updated', task_id: id, patch: { status: 'completed' } });
        write({ type: 'system', subtype: 'task_notification', task_id: id, tool_use_id: toolUseId, status: 'completed', summary: `background ${id} completed` });
        announceBackgroundTasks();
        queue.push({ autonomous: true, message: { content: JSON.stringify(then ?? [{ result: `${id} handled` }]) } });
        drain();
      }, after);
    }
  }
  if (!ended) write({ type: 'result', subtype: 'success', result: 'done' });
  running = false;
  if (exitAfter !== null) setTimeout(() => process.exit(0), exitAfter);
  drain();
}

function drain() {
  if (running || queue.length === 0) return;
  void run(queue.shift());
}

const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  if (process.env.FAKE_CLAUDE_FRAMES_LOG) appendFileSync(process.env.FAKE_CLAUDE_FRAMES_LOG, `${line}\n`);
  let frame;
  try { frame = JSON.parse(line); } catch { return; }
  if (frame.type === 'control_request') {
    const subtype = frame.request?.subtype;
    write({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: subtype === 'interrupt' ? { still_queued: [] } : {} } });
    return;
  }
  if (frame.type === 'control_response') {
    const resolve = pendingAnswers.get(frame.response?.request_id);
    if (resolve) {
      pendingAnswers.delete(frame.response.request_id);
      resolve(frame.response.response);
    }
    return;
  }
  if (frame.type === 'user') {
    queue.push(frame);
    if (wakeSteer) {
      const wake = wakeSteer;
      wakeSteer = null;
      wake();
      return;
    }
    drain();
  }
});
input.on('close', () => setTimeout(() => process.exit(0), 10));
