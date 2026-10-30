/** Kimi Code 2.1.1 volatile frames reuse the current durable journal seq.
 *  Assistant text is kind `text` and split per step so it stays a message
 *  outside the Working basket. Tool rows stay activities inside that basket. */

import assert from 'node:assert/strict';
import test from 'node:test';

import { KimiSessionProjector, projectKimiCumulativeUsage, type KimiProjectedFrame, type OuterNotification, type ProjectorServices } from '../src/core/projector.js';

function createProjector(overrides: Partial<ProjectorServices> = {}): { projector: KimiSessionProjector; events: OuterNotification[] } {
  const events: OuterNotification[] = [];
  let sequence = 0;
  const projector = new KimiSessionProjector({
    gianSessionId: 's',
    nativeSessionId: 'native',
    nextSequence: () => {
      sequence += 1;
      return sequence;
    },
    emit: (notification) => events.push(notification),
    finalUsage: async () => null,
    fileDiff: async () => null,
    ...overrides,
  });
  projector.setStreamId('stream-1');
  projector.bindTurn({ gianTurnId: 't', promptId: 'p' });
  return { projector, events };
}

function frame(partial: KimiProjectedFrame): KimiProjectedFrame {
  return partial;
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

function dataOf(event: OuterNotification): Record<string, unknown> {
  return event.params.data as Record<string, unknown>;
}

for (const kind of ['todo_list', 'plan_review'] as const) {
  test(`${kind} A-B-A updates keep distinct native identities and idempotent redelivery`, () => {
    const project = () => {
      const { projector, events } = createProjector();
      for (const [index, text] of ['A', 'A', 'B', 'A'].entries()) {
        const update: KimiProjectedFrame = {
          type: 'tool.call.started',
          seq: index + 1,
          payload: {
            agentId: 'main',
            toolCallId: `plan-call-${index}`,
            name: kind === 'todo_list' ? 'TodoList' : 'PlanReview',
            display: kind === 'todo_list'
              ? { kind, items: [{ title: text, status: 'pending' }] }
              : { kind, plan: text },
          },
        };
        assert.equal(projector.handleFrame(update), true);
        const eventCount = events.length;
        assert.equal(projector.handleFrame(update), false, 'the same durable frame is not emitted twice');
        assert.equal(events.length, eventCount);
      }
      const plans = events.filter((event) => event.method === 'plan.updated');
      assert.equal(plans.length, 3, 'only adjacent identical plans are suppressed');
      assert.deepEqual(plans.map((event) => dataOf(event).steps), ['A', 'B', 'A'].map((text) => [
        { id: 'step-0', text, status: kind === 'todo_list' ? 'pending' : 'completed' },
      ]));
      assert.deepEqual(dataOf(plans[0]!), dataOf(plans[2]!), 'returning to A keeps the original plan content');
      const ids = plans.map((event) => event.params.eventId);
      assert.equal(new Set(ids).size, 3, 'a new tool call is a new plan update even when content returns to A');
      return ids;
    };
    assert.deepEqual(project(), project(), 'native identities remain stable when the same frames are projected again');
  });
}

test('owned background continuations and questions finish within the admitted Gian turn', async () => {
  const finalized: string[] = [];
  const diffs: number[] = [];
  const { projector, events } = createProjector({
    onFinalized: (turnId) => finalized.push(turnId),
    fileDiff: async (turnId) => { diffs.push(turnId); return null; },
  });
  const feed = (type: string, seq: number, payload: Record<string, unknown>) =>
    projector.handleFrame({ type, seq, payload });
  feed('turn.started', 1, { agentId: 'main', turnId: 0, promptId: 'p', origin: { kind: 'user' } });
  feed('event.session.work_changed', 2, { busy: true, main_turn_active: true, pending_interaction: 'none' });
  feed('tool.call.started', 3, { agentId: 'main', turnId: 0, toolCallId: 'bash-call', name: 'Bash' });
  feed('task.started', 4, { agentId: 'main', info: { taskId: 'bg', kind: 'process', parentToolCallId: 'bash-call' } });
  feed('background.task.started', 5, { agentId: 'main', info: { taskId: 'bg', kind: 'process', parentToolCallId: 'bash-call' } });
  feed('tool.result', 6, { agentId: 'main', turnId: 0, toolCallId: 'bash-call', output: 'started' });
  feed('tool.call.started', 7, { agentId: 'main', turnId: 0, toolCallId: 'question-call', name: 'AskUserQuestion' });
  feed('task.started', 8, { agentId: 'main', info: { taskId: 'question-task', kind: 'question', toolCallId: 'question-call' } });
  feed('event.question.requested', 9, { agentId: 'main', turn_id: 0, question_id: 'q1', tool_call_id: 'question-call', questions: [{ id: 'q_0', question: 'Continue?', options: [{ id: 'yes', label: 'Yes' }] }] });
  feed('tool.result', 10, { agentId: 'main', turnId: 0, toolCallId: 'question-call', output: 'waiting' });
  feed('turn.ended', 11, { agentId: 'main', turnId: 0, reason: 'completed' });
  feed('event.session.work_changed', 12, { busy: true, main_turn_active: false, pending_interaction: 'question' });
  await flush();
  assert.equal(projector.hasActiveTurn(), true);
  assert.equal(projector.activePromptId(), null, 'an ended prompt is not an interrupt target');
  assert.equal(projector.pendingInteractions.has('q:q1'), true);
  assert.equal(events.some((event) => event.method === 'turn.completed' || event.method === 'turn.failed'), false);
  assert.equal(events.some((event) => event.method === 'interaction.resolved'), false);
  assert.equal(events.some((event) => dataOf(event).activityId === 'task:bg' && dataOf(event).status === 'failed'), false);

  feed('task.terminated', 13, { agentId: 'main', info: { taskId: 'bg', kind: 'process', status: 'completed', parentToolCallId: 'bash-call' } });
  feed('background.task.terminated', 14, { agentId: 'main', info: { taskId: 'bg', kind: 'process', status: 'completed', parentToolCallId: 'bash-call' } });
  feed('turn.started', 15, { agentId: 'main', turnId: 1, origin: { kind: 'task', taskId: 'bg' } });
  assert.equal(projector.activePromptId(), null, 'a continuation without a native prompt ID cannot be interrupted by guessing');
  feed('turn.step.started', 16, { agentId: 'main', turnId: 1 });
  feed('assistant.delta', 17, { agentId: 'main', promptId: 'p', delta: 'stale old prompt' });
  feed('assistant.delta', 18, { agentId: 'main', turnId: 1, delta: 'continued output' });
  feed('turn.ended', 19, { agentId: 'main', turnId: 1, reason: 'completed' });
  feed('event.session.work_changed', 20, { busy: true, main_turn_active: false, pending_interaction: 'question' });
  await flush();
  assert.equal(projector.pendingInteractions.has('q:q1'), true);
  assert.equal(events.some((event) => event.method === 'turn.completed'), false);
  feed('event.question.answered', 21, { agentId: 'main', question_id: 'q1', turn_id: 0 });
  feed('event.session.work_changed', 22, { busy: false, main_turn_active: false, pending_interaction: 'none' });
  await flush();
  assert.equal(events.filter((event) => event.method === 'turn.completed').length, 1);
  assert.equal(events.filter((event) => event.method === 'interaction.resolved').length, 1);
  assert.equal(events.filter((event) => dataOf(event).activityId === 'task:bg' && dataOf(event).status === 'succeeded').length, 1);
  assert.equal(events.filter((event) => dataOf(event).activityId === 'task:question-task' && dataOf(event).status === 'succeeded').length, 1);
  assert.equal(events.some((event) => event.method === 'content.delta' && dataOf(event).delta === 'stale old prompt'), false);
  assert.equal(events.find((event) => event.method === 'content.delta' && dataOf(event).delta === 'continued output')?.params.turnId, 't');
  assert.deepEqual(diffs, [0, 1]);
  assert.deepEqual(finalized, ['t']);
  assert.equal(projector.hasActiveTurn(), false);
});

test('retired and foreign background events cannot contaminate a later turn', async () => {
  const { projector, events } = createProjector();
  projector.handleFrame({ type: 'turn.started', seq: 1, payload: { agentId: 'main', turnId: 1, promptId: 'p' } });
  projector.handleFrame({ type: 'tool.call.started', seq: 2, payload: { agentId: 'main', turnId: 1, toolCallId: 'old-call', name: 'Bash' } });
  projector.handleFrame({ type: 'task.started', seq: 3, payload: { agentId: 'main', info: { taskId: 'old-task', parentToolCallId: 'old-call' } } });
  await projector.finalizeTurn('failed');
  const retiredCount = events.length;
  projector.handleFrame({ type: 'task.terminated', seq: 4, payload: { agentId: 'main', info: { taskId: 'old-task', status: 'completed' } } });
  assert.equal(events.length, retiredCount);
  projector.bindTurn({ gianTurnId: 'next', promptId: 'next-prompt' });
  projector.handleFrame({ type: 'turn.started', seq: 5, payload: { agentId: 'main', turnId: 2, promptId: 'next-prompt', origin: { kind: 'user' } } });
  const before = events.length;
  projector.handleFrame({ type: 'background.task.terminated', seq: 6, payload: { agentId: 'main', info: { taskId: 'old-task', status: 'completed' } } });
  projector.handleFrame({ type: 'turn.started', seq: 7, payload: { agentId: 'main', turnId: 3, origin: { kind: 'task', taskId: 'old-task' } } });
  projector.handleFrame({ type: 'assistant.delta', seq: 8, payload: { agentId: 'main', delta: 'foreign continuation' } });
  projector.handleFrame({ type: 'turn.ended', seq: 9, payload: { agentId: 'main', turnId: 3, reason: 'completed' } });
  projector.handleFrame({ type: 'turn.started', seq: 10, payload: { agentId: 'main', origin: { kind: 'user' } } });
  projector.handleFrame({ type: 'assistant.delta', seq: 11, payload: { agentId: 'main', delta: 'unidentified continuation' } });
  await flush();
  assert.equal(events.length, before);
  assert.equal(projector.activeGianTurnId(), 'next');
  await projector.finalizeTurn('completed');
});

test('repeated native terminal events still finalize the admitted turn once', async () => {
  const { projector, events } = createProjector();
  projector.handleFrame({ type: 'turn.started', seq: 1, payload: { turnId: 1, promptId: 'p' } });
  projector.handleFrame({ type: 'turn.ended', seq: 2, payload: { turnId: 1, reason: 'completed' } });
  projector.handleFrame({ type: 'turn.ended', seq: 3, payload: { turnId: 1, reason: 'completed' } });
  await flush();
  assert.equal(events.filter((event) => event.method === 'turn.completed').length, 1);
  assert.equal(projector.hasActiveTurn(), false);
});

test('a delayed old finalization cannot complete or clear the next binding', async () => {
  let resolveDiff!: (value: null) => void;
  const finalized: string[] = [];
  const { projector, events } = createProjector({
    onFinalized: (turnId) => finalized.push(turnId),
    fileDiff: () => new Promise((resolve) => { resolveDiff = resolve; }),
  });
  projector.handleFrame({ type: 'turn.started', seq: 1, payload: { agentId: 'main', turnId: 1, promptId: 'p' } });
  const previous = projector.finalizeTurn('completed');
  projector.bindTurn({ gianTurnId: 'next', promptId: 'next-prompt' });
  projector.handleFrame({ type: 'turn.started', seq: 2, payload: { agentId: 'main', turnId: 2, promptId: 'next-prompt' } });
  resolveDiff(null);
  await previous;
  assert.deepEqual(finalized, []);
  assert.equal(events.some((event) => event.method === 'turn.completed'), false);
  assert.equal(projector.activeGianTurnId(), 'next');
});

test('a newer failure during a slow terminal facet is not reported as success', async () => {
  let resolveDiff!: (value: null) => void;
  const { projector, events } = createProjector({ fileDiff: () => new Promise((resolve) => { resolveDiff = resolve; }) });
  projector.handleFrame({ type: 'turn.started', seq: 1, payload: { turnId: 0, promptId: 'p' } });
  projector.handleFrame({ type: 'turn.ended', seq: 2, payload: { turnId: 0, reason: 'completed' } });
  await flush();
  projector.handleFrame({ type: 'turn.ended', seq: 3, payload: { turnId: 0, reason: 'failed', error: { code: 'provider.rate_limit', message: 'later failure' } } });
  resolveDiff(null);
  await flush();
  assert.equal(events.filter((event) => event.method === 'turn.completed').length, 0);
  assert.equal(events.filter((event) => event.method === 'turn.failed').length, 1);
});

test('new owned work during a slow terminal facet cancels the old finalization', async () => {
  let resolveFirstDiff!: (value: null) => void;
  let diffCalls = 0;
  const { projector, events } = createProjector({
    fileDiff: () => ++diffCalls === 1
      ? new Promise((resolve) => { resolveFirstDiff = resolve; })
      : Promise.resolve(null),
  });
  projector.handleFrame({ type: 'turn.started', seq: 1, payload: { turnId: 0, promptId: 'p' } });
  projector.handleFrame({ type: 'tool.call.started', seq: 2, payload: { turnId: 0, toolCallId: 'bash-call', name: 'Bash' } });
  projector.handleFrame({ type: 'tool.result', seq: 3, payload: { turnId: 0, toolCallId: 'bash-call', output: 'started' } });
  projector.handleFrame({ type: 'assistant.delta', seq: 4, payload: { turnId: 0, delta: 'initial' } });
  projector.handleFrame({ type: 'turn.ended', seq: 5, payload: { turnId: 0, reason: 'completed' } });
  projector.handleFrame({ type: 'event.session.work_changed', seq: 6, payload: { busy: false } });
  await flush();
  assert.equal(diffCalls, 1);
  assert.equal(events.some((event) => event.method === 'content.completed' || event.method === 'turn.completed'), false);
  projector.handleFrame({ type: 'task.started', seq: 7, payload: { info: { taskId: 'owned', parentToolCallId: 'bash-call' } } });
  projector.handleFrame({ type: 'task.terminated', seq: 8, payload: { info: { taskId: 'owned', status: 'completed' } } });
  projector.handleFrame({ type: 'turn.started', seq: 9, payload: { turnId: 1, origin: { kind: 'task', taskId: 'owned' } } });
  projector.handleFrame({ type: 'assistant.delta', seq: 10, payload: { turnId: 1, delta: 'continued' } });
  projector.handleFrame({ type: 'turn.ended', seq: 11, payload: { turnId: 1, reason: 'completed' } });
  projector.handleFrame({ type: 'event.session.work_changed', seq: 12, payload: { busy: false } });
  await flush();
  assert.equal(events.filter((event) => event.method === 'turn.completed').length, 1);
  assert.deepEqual(events.filter((event) => event.method === 'content.completed').map((event) => dataOf(event).content), ['initial', 'continued']);
  resolveFirstDiff(null);
  await flush();
  assert.equal(events.filter((event) => event.method === 'turn.completed').length, 1);
});

test('an interrupt acknowledgement for an old native turn cannot interrupt its continuation', async () => {
  const { projector, events } = createProjector();
  projector.handleFrame({ type: 'turn.started', seq: 1, payload: { turnId: 0, promptId: 'p' } });
  projector.handleFrame({ type: 'event.session.work_changed', seq: 2, payload: { busy: true } });
  projector.handleFrame({ type: 'tool.call.started', seq: 3, payload: { turnId: 0, toolCallId: 'bash-call', name: 'Bash' } });
  projector.handleFrame({ type: 'task.started', seq: 4, payload: { info: { taskId: 'owned', parentToolCallId: 'bash-call' } } });
  projector.handleFrame({ type: 'tool.result', seq: 5, payload: { turnId: 0, toolCallId: 'bash-call', output: 'started' } });
  const generation = projector.beginInterrupt('t');
  assert.notEqual(generation, null);
  projector.handleFrame({ type: 'turn.ended', seq: 6, payload: { turnId: 0, reason: 'cancelled' } });
  projector.handleFrame({ type: 'task.terminated', seq: 7, payload: { info: { taskId: 'owned', status: 'completed' } } });
  projector.handleFrame({ type: 'turn.started', seq: 8, payload: { turnId: 1, origin: { kind: 'task', taskId: 'owned' } } });
  assert.equal(projector.finishInterrupt('t', generation!, true), false);
  projector.handleFrame({ type: 'turn.ended', seq: 9, payload: { turnId: 1, reason: 'completed' } });
  projector.handleFrame({ type: 'event.session.work_changed', seq: 10, payload: { busy: false } });
  await flush();
  const terminal = events.find((event) => event.method === 'turn.completed');
  assert.equal(dataOf(terminal!).stopReason, 'completed');
});

test('a native terminal cannot report success while a failure fence is being resolved', async () => {
  const { projector, events } = createProjector();
  projector.handleFrame({ type: 'turn.started', seq: 1, payload: { turnId: 0, promptId: 'p' } });
  assert.equal(projector.beginFence('t'), true);
  projector.handleFrame({ type: 'turn.ended', seq: 2, payload: { turnId: 0, reason: 'cancelled' } });
  projector.handleFrame({ type: 'event.session.work_changed', seq: 3, payload: { busy: false } });
  await flush();
  assert.equal(events.some((event) => event.method === 'turn.completed' || event.method === 'turn.failed'), false);
  projector.endFence('t', false);
  await projector.failTurn('Native containment could not be confirmed.', true);
  assert.equal(events.filter((event) => event.method === 'turn.failed').length, 1);
  assert.equal(events.some((event) => event.method === 'turn.completed'), false);
});

test('a completed background task without an idle signal cannot prematurely finish the turn', async () => {
  const { projector, events } = createProjector();
  projector.handleFrame({ type: 'turn.started', seq: 1, payload: { turnId: 0, promptId: 'p' } });
  projector.handleFrame({ type: 'tool.call.started', seq: 2, payload: { turnId: 0, toolCallId: 'bash-call', name: 'Bash' } });
  projector.handleFrame({ type: 'task.started', seq: 3, payload: { info: { taskId: 'owned', parentToolCallId: 'bash-call' } } });
  projector.handleFrame({ type: 'tool.result', seq: 4, payload: { turnId: 0, toolCallId: 'bash-call', output: 'started' } });
  projector.handleFrame({ type: 'turn.ended', seq: 5, payload: { turnId: 0, reason: 'completed' } });
  projector.handleFrame({ type: 'task.terminated', seq: 6, payload: { info: { taskId: 'owned', status: 'completed' } } });
  await flush();
  assert.equal(events.some((event) => event.method === 'turn.completed'), false);
  assert.equal(projector.hasActiveTurn(), true);
  projector.handleFrame({ type: 'event.session.work_changed', seq: 7, payload: { busy: false, main_turn_active: false } });
  await flush();
  assert.equal(events.filter((event) => event.method === 'turn.completed').length, 1);
});

test('an idle signal cannot falsely fail an owned task whose terminal event is still in flight', async () => {
  const { projector, events } = createProjector();
  projector.handleFrame({ type: 'turn.started', seq: 1, payload: { turnId: 0, promptId: 'p' } });
  projector.handleFrame({ type: 'tool.call.started', seq: 2, payload: { turnId: 0, toolCallId: 'bash-call', name: 'Bash' } });
  projector.handleFrame({ type: 'task.started', seq: 3, payload: { info: { taskId: 'owned', parentToolCallId: 'bash-call' } } });
  projector.handleFrame({ type: 'tool.result', seq: 4, payload: { turnId: 0, toolCallId: 'bash-call', output: 'started' } });
  projector.handleFrame({ type: 'turn.ended', seq: 5, payload: { turnId: 0, reason: 'completed' } });
  projector.handleFrame({ type: 'event.session.work_changed', seq: 6, payload: { busy: false, main_turn_active: false } });
  await flush();
  assert.equal(events.some((event) => event.method === 'turn.completed'), false);
  assert.equal(events.some((event) => dataOf(event).activityId === 'task:owned' && dataOf(event).status === 'failed'), false);
  projector.handleFrame({ type: 'task.terminated', seq: 7, payload: { info: { taskId: 'owned', status: 'completed' } } });
  await flush();
  assert.equal(events.some((event) => event.method === 'turn.completed'), false);
  projector.handleFrame({ type: 'event.session.work_changed', seq: 8, payload: { busy: false, main_turn_active: false } });
  await flush();
  assert.equal(events.filter((event) => event.method === 'turn.completed').length, 1);
  assert.equal(events.filter((event) => dataOf(event).activityId === 'task:owned' && dataOf(event).status === 'succeeded').length, 1);
});

test('read-only task reconciliation recovers a missing terminal event without resending work', async () => {
  let reads = 0;
  const { projector, events } = createProjector({
    reconcileIntervalMs: 10,
    reconcileWork: async (needs) => {
      reads += 1;
      assert.equal(needs.tasks, true);
      return { lastSeq: 6, busy: false, mainTurnActive: false, pendingInteraction: 'none',
        tasks: [{ id: 'owned', status: 'completed' }], questions: [], approvals: [] };
    },
  });
  projector.handleFrame({ type: 'turn.started', seq: 1, payload: { turnId: 0, promptId: 'p' } });
  projector.handleFrame({ type: 'tool.call.started', seq: 2, payload: { turnId: 0, toolCallId: 'bash-call', name: 'Bash' } });
  projector.handleFrame({ type: 'task.started', seq: 3, payload: { info: { taskId: 'owned', parentToolCallId: 'bash-call' } } });
  projector.handleFrame({ type: 'tool.result', seq: 4, payload: { turnId: 0, toolCallId: 'bash-call', output: 'started' } });
  projector.handleFrame({ type: 'turn.ended', seq: 5, payload: { turnId: 0, reason: 'completed' } });
  projector.handleFrame({ type: 'event.session.work_changed', seq: 6, payload: { busy: true, main_turn_active: false } });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.ok(reads >= 1);
  assert.equal(events.filter((event) => dataOf(event).activityId === 'task:owned' && dataOf(event).status === 'succeeded').length, 1);
  assert.equal(events.filter((event) => event.method === 'turn.completed').length, 1);
  assert.equal(projector.hasActiveTurn(), false);
});

test('a stale reconciliation snapshot cannot settle a newer native continuation', async () => {
  let resolveSnapshot!: (value: { lastSeq: number; busy: boolean; mainTurnActive: boolean; pendingInteraction: 'none'; tasks: Array<{ id: string; status: 'completed' }>; questions: string[]; approvals: string[] }) => void;
  let reading = false;
  const { projector, events } = createProjector({
    reconcileIntervalMs: 10,
    reconcileWork: () => { reading = true; return new Promise((resolve) => { resolveSnapshot = resolve; }); },
  });
  projector.handleFrame({ type: 'turn.started', seq: 1, payload: { turnId: 0, promptId: 'p' } });
  projector.handleFrame({ type: 'tool.call.started', seq: 2, payload: { turnId: 0, toolCallId: 'bash-call', name: 'Bash' } });
  projector.handleFrame({ type: 'task.started', seq: 3, payload: { info: { taskId: 'owned', parentToolCallId: 'bash-call' } } });
  projector.handleFrame({ type: 'tool.result', seq: 4, payload: { turnId: 0, toolCallId: 'bash-call', output: 'started' } });
  projector.handleFrame({ type: 'turn.ended', seq: 5, payload: { turnId: 0, reason: 'completed' } });
  projector.handleFrame({ type: 'event.session.work_changed', seq: 6, payload: { busy: true } });
  const deadline = Date.now() + 1_000;
  while (!reading && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(reading, true);
  projector.handleFrame({ type: 'task.terminated', seq: 7, payload: { info: { taskId: 'owned', status: 'completed' } } });
  projector.handleFrame({ type: 'turn.started', seq: 8, payload: { turnId: 1, origin: { kind: 'task', taskId: 'owned' } } });
  resolveSnapshot({ lastSeq: 6, busy: false, mainTurnActive: false, pendingInteraction: 'none',
    tasks: [{ id: 'owned', status: 'completed' }], questions: [], approvals: [] });
  await flush();
  assert.equal(events.some((event) => event.method === 'turn.completed'), false);
  assert.equal(projector.activeGianTurnId(), 't');
  assert.equal(events.filter((event) => dataOf(event).activityId === 'task:owned' && dataOf(event).status === 'succeeded').length, 1);
});

test('a same-sequence volatile frame invalidates an in-flight work snapshot', async () => {
  let resolveSnapshot!: (value: { lastSeq: number; busy: boolean; mainTurnActive: boolean; pendingInteraction: 'none'; tasks: Array<{ id: string; status: 'completed' }>; questions: string[]; approvals: string[] }) => void;
  let reading = false;
  const { projector, events } = createProjector({
    reconcileIntervalMs: 10,
    reconcileWork: () => { reading = true; return new Promise((resolve) => { resolveSnapshot = resolve; }); },
  });
  projector.handleFrame({ type: 'turn.started', seq: 1, payload: { turnId: 0, promptId: 'p' } });
  projector.handleFrame({ type: 'tool.call.started', seq: 2, payload: { turnId: 0, toolCallId: 'bash-call', name: 'Bash' } });
  projector.handleFrame({ type: 'task.started', seq: 3, payload: { info: { taskId: 'owned', parentToolCallId: 'bash-call' } } });
  projector.handleFrame({ type: 'tool.result', seq: 4, payload: { turnId: 0, toolCallId: 'bash-call', output: 'started' } });
  projector.handleFrame({ type: 'turn.ended', seq: 5, payload: { turnId: 0, reason: 'completed' } });
  projector.handleFrame({ type: 'event.session.work_changed', seq: 6, payload: { busy: true } });
  const deadline = Date.now() + 1_000;
  while (!reading && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(reading, true);
  projector.handleFrame({ type: 'assistant.delta', seq: 6, volatile: true, payload: { delta: 'still active' } });
  resolveSnapshot({ lastSeq: 6, busy: false, mainTurnActive: false, pendingInteraction: 'none',
    tasks: [{ id: 'owned', status: 'completed' }], questions: [], approvals: [] });
  await flush();
  assert.equal(events.some((event) => event.method === 'turn.completed'), false);
  assert.equal(events.some((event) => dataOf(event).activityId === 'task:owned' && dataOf(event).status === 'succeeded'), false);
});

test('unavailable reconciliation reports uncertainty and never guesses a terminal outcome', async () => {
  let reads = 0;
  const { projector, events } = createProjector({
    reconcileIntervalMs: 10,
    reconcileWork: async () => { reads += 1; return null; },
  });
  projector.handleFrame({ type: 'turn.started', seq: 1, payload: { turnId: 0, promptId: 'p' } });
  projector.handleFrame({ type: 'event.session.work_changed', seq: 2, payload: { busy: true } });
  projector.handleFrame({ type: 'turn.ended', seq: 3, payload: { turnId: 0, reason: 'completed' } });
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(reads, 3);
  assert.equal(events.filter((event) => dataOf(event).kind === 'kimi:work-reconciliation').length, 1);
  assert.equal(events.some((event) => event.method === 'turn.completed' || event.method === 'turn.failed'), false);
  assert.equal(projector.hasActiveTurn(), true);
});

test('an absent native question is reported as unknown, not auto-answered or dismissed', async () => {
  const { projector, events } = createProjector({
    reconcileIntervalMs: 10,
    reconcileWork: async () => ({ lastSeq: 6, busy: false, mainTurnActive: false, pendingInteraction: 'none',
      tasks: [], questions: [], approvals: [] }),
  });
  projector.handleFrame({ type: 'turn.started', seq: 1, payload: { turnId: 0, promptId: 'p' } });
  projector.handleFrame({ type: 'tool.call.started', seq: 2, payload: { turnId: 0, toolCallId: 'q-call', name: 'AskUserQuestion' } });
  projector.handleFrame({ type: 'event.question.requested', seq: 3, payload: { turn_id: 0, tool_call_id: 'q-call', question_id: 'q1', questions: [{ id: 'q_0', question: 'Continue?', options: [{ id: 'yes', label: 'Yes' }] }] } });
  projector.handleFrame({ type: 'tool.result', seq: 4, payload: { turnId: 0, toolCallId: 'q-call', output: 'waiting' } });
  projector.handleFrame({ type: 'turn.ended', seq: 5, payload: { turnId: 0, reason: 'completed' } });
  projector.handleFrame({ type: 'event.session.work_changed', seq: 6, payload: { busy: true, pending_interaction: 'question' } });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(projector.pendingInteractions.has('q:q1'), true);
  assert.equal(events.filter((event) => dataOf(event).kind === 'kimi:work-reconciliation').length, 1);
  assert.equal(events.some((event) => event.method === 'interaction.resolved' || event.method === 'turn.completed'), false);
  projector.handleFrame({ type: 'event.question.answered', seq: 7, payload: { question_id: 'q1', turn_id: 0 } });
  projector.handleFrame({ type: 'event.session.work_changed', seq: 8, payload: { busy: false, pending_interaction: 'none' } });
  await flush();
  assert.equal(events.filter((event) => event.method === 'interaction.resolved').length, 1);
  assert.equal(events.filter((event) => event.method === 'turn.completed').length, 1);
});

test('an idle snapshot cannot silently resolve a still-pending question', async () => {
  const { projector, events } = createProjector();
  projector.handleFrame({ type: 'turn.started', seq: 1, payload: { turnId: 0, promptId: 'p' } });
  projector.handleFrame({ type: 'tool.call.started', seq: 2, payload: { turnId: 0, toolCallId: 'q-call', name: 'AskUserQuestion' } });
  projector.handleFrame({ type: 'event.question.requested', seq: 3, payload: { turn_id: 0, tool_call_id: 'q-call', question_id: 'q1', questions: [{ id: 'q_0', question: 'Continue?', options: [{ id: 'yes', label: 'Yes' }] }] } });
  projector.handleFrame({ type: 'tool.result', seq: 4, payload: { turnId: 0, toolCallId: 'q-call', output: 'waiting' } });
  projector.handleFrame({ type: 'turn.ended', seq: 5, payload: { turnId: 0, reason: 'completed' } });
  projector.handleFrame({ type: 'event.session.work_changed', seq: 6, payload: { busy: false, pending_interaction: 'none' } });
  await flush();
  assert.equal(projector.hasActiveTurn(), true);
  assert.equal(events.some((event) => event.method === 'interaction.resolved' || event.method === 'turn.completed'), false);
  projector.handleFrame({ type: 'event.question.dismissed', seq: 7, payload: { question_id: 'q1', turn_id: 0 } });
  await flush();
  assert.equal(events.filter((event) => event.method === 'interaction.resolved').length, 1);
  assert.equal(events.some((event) => event.method === 'turn.completed'), false);
  projector.handleFrame({ type: 'event.session.work_changed', seq: 8, payload: { busy: false, pending_interaction: 'none' } });
  await flush();
  assert.equal(events.filter((event) => event.method === 'turn.completed').length, 1);
});

test('continuations do not reuse native tool or plan identities', async () => {
  const { projector, events } = createProjector();
  projector.handleFrame({ type: 'turn.started', seq: 1, payload: { turnId: 0, promptId: 'p' } });
  projector.handleFrame({ type: 'event.session.work_changed', seq: 2, payload: { busy: true } });
  projector.handleFrame({ type: 'tool.call.started', seq: 3, payload: { turnId: 0, toolCallId: 'reused', name: 'TodoList', display: { kind: 'todo_list', items: [{ title: 'A', status: 'pending' }] } } });
  projector.handleFrame({ type: 'task.started', seq: 4, payload: { info: { taskId: 'owned', parentToolCallId: 'reused' } } });
  projector.handleFrame({ type: 'tool.result', seq: 5, payload: { turnId: 0, toolCallId: 'reused', output: 'started' } });
  projector.handleFrame({ type: 'turn.ended', seq: 6, payload: { turnId: 0, reason: 'completed' } });
  projector.handleFrame({ type: 'task.terminated', seq: 7, payload: { info: { taskId: 'owned', status: 'completed' } } });
  projector.handleFrame({ type: 'turn.started', seq: 8, payload: { turnId: 1, origin: { kind: 'task', taskId: 'owned' }, promptId: 'task:continuation' } });
  assert.equal(projector.activePromptId(), 'task:continuation');
  projector.handleFrame({ type: 'tool.call.started', seq: 9, payload: { turnId: 1, toolCallId: 'reused', name: 'TodoList', display: { kind: 'todo_list', items: [{ title: 'B', status: 'pending' }] } } });
  projector.handleFrame({ type: 'tool.result', seq: 10, payload: { toolCallId: 'reused', output: 'ambiguous old result' } });
  projector.handleFrame({ type: 'tool.result', seq: 11, payload: { turnId: 1, toolCallId: 'reused', output: 'done' } });
  projector.handleFrame({ type: 'turn.ended', seq: 12, payload: { turnId: 1, reason: 'completed' } });
  projector.handleFrame({ type: 'event.session.work_changed', seq: 13, payload: { busy: false } });
  await flush();
  const tools = events.filter((event) => event.method === 'activity.updated' && dataOf(event).kind === 'tool:TodoList');
  assert.deepEqual(tools.map((event) => dataOf(event).activityId), ['reused', 'reused', 'native:1:reused', 'native:1:reused']);
  assert.equal(new Set(tools.map((event) => event.params.eventId)).size, 4);
  const plans = events.filter((event) => event.method === 'plan.updated');
  assert.equal(new Set(plans.map((event) => event.params.eventId)).size, 2);
  assert.equal(events.filter((event) => event.method === 'turn.completed').length, 1);
});

test('a suspended owned subagent can resume without prematurely finalizing its turn', async () => {
  const { projector, events } = createProjector();
  projector.handleFrame({ type: 'turn.started', seq: 1, payload: { turnId: 0, promptId: 'p' } });
  projector.handleFrame({ type: 'event.session.work_changed', seq: 2, payload: { busy: true } });
  projector.handleFrame({ type: 'tool.call.started', seq: 3, payload: { turnId: 0, toolCallId: 'agent-call', name: 'Agent' } });
  projector.handleFrame({ type: 'subagent.spawned', seq: 4, payload: { turnId: 0, subagentId: 'owned-agent', parentToolCallId: 'agent-call' } });
  projector.handleFrame({ type: 'tool.result', seq: 5, payload: { turnId: 0, toolCallId: 'agent-call', output: 'started' } });
  projector.handleFrame({ type: 'subagent.suspended', seq: 6, payload: { subagentId: 'owned-agent' } });
  projector.handleFrame({ type: 'subagent.started', seq: 7, payload: { subagentId: 'owned-agent' } });
  projector.handleFrame({ type: 'turn.ended', seq: 8, payload: { turnId: 0, reason: 'completed' } });
  await flush();
  assert.equal(events.some((event) => event.method === 'turn.completed'), false);
  projector.handleFrame({ type: 'subagent.completed', seq: 9, payload: { subagentId: 'owned-agent' } });
  projector.handleFrame({ type: 'subagent.started', seq: 10, payload: { subagentId: 'owned-agent' } });
  projector.handleFrame({ type: 'event.session.work_changed', seq: 11, payload: { busy: false } });
  await flush();
  const statuses = events.filter((event) => dataOf(event).activityId === 'owned-agent').map((event) => dataOf(event).status);
  assert.deepEqual(statuses, ['running', 'cancelled', 'running', 'succeeded']);
  assert.equal(events.filter((event) => event.method === 'turn.completed').length, 1);
});

test('a subagent retains its original parent when a later native turn reuses the tool ID', async () => {
  const { projector, events } = createProjector();
  projector.handleFrame({ type: 'turn.started', seq: 1, payload: { turnId: 0, promptId: 'p' } });
  projector.handleFrame({ type: 'event.session.work_changed', seq: 2, payload: { busy: true } });
  projector.handleFrame({ type: 'tool.call.started', seq: 3, payload: { turnId: 0, toolCallId: 'reused', name: 'Agent' } });
  projector.handleFrame({ type: 'subagent.spawned', seq: 4, payload: { turnId: 0, subagentId: 'owned-agent', parentToolCallId: 'reused' } });
  projector.handleFrame({ type: 'task.started', seq: 5, payload: { info: { taskId: 'owned-task', parentToolCallId: 'reused' } } });
  projector.handleFrame({ type: 'tool.result', seq: 6, payload: { turnId: 0, toolCallId: 'reused', output: 'started' } });
  projector.handleFrame({ type: 'turn.ended', seq: 7, payload: { turnId: 0, reason: 'completed' } });
  projector.handleFrame({ type: 'task.terminated', seq: 8, payload: { info: { taskId: 'owned-task', status: 'completed' } } });
  projector.handleFrame({ type: 'turn.started', seq: 9, payload: { turnId: 1, origin: { kind: 'task', taskId: 'owned-task' } } });
  projector.handleFrame({ type: 'tool.call.started', seq: 10, payload: { turnId: 1, toolCallId: 'reused', name: 'Bash' } });
  projector.handleFrame({ type: 'tool.result', seq: 11, payload: { turnId: 1, toolCallId: 'reused', output: 'done' } });
  projector.handleFrame({ type: 'subagent.completed', seq: 12, payload: { subagentId: 'owned-agent', parentToolCallId: 'reused' } });
  projector.handleFrame({ type: 'turn.ended', seq: 13, payload: { turnId: 1, reason: 'completed' } });
  projector.handleFrame({ type: 'event.session.work_changed', seq: 14, payload: { busy: false } });
  await flush();
  const done = events.find((event) => dataOf(event).activityId === 'owned-agent' && dataOf(event).status === 'succeeded');
  const presentation = dataOf(done!).presentation as { data: { parentToolCallId: string } };
  assert.equal(presentation.data.parentToolCallId, 'reused');
  assert.equal(events.filter((event) => event.method === 'turn.completed').length, 1);
});

test('usage after turn completion remains session-scoped without reviving the retired turn', async () => {
  const { projector, events } = createProjector();
  projector.handleFrame({ type: 'turn.started', seq: 1, payload: { turnId: 0, promptId: 'p' } });
  await projector.finalizeTurn('completed');
  projector.handleFrame({ type: 'agent.status.updated', seq: 2, payload: {
    agentId: 'main', usage: { total: { inputOther: 4, output: 2, inputCacheRead: 0, inputCacheCreation: 0 } },
  } });
  const usage = events.filter((event) => event.method === 'usage.updated');
  assert.equal(usage.length, 1);
  assert.equal(usage[0]!.params.turnId, undefined);
  assert.equal(usage[0]!.params.sourceTurnId, undefined);
  assert.equal(projector.hasActiveTurn(), false);
});

test('volatile thinking and assistant deltas that reuse the durable seq are projected', async () => {
  const { projector, events } = createProjector();
  assert.equal(projector.handleFrame(frame({
    type: 'turn.started', seq: 4, payload: { agentId: 'main', turnId: 1 },
  })), true);
  assert.equal(projector.handleFrame(frame({
    type: 'turn.step.started', seq: 5, payload: { agentId: 'main', turnId: 1, step: 1 },
  })), true);
  assert.equal(projector.handleFrame(frame({
    type: 'thinking.delta', seq: 5, volatile: true, offset: 0,
    payload: { agentId: 'main', delta: 'Think' },
  })), true);
  assert.equal(projector.handleFrame(frame({
    type: 'thinking.delta', seq: 5, volatile: true, offset: 5,
    payload: { agentId: 'main', delta: 'ing' },
  })), true);
  assert.equal(projector.handleFrame(frame({
    type: 'thinking.delta', seq: 5, volatile: true, offset: 0,
    payload: { agentId: 'main', delta: 'dup' },
  })), true, 'a stale offset is consumed and not appended');
  assert.equal(projector.handleFrame(frame({
    type: 'assistant.delta', seq: 5, volatile: true, offset: 0,
    payload: { agentId: 'main', delta: 'Hi' },
  })), true);
  assert.equal(projector.handleFrame(frame({
    type: 'assistant.delta', seq: 5, volatile: true, offset: 2,
    payload: { agentId: 'main', delta: '!' },
  })), true);
  assert.equal(projector.handleFrame(frame({
    type: 'turn.ended', seq: 6, payload: { agentId: 'main', turnId: 1, reason: 'completed' },
  })), true, 'the next durable seq is still accepted');

  await flush();
  const deltas = events.filter((event) => event.method === 'content.delta');
  const reasoning = deltas.filter((event) => dataOf(event).kind === 'reasoning');
  const text = deltas.filter((event) => dataOf(event).kind === 'text');
  assert.deepEqual(reasoning.map((event) => dataOf(event).delta), ['Think', 'ing']);
  assert.deepEqual(text.map((event) => dataOf(event).delta), ['Hi', '!']);
  assert.equal(dataOf(text[0]!).contentId, 'assistant:p:1');
  assert.equal(dataOf(reasoning[0]!).contentId, 'thinking:p:1');
  const ids = deltas.map((event) => event.params.eventId);
  assert.equal(new Set(ids).size, ids.length, 'each delta keeps its own eventId');

  const completed = events.filter((event) => event.method === 'content.completed');
  assert.equal(dataOf(completed.find((event) => dataOf(event).kind === 'reasoning')!).content, 'Thinking');
  assert.equal(dataOf(completed.find((event) => dataOf(event).kind === 'text')!).content, 'Hi!');
  assert.equal(events.some((event) => event.method === 'turn.completed'), true);
});

test('each step keeps its own assistant message and its own thinking card', async () => {
  const { projector, events } = createProjector();
  projector.handleFrame(frame({ type: 'turn.started', seq: 1, payload: { agentId: 'main', turnId: 1 } }));
  projector.handleFrame(frame({ type: 'turn.step.started', seq: 2, payload: { agentId: 'main', turnId: 1, step: 1 } }));
  projector.handleFrame(frame({
    type: 'thinking.delta', seq: 2, volatile: true, offset: 2,
    payload: { agentId: 'main', delta: 'ab' },
  }));
  projector.handleFrame(frame({
    type: 'assistant.delta', seq: 2, volatile: true, offset: 0,
    payload: { agentId: 'main', delta: 'Not yet.' },
  }));
  projector.handleFrame(frame({ type: 'turn.step.started', seq: 3, payload: { agentId: 'main', turnId: 1, step: 2 } }));
  projector.handleFrame(frame({
    type: 'thinking.delta', seq: 3, volatile: true, offset: 0,
    payload: { agentId: 'main', delta: 'ab' },
  }));
  projector.handleFrame(frame({
    type: 'assistant.delta', seq: 3, volatile: true, offset: 0,
    payload: { agentId: 'main', delta: 'Found it.' },
  }));
  projector.handleFrame(frame({
    type: 'turn.ended', seq: 4, payload: { agentId: 'main', turnId: 1, reason: 'completed' },
  }));
  await flush();

  const text = events.filter((event) => event.method === 'content.delta' && dataOf(event).kind === 'text');
  const reasoning = events.filter((event) => event.method === 'content.delta' && dataOf(event).kind === 'reasoning');
  assert.deepEqual(text.map((event) => dataOf(event).contentId), ['assistant:p:1', 'assistant:p:2']);
  assert.deepEqual(reasoning.map((event) => dataOf(event).contentId), ['thinking:p:1', 'thinking:p:2']);
  const completedText = events.filter((event) => event.method === 'content.completed' && dataOf(event).kind === 'text');
  const completedReasoning = events.filter((event) => event.method === 'content.completed' && dataOf(event).kind === 'reasoning');
  assert.deepEqual(completedText.map((event) => dataOf(event).content), ['Not yet.', 'Found it.']);
  assert.deepEqual(completedReasoning.map((event) => dataOf(event).content), ['ab', 'ab']);
});

test('a volatile frame older than the durable watermark is dropped', () => {
  const { projector, events } = createProjector();
  projector.handleFrame(frame({ type: 'turn.started', seq: 8, payload: { agentId: 'main', turnId: 1 } }));
  assert.equal(projector.handleFrame(frame({
    type: 'thinking.delta', seq: 7, volatile: true, offset: 0,
    payload: { agentId: 'main', delta: 'late' },
  })), false);
  assert.equal(events.length, 0);
});

test('tool displays stay activities and keep their presentation through the result', () => {
  const { projector, events } = createProjector();
  projector.handleFrame(frame({ type: 'turn.started', seq: 1, payload: { agentId: 'main', turnId: 1 } }));
  const calls: Array<{ toolCallId: string; name: string; args: Record<string, unknown>; display: Record<string, unknown> }> = [
    { toolCallId: 'bash', name: 'Bash', args: { command: 'echo hi' }, display: { kind: 'command', command: 'echo hi' } },
    { toolCallId: 'read', name: 'Read', args: {}, display: { kind: 'file_io', operation: 'read', path: 'a.ts' } },
    { toolCallId: 'edit', name: 'Edit', args: {}, display: { kind: 'file_io', operation: 'edit', path: 'b.ts' } },
    { toolCallId: 'grep', name: 'Grep', args: { pattern: 'mergeAdjacentLists' }, display: { kind: 'file_io', operation: 'grep', path: 'src' } },
    { toolCallId: 'fetch', name: 'FetchURL', args: {}, display: { kind: 'url_fetch', url: 'https://example.com' } },
  ];
  let seq = 1;
  for (const call of calls) {
    seq += 1;
    projector.handleFrame(frame({
      type: 'tool.call.started', seq, payload: { agentId: 'main', ...call },
    }));
    seq += 1;
    projector.handleFrame(frame({
      type: 'tool.result', seq, payload: { agentId: 'main', toolCallId: call.toolCallId, output: 'ok' },
    }));
  }
  const rows = events.filter((event) => event.method === 'activity.updated')
    .map((event) => dataOf(event));
  const presentation = (id: string, status: string) => {
    const row = rows.find((entry) => entry.activityId === id && entry.status === status);
    return row?.presentation as { type: string; data: Record<string, unknown> };
  };
  assert.deepEqual(presentation('bash', 'running'), { type: 'command', data: { command: 'echo hi' } });
  assert.equal(presentation('bash', 'succeeded').type, 'command');
  assert.equal(rows.find((entry) => entry.activityId === 'bash' && entry.status === 'succeeded')?.summary, 'ok');
  assert.deepEqual(presentation('read', 'succeeded').data.operation, 'read');
  assert.equal(presentation('read', 'succeeded').type, 'file');
  assert.deepEqual(presentation('edit', 'running'), { type: 'file', data: { path: 'b.ts', operation: 'write' } });
  assert.equal(presentation('edit', 'succeeded').type, 'file');
  assert.deepEqual(presentation('grep', 'running'), {
    type: 'file-search',
    data: { pattern: 'mergeAdjacentLists', searchKind: 'grep', path: 'src' },
  });
  assert.equal(presentation('grep', 'succeeded').type, 'file-search');
  assert.deepEqual(presentation('fetch', 'running'), { type: 'search', data: { query: 'https://example.com' } });
  assert.equal(presentation('fetch', 'succeeded').type, 'search');
});

test('volatile usage updates that share a seq keep distinct event ids', () => {
  const { projector, events } = createProjector();
  projector.handleFrame(frame({ type: 'turn.started', seq: 3, payload: { agentId: 'main', turnId: 1 } }));
  const status = (inputOther: number, output: number): KimiProjectedFrame => frame({
    type: 'agent.status.updated',
    seq: 3,
    volatile: true,
    payload: {
      agentId: 'main',
      usage: { total: { inputOther, output, inputCacheRead: 0, inputCacheCreation: 0 } },
    },
  });
  projector.handleFrame(status(1, 1));
  projector.handleFrame(status(1, 1));
  projector.handleFrame(status(4, 2));
  const usage = events.filter((event) => event.method === 'usage.updated');
  assert.equal(usage.length, 2);
  assert.notEqual(usage[0]!.params.eventId, usage[1]!.params.eventId);
  assert.deepEqual(dataOf(usage[0]!).conversation, {
    mode: 'absolute', inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, totalTokens: 2,
  });
  assert.deepEqual(dataOf(usage[1]!).conversation, {
    mode: 'absolute', inputTokens: 4, outputTokens: 2, cachedInputTokens: 0, totalTokens: 6,
  });
});

test('later-turn live usage keeps distinct identity and finalization never queries placeholder session totals', async () => {
  const events: OuterNotification[] = [];
  let sequence = 0;
  let finalReads = 0;
  const snapshot = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    total_cost_usd: 0,
    context_tokens: 0,
    context_limit: 0,
    turn_count: 0,
  };
  const projector = new KimiSessionProjector({
    gianSessionId: 's',
    nativeSessionId: 'session_cfdd46ed-9296-44d7-9ec5-ebd02e11163d',
    nextSequence: () => {
      sequence += 1;
      return sequence;
    },
    emit: (notification) => events.push(notification),
    finalUsage: async () => { finalReads++; return snapshot; },
    fileDiff: async () => null,
  });
  projector.setStreamId('stream-1');
  const status = (seq: number): KimiProjectedFrame => frame({
    type: 'agent.status.updated',
    seq,
    volatile: true,
    payload: {
      agentId: 'main',
      usage: { total: { inputOther: 3, output: 1, inputCacheRead: 0, inputCacheCreation: 0 } },
    },
  });

  projector.bindTurn({ gianTurnId: 't1', promptId: 'prompt-1' });
  projector.handleFrame(frame({ type: 'turn.started', seq: 1, payload: { agentId: 'main', turnId: 0 } }));
  projector.handleFrame(status(1));
  await projector.finalizeTurn('interrupted');

  projector.bindTurn({ gianTurnId: 't2', promptId: 'prompt-2' });
  projector.handleFrame(frame({ type: 'turn.started', seq: 2, payload: { agentId: 'main', turnId: 1 } }));
  projector.handleFrame(status(2));
  await projector.finalizeTurn('completed');

  const usage = events.filter((event) => event.method === 'usage.updated');
  assert.equal(usage.length, 2, 'each turn emits only the existing live total');
  assert.equal(finalReads, 0, 'Token accounting must not trigger an extra Runtime query');
  const ids = usage.map((event) => String(event.params.eventId));
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(usage.map(event => event.params.sourceTurnId), ['prompt-1', 'prompt-2']);
  assert.equal(usage.every(event => {
    const conversation = dataOf(event).conversation as {
      inputTokens: number; outputTokens: number; cachedInputTokens: number; totalTokens: number;
    };
    return conversation.inputTokens === 3
      && conversation.outputTokens === 1
      && conversation.cachedInputTokens === 0
      && conversation.totalTokens === 4;
  }), true, 'placeholder final zeros must not replace the known live counters');
});

test('main-agent usage.total keeps cache inside input and drops incomplete snapshots', () => {
  const { projector, events } = createProjector();
  const status = (payload: Record<string, unknown>): KimiProjectedFrame => frame({
    type: 'agent.status.updated',
    seq: 3,
    volatile: true,
    payload,
  });
  const total = {
    inputOther: 60,
    output: 20,
    inputCacheRead: 30,
    inputCacheCreation: 10,
  };
  projector.handleFrame(status({
    agentId: 'main',
    contextTokens: 9_000,
    usage: {
      total,
      currentTurn: { inputOther: 1, output: 1, inputCacheRead: 0, inputCacheCreation: 0 },
      byModel: { 'kimi-for-coding': total },
    },
  }));
  projector.handleFrame(status({
    agentId: 'child',
    usage: { total: { inputOther: 500, output: 500, inputCacheRead: 0, inputCacheCreation: 0 } },
  }));
  projector.handleFrame(status({
    agentId: 'main',
    usage: { total: { inputOther: 60, output: 20, inputCacheRead: 30 } },
  }));
  projector.handleFrame(status({
    agentId: 'main',
    usage: { total: { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 } },
  }));
  const usage = events.filter((event) => event.method === 'usage.updated');
  assert.deepEqual(usage.map((event) => dataOf(event).conversation), [
    {
      mode: 'absolute',
      inputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: 30,
      totalTokens: 120,
    },
    {
      mode: 'absolute',
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      totalTokens: 0,
    },
  ]);
  assert.equal(projectKimiCumulativeUsage({
    inputOther: 60,
    output: 20,
    inputCacheRead: 30,
  }), null);
  assert.equal(projectKimiCumulativeUsage({
    inputOther: Number.MAX_SAFE_INTEGER,
    output: 1,
    inputCacheRead: 0,
    inputCacheCreation: 0,
  }), null);
  assert.equal(projectKimiCumulativeUsage({
    inputOther: 1.5,
    output: 1,
    inputCacheRead: 0,
    inputCacheCreation: 0,
  }), null);
  assert.equal(projectKimiCumulativeUsage({
    inputOther: 4,
    output: Number.NaN,
    inputCacheRead: 0,
    inputCacheCreation: 0,
  }), null);
  assert.equal(projectKimiCumulativeUsage({
    inputOther: -1,
    output: 1,
    inputCacheRead: 0,
    inputCacheCreation: 0,
  }), null);
});
