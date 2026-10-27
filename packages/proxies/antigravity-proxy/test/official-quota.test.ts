import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isProxyOfficialQuotaReadResult } from '@gian/proxy-protocol';
import { normalizeAntigravityCliQuota, supportsAntigravityCliQuota } from '../src/core/official-quota.js';
import { AntigravityCliQuota } from '../src/runtime/cli-quota.js';
import { AntigravityCliModelsError, type readAntigravityCliReport } from '../src/runtime/cli-models.js';
import { AntigravityProtocolV2Adapter } from '../src/protocol/v2-adapter.js';
import type { AntigravityService } from '../src/contracts.js';

const selection = { model: 'gemini-fixture', provider: null, identityNonce: 'a'.repeat(64) };
const helper = { path: '/isolated/agy', source: 'injected' as const, dev: 1, ino: 2, size: 3, mtimeMs: 4 };
// Synthetic values with the 1.4.6 print-mode envelope and flat groups shape.
// No user account response or real quota values are stored in these fixtures.
const bucket = { id: 'pro-fixture', name: 'Gemini Pro', window: '5h', remaining_fraction: 0.75,
  reset_time: '2026-10-24T04:00:00Z' };
const document = (buckets: unknown = [bucket], extra = {}) => JSON.stringify({
  status: 'SUCCESS', conversation_id: '', num_turns: 0, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  command: { name: 'usage', data: { groups: [{ name: 'Gemini', buckets }],
    credits: { remaining_credits: 5000, plan_name: 'Fixture Plan', upgrade_uri: 'https://ignored.invalid' } } }, ...extra,
});

test('AGY accepts native flat groups and the prior wrapper without double-reading ambiguous payloads', () => {
  const flat = JSON.parse(document());
  const groups = flat.command.data.groups;
  const wrapped = document(undefined, { command: { name: 'usage', data: { quota: { groups } } } });
  assert.deepEqual(normalizeAntigravityCliQuota(JSON.stringify(flat)), normalizeAntigravityCliQuota(wrapped));
  for (const quota of [null, { groups }, { groups: [] }]) {
    const ambiguous = document(undefined, { command: { name: 'usage', data: { groups, quota } } });
    assert.throws(() => normalizeAntigravityCliQuota(ambiguous), /invalid_response/);
  }
  for (const groups of [null, {}, 'not-an-array']) {
    assert.throws(() => normalizeAntigravityCliQuota(document(undefined, {
      command: { name: 'usage', data: { groups } },
    })), /invalid_response/);
  }
});

test('AGY preserves multiple native groups and their five-hour and weekly buckets', () => {
  const groups = ['Primary models', 'Other models'].map((name, index) => ({ name, description: 'Synthetic description',
    buckets: [{ ...bucket, window: 'weekly', remaining_fraction: 0.6 + index / 10 }, bucket] }));
  const result = normalizeAntigravityCliQuota(document(undefined, { command: { name: 'usage', data: { groups } } }));
  assert.equal(result.windows.length, 4);
  assert.deepEqual(result.windows.map(window => window.windowDurationMinutes), [10_080, 300, 10_080, 300]);
  assert.equal(new Set(result.windows.map(window => window.id)).size, 4);
  assert.deepEqual(result.balances, []);
});

test('AGY maps explicit remaining fraction and reset time, never credits into currency or local Token usage', () => {
  const result = normalizeAntigravityCliQuota(document());
  assert.equal(result.windows[0]?.usedRatio, 0.25);
  assert.equal(result.windows[0]?.label, 'Gemini Pro - 5h');
  assert.equal(result.windows[0]?.windowDurationMinutes, 300);
  assert.equal(result.windows[0]?.resetAt, Date.parse(bucket.reset_time));
  assert.deepEqual(result.balances, []);
  assert.doesNotMatch(JSON.stringify(result), /5000|upgrade|ignored.invalid|input_tokens/);
});

test('AGY keeps omitted fractions unknown, skips disabled buckets and deduplicates repeated buckets', () => {
  const unknown = { name: 'Requests', remaining_amount: 30 };
  const result = normalizeAntigravityCliQuota(document([bucket, bucket, { ...bucket, id: 'disabled', disabled: true }, unknown]));
  assert.equal(result.windows.length, 2);
  assert.equal(result.windows[1]?.usedRatio, null);
  assert.equal(result.windows[1]?.windowDurationMinutes, null);
  assert.equal(normalizeAntigravityCliQuota(document([{ ...bucket, remaining_fraction: 0 }])).windows[0]?.usedRatio, 1);
  assert.throws(() => normalizeAntigravityCliQuota(document([bucket, { ...bucket, remaining_fraction: 0.1 }])), /invalid_response/);
});

test('AGY refuses model output, bad quota fields and absent subscription data instead of inventing zero', () => {
  for (const extra of [{ conversation_id: 'accidental-session' }, { num_turns: 1 },
    { usage: { output_tokens: 1 } }, { usage: null }, { command: { name: 'models', data: {} } }]) {
    assert.throws(() => normalizeAntigravityCliQuota(document(undefined, extra)), /invalid_response/);
  }
  for (const change of [{ remaining_fraction: 1.1 }, { remaining_fraction: '0.5' },
    { reset_time: 'invalid' }, { reset_time: '2026-10-24T04:00:00' }, { name: 'bad\nlabel' }]) {
    assert.throws(() => normalizeAntigravityCliQuota(document([{ ...bucket, ...change }])), /invalid_response/);
  }
  assert.throws(() => normalizeAntigravityCliQuota(document([])), /unsupported/);
  assert.throws(() => normalizeAntigravityCliQuota(document(undefined, { command: { name: 'usage', data: {} } })), /invalid_response/);
  assert.throws(() => normalizeAntigravityCliQuota(document(undefined, { command: { name: 'usage', data: { quota: null } } })), /unsupported/);
});

test('AGY preflight excludes versions where /usage could fall through as a model prompt', () => {
  for (const value of ['1.4.5:\nNotes', '## 1.1.11\nNotes', 'v1.2.0:\nNotes']) assert.equal(supportsAntigravityCliQuota(value), true);
  for (const value of ['1.1.10:', '1.0.99:', 'unknown', '0.9.0:', '2.0.0:']) assert.equal(supportsAntigravityCliQuota(value), false);
});

test('AGY uses one helper identity through preflight and returns an explicitly unidentifiable CLI snapshot', async () => {
  const calls: string[] = [];
  const report: typeof readAntigravityCliReport = async (command, options, expected) => {
    calls.push(command);
    assert.equal(options.env?.GIAN_AGENT_HOME, '/isolated/.gemini');
    if (command !== 'help') assert.deepEqual(expected, helper);
    return { helper, stdout: command === 'help' ? '  changelog  Show changelog\n'
      : command === 'changelog' ? '1.4.5:\nNotes' : document() };
  };
  const reader = new AntigravityCliQuota({ env: { GIAN_AGENT_HOME: '/isolated/.gemini' } }, report);
  try {
    const result = await reader.read(selection);
    assert.equal(result.status, 'ready');
    assert.equal(result.source, 'cli');
    assert.equal(result.authRevision, null);
    assert.equal(isProxyOfficialQuotaReadResult(result), true);
    assert.deepEqual(calls, ['help', 'changelog', 'usage']);
    await reader.read(selection);
    assert.deepEqual(calls, ['help', 'changelog', 'usage', 'usage']);
  } finally { await reader.stop(); }
});

test('AGY never sends a prompt to old helpers and redoes preflight after replacement', async () => {
  const calls: string[] = [];
  let old = true;
  let changed = false;
  const reader = new AntigravityCliQuota({ env: { GIAN_AGENT_HOME: '/isolated/.gemini' } }, async command => {
    calls.push(command);
    if (command === 'usage' && changed) { changed = false; throw new AntigravityCliModelsError('helper_changed'); }
    return { helper, stdout: command === 'help' ? '  changelog  Show changelog\n'
      : command === 'changelog' ? old ? '1.1.10:' : '1.4.5:' : document() };
  });
  try {
    assert.equal((await reader.read(selection)).status, 'unsupported');
    assert.equal(calls.includes('usage'), false);
    old = false;
    assert.equal((await reader.read(selection)).status, 'ready');
    changed = true;
    assert.equal((await reader.read(selection)).status, 'error');
    assert.equal((await reader.read(selection)).status, 'ready');
    assert.deepEqual(calls.slice(-3), ['help', 'changelog', 'usage']);
  } finally { await reader.stop(); }
});

test('AGY quota RPC is 2.3-only, strictly validated and independent of session actions', async () => {
  for (const version of ['2.2', '2.3']) {
    let reads = 0;
    let stopped = 0;
    const service = { setEventSink() {}, initialize: async () => ({ protocolVersion: 1, agentCapabilities: {} }), close: async () => {} } as unknown as AntigravityService;
    const adapter = new AntigravityProtocolV2Adapter(service, '0.0.4-Dev', () => {}, {
      quotaReader: { read: async () => { reads++; return { source: 'cli', status: 'auth_required', authRevision: null, error: null, windows: [], balances: [] }; },
        stop: async () => { stopped++; } },
    });
    const init = await adapter.handle({ jsonrpc: '2.0', id: 'init', method: 'initialize', params: {
      protocol: { name: 'gian.proxy', versions: [version] },
    } }) as { capabilities: Record<string, number> };
    assert.equal(init.capabilities['account.quota.read'], version === '2.3' ? 1 : undefined);
    assert.equal(reads, 0);
    const request = { jsonrpc: '2.0' as const, id: 'quota', method: 'account.quota.read', params: selection };
    if (version === '2.2') await assert.rejects(adapter.handle(request));
    else {
      await assert.rejects(adapter.handle({ ...request, params: { ...selection, configHome: '/arbitrary' } }));
      assert.equal(reads, 0);
      await adapter.handle(request);
      assert.equal(reads, 1);
    }
    await adapter.close();
    await adapter.close();
    assert.equal(stopped, 1);
  }
});

test('AGY shutdown cancels the in-flight inspection and prevents new helper launches', async () => {
  let calls = 0;
  const reader = new AntigravityCliQuota({ env: { GIAN_AGENT_HOME: '/isolated/.gemini' } }, async (_command, options) => {
    calls++;
    return new Promise<never>((_resolve, reject) => {
      const abort = () => reject(new AntigravityCliModelsError('cancelled'));
      if (options.signal?.aborted) abort();
      else options.signal?.addEventListener('abort', abort, { once: true });
    });
  });
  const result = reader.read(selection);
  await reader.stop();
  assert.equal((await result).status, 'error');
  assert.equal((await reader.read(selection)).status, 'error');
  assert.equal(calls, 1);
});
