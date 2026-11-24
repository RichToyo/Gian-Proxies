import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import { proxyNotificationSchema } from '@gian/proxy-protocol';

import { GrokProxyService } from '../src/core/service.js';
import { GrokProtocolV2Adapter } from '../src/protocol/v2-adapter.js';
import type { GrokAcpClient, GrokAcpStopOptions } from '../src/runtime/grok-acp-client.js';

const MODELS = {
  currentModelId: 'grok-4.6',
  availableModels: [
    {
      modelId: 'grok-4.6',
      name: 'Grok 4.6',
      _meta: {
        supportsReasoningEffort: true,
        reasoningEffort: 'high',
        reasoningEfforts: [
          { id: 'high', value: 'high', label: 'High', default: true },
          { id: 'low', value: 'low', label: 'Low', default: false },
        ],
      },
    },
    { modelId: 'openai-byok', name: 'OpenAI BYOK', _meta: { totalContextTokens: 400000 } },
  ],
};

/** Grok 1.0.92 `configOptions` for a session on `model` (and `effort`). */
function configOptions(model: string, effort: string | null) {
  return [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: model,
      options: [{ value: 'grok-4.6', name: 'Grok 4.6' }, { value: 'openai-byok', name: 'OpenAI BYOK' }],
    },
    ...(effort === null ? [] : [{
      id: 'reasoning_effort',
      name: 'Reasoning Effort',
      category: 'thought_level',
      type: 'select',
      currentValue: effort,
      options: [{ value: 'high', name: 'High Effort' }, { value: 'low', name: 'Low Effort' }],
    }]),
  ];
}

function initializeResponse() {
  return {
    protocolVersion: 1,
    agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, resume: {}, close: {} } },
    _meta: { grokShell: true, agentVersion: '1.0.92', modelState: MODELS, availableCommands: [] },
  };
}

/** A runtime double whose child can stop and restart like GrokAcpClient. */
class FakeChildRuntime extends EventEmitter {
  readonly calls: string[] = [];
  readonly configCalls: Array<{ configId: string; value: string }> = [];
  generation = 0;
  running = false;
  model = 'grok-4.6';
  effort: string | null = 'high';
  promptBehavior: 'complete' | 'hang' = 'complete';
  binaryPath = '/managed/grok';
  cwd = '/workspace';

  get negotiated() { return this.running ? initializeResponse() : null; }

  async ensureStarted() {
    if (!this.running) {
      this.running = true;
      this.generation += 1;
      this.calls.push('initialize');
    }
    return initializeResponse();
  }

  setPermissionHandler() {}
  setExtMethodHandler() {}

  private live(): void {
    if (!this.running) throw new Error('child not started');
  }

  async newSession() {
    this.live();
    this.calls.push('session/new');
    return { sessionId: 'native-1', models: MODELS, configOptions: configOptions(this.model, this.effort) };
  }

  async resumeSession() {
    this.live();
    this.calls.push('session/resume');
    return { models: MODELS, configOptions: configOptions(this.model, this.effort) };
  }

  async loadSession() {
    this.live();
    this.calls.push('session/load');
    return { configOptions: configOptions(this.model, this.effort) };
  }

  async setSessionConfigOption(params: { configId: string; value: string }) {
    this.live();
    this.calls.push(`set_config_option:${params.configId}=${params.value}`);
    this.configCalls.push(params);
    if (params.configId === 'model') {
      this.model = params.value;
      this.effort = params.value === 'openai-byok' ? null : 'high';
    } else {
      this.effort = params.value;
    }
    return { configOptions: configOptions(this.model, this.effort) };
  }

  async setSessionModel() {
    this.calls.push('session/set_model');
    return {};
  }

  async notifyPermissionMode() { this.calls.push('x.ai/yolo_mode_changed'); }

  async dispatchPrompt() {
    this.live();
    this.calls.push('session/prompt');
    const generation = this.generation;
    const response = this.promptBehavior === 'hang'
      ? new Promise<never>((_, reject) => {
        this.once('runtimeStopped', () => reject(new Error('ACP connection closed')));
      })
      : Promise.resolve({ stopReason: 'end_turn' as const, generation });
    return { response };
  }

  async cancel() { this.calls.push('session/cancel'); }
  async closeSession() { this.calls.push('session/close'); }
  async listSessions() { return { sessions: [] }; }

  async stop(options?: GrokAcpStopOptions) {
    this.calls.push(options?.force ? 'stop:force' : 'stop');
    if (!this.running) return;
    this.running = false;
    this.emit('runtimeStopped', { code: 0, signal: null, expected: true, stderrTail: '' });
  }

  /** The child dies on its own. */
  crash(): void {
    this.running = false;
    this.emit('runtimeStopped', { code: 9, signal: null, expected: false, stderrTail: 'fatal: out of memory' });
  }
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function harness(options: { idleTimeoutMs?: number; interruptDeadlineMs?: number } = {}) {
  const runtime = new FakeChildRuntime();
  const service = new GrokProxyService({
    binaryPath: '/managed/grok',
    createRuntime: () => runtime as unknown as GrokAcpClient,
    idleTimeoutMs: options.idleTimeoutMs ?? 0,
    interruptDeadlineMs: options.interruptDeadlineMs ?? 10_000,
  });
  const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
  const adapter = new GrokProtocolV2Adapter(service, '0.3.17', (method, params) => {
    proxyNotificationSchema.parse({ jsonrpc: '2.0', method, params });
    notifications.push({ method, params });
  });
  return { runtime, service, adapter, notifications };
}

async function openSession(adapter: GrokProtocolV2Adapter, sessionId = 'host-1') {
  await adapter.handle({
    id: 'init',
    method: 'initialize',
    params: { protocol: { name: 'gian.proxy', versions: ['2.3'] }, host: { name: 'Gian', version: '0.0.0' } },
  });
  const created = await adapter.handle({
    id: 'create',
    method: 'session.create',
    params: { sessionId, workspace: { cwd: '/workspace', roots: ['/workspace'] }, config: {} },
  }) as { session: { streamId: string } };
  return created.session.streamId;
}

function startTurn(adapter: GrokProtocolV2Adapter, streamId: string, turnId: string, config: Record<string, unknown> = {}) {
  return adapter.handle({
    id: `start-${turnId}`,
    method: 'turn.start',
    params: { sessionId: 'host-1', streamId, turnId, input: [{ type: 'text', text: 'hi' }], config },
  });
}

function terminal(notifications: Array<{ method: string; params: Record<string, unknown> }>, turnId: string) {
  return notifications.find((note) => (
    (note.method === 'turn.completed' || note.method === 'turn.failed') && note.params.turnId === turnId
  ));
}

test('an interrupt whose prompt never settles stops the child and frees the session', async () => {
  const { runtime, service, adapter, notifications } = harness({ interruptDeadlineMs: 40 });
  const streamId = await openSession(adapter);
  runtime.promptBehavior = 'hang';
  await startTurn(adapter, streamId, 'turn-hang');
  await adapter.handle({
    id: 'interrupt',
    method: 'turn.interrupt',
    params: { sessionId: 'host-1', streamId, turnId: 'turn-hang' },
  });
  await waitFor(() => terminal(notifications, 'turn-hang') !== undefined, 'interrupted turn to end');
  const ended = terminal(notifications, 'turn-hang')!;
  assert.equal(ended.method, 'turn.completed');
  assert.equal((ended.params.data as { stopReason?: string }).stopReason, 'interrupted');
  assert.ok(runtime.calls.includes('session/cancel'));
  assert.ok(runtime.calls.includes('stop:force'), 'the unresponsive child is stopped');

  // The next turn is not SESSION_BUSY: the session is resumed in a new child.
  runtime.promptBehavior = 'complete';
  await startTurn(adapter, streamId, 'turn-next');
  await waitFor(() => terminal(notifications, 'turn-next') !== undefined, 'next turn');
  assert.equal(terminal(notifications, 'turn-next')!.method, 'turn.completed');
  const restart = runtime.calls.lastIndexOf('initialize');
  assert.ok(restart > runtime.calls.indexOf('stop:force'));
  assert.ok(runtime.calls.indexOf('session/resume', restart) > restart);
  assert.ok(runtime.calls.lastIndexOf('session/prompt') > runtime.calls.indexOf('session/resume', restart));
  await service.close();
});

test('after an unexpected exit the next turn resumes the session instead of prompting a blank child', async () => {
  const { runtime, service, adapter, notifications } = harness();
  const streamId = await openSession(adapter);
  runtime.crash();
  const stale = notifications.find((note) => (
    note.method === 'session.updated' && (note.params.data as { state?: string }).state === 'stale'
  ));
  assert.match(String((stale?.params.data as { lastError?: string }).lastError), /exit code 9.*out of memory/);

  await startTurn(adapter, streamId, 'turn-after-crash');
  await waitFor(() => terminal(notifications, 'turn-after-crash') !== undefined, 'turn after crash');
  assert.equal(terminal(notifications, 'turn-after-crash')!.method, 'turn.completed');
  const resumeAt = runtime.calls.indexOf('session/resume');
  assert.ok(resumeAt > 0, 'the native session is resumed');
  assert.ok(runtime.calls.lastIndexOf('session/prompt') > resumeAt);
  assert.ok(notifications.some((note) => (
    note.method === 'session.updated' && (note.params.data as { state?: string }).state === 'idle'
  )), 'the stale session is reported idle again');
  await service.close();
});

test('an idle child stops after the idle timeout and the next turn resumes it', async () => {
  const { runtime, service, adapter, notifications } = harness({ idleTimeoutMs: 30 });
  const streamId = await openSession(adapter);
  const attachedAt = runtime.calls.lastIndexOf('session/new');
  const stopAfter = (from: number) => runtime.calls.indexOf('stop', from);
  await waitFor(() => stopAfter(attachedAt) > 0, 'idle stop after session.create');
  assert.equal(runtime.running, false);
  // An idle stop is not a failure the Host should see.
  assert.ok(!notifications.some((note) => (note.params.data as { state?: string } | undefined)?.state === 'stale'));

  await startTurn(adapter, streamId, 'turn-after-idle', { model: 'grok-4.6', reasoning_effort: 'low' });
  await waitFor(() => terminal(notifications, 'turn-after-idle') !== undefined, 'turn after idle');
  assert.equal(terminal(notifications, 'turn-after-idle')!.method, 'turn.completed');
  const resumeAt = runtime.calls.indexOf('session/resume');
  assert.ok(resumeAt > stopAfter(attachedAt));
  assert.ok(runtime.calls.indexOf('set_config_option:reasoning_effort=low') > resumeAt);
  await waitFor(() => stopAfter(resumeAt) > 0, 'idle stop after the turn');

  // Closing a session whose child is idle-stopped does not restart a child.
  const starts = runtime.generation;
  await adapter.handle({ id: 'close', method: 'session.close', params: { sessionId: 'host-1', streamId } });
  assert.equal(runtime.generation, starts);
  assert.ok(!runtime.calls.includes('session/close'));
  await service.close();
});

test('the idle stop waits for background tasks and for the turn Grok runs when one ends', async () => {
  const { runtime, service, adapter } = harness({ idleTimeoutMs: 40 });
  await openSession(adapter);
  const attachedAt = runtime.calls.lastIndexOf('session/new');
  const stopped = () => runtime.calls.indexOf('stop', attachedAt) > 0;
  const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
  const notify = (update: Record<string, unknown>, method = 'x.ai/session_notification') => {
    runtime.emit('extensionNotification', method, { sessionId: 'native-1', update });
  };
  // Frames Grok 1.0.92 sends for a command run in the background: the
  // prompt that started it has already ended.
  notify({ sessionUpdate: 'task_backgrounded', task_id: 'task-1', tool_call_id: 'call-1' }, 'x.ai/task_backgrounded');
  notify({ sessionUpdate: 'background_tasks', tasks: [{ task_id: 'task-1', kind: 'bash', status: 'running' }] });
  await pause(150);
  assert.equal(stopped(), false, 'stopped while a background task was running');
  assert.equal(runtime.running, true);

  // The task ends and Grok runs a turn of its own; its updates keep coming
  // for longer than the idle timeout.
  notify({ sessionUpdate: 'task_completed', task_snapshot: { task_id: 'task-1' } });
  notify({ sessionUpdate: 'background_tasks', tasks: [{ task_id: 'task-1', kind: 'bash', status: 'completed', exit_code: 0 }] });
  for (let index = 0; index < 6; index += 1) {
    await pause(20);
    runtime.emit('sessionUpdate', {
      sessionId: 'native-1',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'The command finished.' } },
    });
  }
  assert.equal(stopped(), false, 'stopped during the turn Grok started on its own');
  await waitFor(stopped, 'idle stop once the background work is over');
  await service.close();
});

test('a child that dies takes its background tasks with it', async () => {
  const { runtime, service, adapter, notifications } = harness({ idleTimeoutMs: 40 });
  const streamId = await openSession(adapter);
  runtime.emit('extensionNotification', 'x.ai/session_notification', {
    sessionId: 'native-1',
    update: { sessionUpdate: 'background_tasks', tasks: [{ task_id: 'task-2', kind: 'bash', status: 'running' }] },
  });
  runtime.crash();
  // The next turn resumes the session in a new child, which the dead
  // child's task must not keep alive.
  await startTurn(adapter, streamId, 'turn-after-crash');
  await waitFor(() => terminal(notifications, 'turn-after-crash') !== undefined, 'turn after the crash');
  const resumedAt = runtime.calls.lastIndexOf('session/resume');
  assert.ok(resumedAt > 0);
  await waitFor(() => runtime.calls.indexOf('stop', resumedAt) > 0, 'idle stop of the new child');
  await service.close();
});

test('model and effort use session/set_config_option and a native model switch is republished', async () => {
  const { runtime, service, adapter, notifications } = harness();
  const streamId = await openSession(adapter);
  await startTurn(adapter, streamId, 'turn-config', { model: 'grok-4.6', reasoning_effort: 'low' });
  await waitFor(() => terminal(notifications, 'turn-config') !== undefined, 'config turn');
  assert.deepEqual(runtime.configCalls, [{ sessionId: 'native-1', configId: 'reasoning_effort', value: 'low' }]);
  assert.ok(!runtime.calls.includes('session/set_model'), 'the undocumented set_model + _meta path is not used');

  // Grok switches the session's model outside a turn (its model left the list).
  runtime.emit('sessionUpdate', {
    sessionId: 'native-1',
    update: { sessionUpdate: 'config_option_update', configOptions: configOptions('openai-byok', null) },
  });
  const republished = notifications.filter((note) => (
    note.method === 'session.updated'
    && Array.isArray((note.params.data as { turnConfigOptions?: unknown }).turnConfigOptions)
  )).at(-1);
  assert.ok(republished, 'turn options are republished outside a turn');
  const options = (republished!.params.data as {
    turnConfigOptions: Array<{ id: string; defaultValue?: unknown }>;
  }).turnConfigOptions;
  assert.equal(options.find((option) => option.id === 'model')?.defaultValue, 'openai-byok');
  const session = (await service.getSession({ sessionId: [...(service as unknown as {
    sessionsById: Map<string, { id: string }>;
  }).sessionsById.keys()][0]! })).session;
  assert.equal(session.model, 'openai-byok');
  assert.equal(session.effort, null);
  await service.close();
});

test('a BYOK model without effort refuses a thinking level instead of faking it', async () => {
  const { runtime, service, adapter } = harness();
  runtime.model = 'openai-byok';
  runtime.effort = null;
  await openSession(adapter);
  const serviceSessionId = [...(service as unknown as { sessionsById: Map<string, unknown> }).sessionsById.keys()][0]!;
  await assert.rejects(
    service.setConfigOption({ sessionId: serviceSessionId, configId: 'reasoning_effort', value: 'high' }),
    /does not offer a thinking level/,
  );
  assert.equal(runtime.configCalls.length, 0);
  await service.close();
});
