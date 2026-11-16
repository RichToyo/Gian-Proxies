import { createHash } from 'node:crypto';
import { inputItemsOf, terminalEventIdFor, type ReplayEvent } from '../core/replay.js';
import type { KimiMessage } from '../core/types.js';
import { projectConversationItem } from './conversation-item.js';
import { projectConversationUsage } from './conversation-usage.js';
import { restoreConversationInput } from './conversation-input-metadata.js';

type Frame = Record<string, unknown>;
function object(value: unknown): value is Frame { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function id(value: unknown): value is string { return typeof value === 'string' && value !== ''; }
function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16); }

/** Build replay from the same native items as live projection. If native
 * history cannot faithfully identify an input, fail instead of fabricating it. */
export function buildConversationReplay(context: { sessionId: string; nativeSessionId: string; replayStreamId: string;
  turns: Frame[]; messages: KimiMessage[] }): ReplayEvent[] {
  const events: ReplayEvent[] = [];
  const push = (sourceTurnId: string, method: string, eventId: string, data: Frame, emittedAt: string) => {
    events.push({ method, eventId, sessionId: context.sessionId, replayStreamId: context.replayStreamId,
      sequence: events.length + 1, sourceTurnId, emittedAt, data });
  };
  const groups: Array<{ promptId: string; turns: Frame[] }> = [];
  const owners = new Map<string, number>();
  for (const turn of context.turns) {
    if (!id(turn.turn_id) || !id(turn.started_at) || !Array.isArray(turn.items)) throw new Error('Invalid Kimi conversation history turn.');
    const opener = turn.items.find(item => object(item) && item.type === 'user_message' && item.placement === 'opener');
    let index: number;
    if (object(opener)) {
      if (!Array.isArray(opener.prompt_ids) || opener.prompt_ids.length !== 1 || !id(opener.prompt_ids[0])) {
        throw new Error('Kimi history cannot faithfully identify this native turn.');
      }
      index = groups.length;
      groups.push({ promptId: opener.prompt_ids[0], turns: [] });
    } else {
      const notification = turn.items.find(item => object(item) && item.type === 'notification' && id(item.task_id)
        && object(item.source) && item.source.kind === 'background_task' && item.source.id === item.task_id);
      const owner = object(notification) && id(notification.task_id) ? owners.get(notification.task_id) : undefined;
      if (owner !== undefined && owner === groups.length - 1) index = owner;
      else if (turn.kind === 'system' && turn.items.every(item => object(item) && item.type === 'system')) {
        index = groups.length;
        groups.push({ promptId: turn.turn_id, turns: [] });
      } else throw new Error('Kimi history cannot faithfully attribute this continuation.');
    }
    const group = groups[index]!;
    group.turns.push(turn);
    for (const item of turn.items) {
      if (!object(item) || item.type !== 'tool_call') continue;
      const taskIds = [item.task_id, ...(Array.isArray(item.agent_refs) ? item.agent_refs.filter(object).map(ref => ref.task_id) : [])].filter(id);
      for (const taskId of taskIds) {
        const prior = owners.get(taskId);
        if (prior !== undefined && prior !== index) throw new Error('Kimi history task ownership is ambiguous.');
        owners.set(taskId, index);
      }
    }
  }
  for (const group of groups) {
    const promptId = group.promptId;
    const first = group.turns[0]!;
    push(promptId, 'turn.started', `evt-${digest([context.nativeSessionId, promptId, 'turn.started'])}`, {}, first.started_at as string);
    let lastEnd: { turn: Frame; time: string } | null = null;
    let anyFailure = false;
    let anyLimit = false;
    for (const turn of group.turns) {
      for (const value of turn.items as unknown[]) {
        if (!object(value) || !id(value.item_id) || !id(value.created_at)) throw new Error('Invalid Kimi conversation history item.');
        if (value.type === 'user_message') {
          if (typeof value.text !== 'string' || !Array.isArray(value.attachments) || !Array.isArray(value.skills)) throw new Error('Invalid Kimi history input.');
          let input = restoreConversationInput(value);
          const gaps: string[] = [];
          if (input === null) {
            const matches = context.messages.filter(message => message.role === 'user'
              && (message.id === value.item_id || (id(message.prompt_id) && Array.isArray(value.prompt_ids) && value.prompt_ids.includes(message.prompt_id))));
            if (matches.length > 1) gaps.push('The original message identity is ambiguous.');
            input = matches.length === 1 ? inputItemsOf(matches[0]!) : value.text ? [{ type: 'text', text: value.text }] : [];
            const mediaCount = input.filter(item => item.type === 'localFile' || item.type === 'localImage').length;
            if (mediaCount !== value.attachments.length) {
              input = input.filter(item => item.type !== 'localFile' && item.type !== 'localImage');
              gaps.push('Kimi did not retain enough information to restore the original attachment paths.');
            }
            for (const skill of value.skills) {
              if (!object(skill) || !id(skill.name) || !id(skill.path)) {
                gaps.push('Kimi did not retain enough information to restore a skill path.');
                continue;
              }
              input = [...input, { type: 'skill', name: skill.name, path: skill.path }];
            }
          }
          if (input.length) push(promptId, 'input.recorded', `evt-${digest([context.nativeSessionId, value.item_id, 'input.recorded'])}`, { input }, value.created_at);
          if (gaps.length) {
            const data = { activityId: `history-gap:${promptId}:${value.item_id}`, kind: 'kimi:history-gap',
              title: 'Some original input is unavailable', status: 'failed',
              presentation: { type: 'notice', data: { message: [...new Set(gaps)].join(' ') } } };
            push(promptId, 'activity.updated', `evt-${digest([context.nativeSessionId, promptId, value.item_id, 'history-gap', data])}`, data, value.created_at);
          }
          continue;
        }
        if (value.type !== 'assistant_message' && value.type !== 'reasoning' && value.type !== 'tool_call' && value.type !== 'notification' && value.type !== 'system') {
          throw new Error('Kimi history contains an unsupported native item.');
        }
        if (value.status !== 'ended') throw new Error('Kimi history contains unfinished native work.');
        const projected = projectConversationItem(context.nativeSessionId, promptId, value);
        if (projected) push(promptId, projected.method, projected.eventId, projected.data, value.created_at);
      }
      if (turn.status !== 'ended' || !['completed', 'interrupted', 'failed'].includes(String(turn.outcome))) throw new Error('Kimi history contains an unfinished native turn.');
      const endTime = id(turn.ended_at) ? turn.ended_at : turn.started_at as string;
      const usage = projectConversationUsage(turn.usage);
      if (usage) push(promptId, 'usage.updated', `evt-${digest([context.nativeSessionId, promptId, ['turn-usage', turn.turn_id, usage]])}`, usage, endTime);
      if (turn.outcome === 'failed' && turn.end_reason !== 'max_steps') anyFailure = true;
      if (turn.end_reason === 'max_steps') anyLimit = true;
      lastEnd = { turn, time: endTime };
    }
    if (!lastEnd) throw new Error('Kimi history group has no terminal turn.');
    const { turn, time: endTime } = lastEnd;
    const failed = anyFailure;
    const method = failed ? 'turn.failed' : 'turn.completed';
    const data = failed ? { error: { domainCode: 'RUNTIME_ERROR', message: 'Kimi turn failed.', retryable: false, details: {} } }
      : { stopReason: anyLimit ? 'limit_reached' : turn.outcome === 'interrupted' ? 'cancelled'
        : turn.end_reason === 'blocked' ? 'other' : 'completed' };
    push(promptId, method, terminalEventIdFor(context.nativeSessionId, promptId, method), data, endTime);
  }
  return events;
}
