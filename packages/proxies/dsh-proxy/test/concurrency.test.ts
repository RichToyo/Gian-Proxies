import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';

import { BARRIER_METHODS, OVERTAKE_METHODS, PIPELINED_METHODS, dshLaneKey } from '../src/cli/lanes.js';
import { DshV2Adapter } from '../src/protocol/v2-adapter.js';

test('lanes serialize per session and let interrupts, answers and process reads through', () => {
  const lane = (method: string, params: Record<string, unknown>) => dshLaneKey({ id: '1', method, params });
  assert.equal(lane('turn.start', { sessionId: 'a' }), 'a');
  assert.equal(lane('session.fork', { sourceSessionId: 'a', sessionId: 'child' }), 'a');
  assert.equal(lane('sidechat.create', { parentSessionId: 'a', sidechatId: 'side' }), 'a');
  assert.equal(lane('sidechat.close', { sidechatId: 'side' }), 'side');
  assert.equal(lane('catalog.list', {}), '');
  for (const method of ['interaction.respond', 'turn.interrupt', 'shutdown']) assert.ok(OVERTAKE_METHODS.has(method));
  for (const method of ['account.quota.read', 'customization.list', 'session.native.list']) assert.ok(PIPELINED_METHODS.has(method));
  assert.deepEqual([...BARRIER_METHODS], ['initialize']);
});

test('a session waiting on DSH holds only its own notifications; other sessions answer and stream', async (t) => {
  let releaseA: () => void = () => undefined;
  const blockA = new Promise<void>(resolveBlock => { releaseA = resolveBlock; });
  const listeners = new Set<(n: { method: string; params: Record<string, unknown> }) => void>();
  const catalog = {
    catalogRevision: 'r',
    providers: [{ id: 'deepseek' }],
    models: [{ id: 'deepseek-flash', provider: 'deepseek' }],
  };
  const fake = {
    onNotification(listener: (n: { method: string; params: Record<string, unknown> }) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async request(method: string, params: Record<string, unknown>) {
      switch (method) {
        case 'initialize': return { protocol: { name: 'gian.dsh.bridge', version: '1.0' }, capabilities: {} };
        case 'catalog.list':
        case 'catalog.resolve': return catalog;
        case 'session.create': return { session: { nativeId: `native-${String(params.sessionId)}` } };
        case 'turn.start':
          if (params.sessionId === 'a') await blockA;
          return { accepted: true };
        case 'turn.interrupt': return { accepted: true };
        default: throw new Error(`unexpected ${method}`);
      }
    },
  };
  const adapter = new DshV2Adapter(fake as never, { pluginVersion: '0.0.0' });
  const written: string[] = [];
  adapter.setEmitSink((method, params) => written.push(`${method}:${String(params.sessionId ?? '')}`));
  const respond = (label: string) => (_result: unknown, error?: unknown) => {
    written.push(`${label}:${error === undefined ? 'ok' : 'error'}`);
  };
  await adapter.dispatch({ id: 'i', method: 'initialize', params: { protocol: { name: 'gian.proxy', versions: ['2.1'] } } }, respond('initialize'));
  const streams: Record<string, string> = {};
  for (const sessionId of ['a', 'b']) {
    const created = await adapter.dispatch({ id: `c-${sessionId}`, method: 'session.create', params: {
      sessionId, workspace: { cwd: '/tmp', roots: [] }, config: {},
    } });
    streams[sessionId] = ((created.result as { session: { streamId: string } }).session.streamId);
  }
  const turnParams = (sessionId: string) => ({
    sessionId, streamId: streams[sessionId], turnId: `t-${sessionId}`,
    input: [{ type: 'text', text: 'hi' }], config: { model: 'deepseek-flash' },
  });

  t.after(() => releaseA());
  const turnA = adapter.dispatch({ id: 'start-a', method: 'turn.start', params: turnParams('a') }, respond('start-a'));
  await new Promise(resolveTick => setImmediate(resolveTick));
  await adapter.dispatch({ id: 'start-b', method: 'turn.start', params: turnParams('b') }, respond('start-b'));
  await adapter.dispatch({ id: 'int-b', method: 'turn.interrupt', params: {
    sessionId: 'b', streamId: streams.b, turnId: 't-b',
  } }, respond('int-b'));
  assert.deepEqual(written.slice(1), ['start-b:ok', 'session.updated:b', 'int-b:ok'],
    'session b answered and streamed while session a waits; a holds its own notification');
  releaseA();
  await turnA;
  assert.deepEqual(written.slice(-2), ['start-a:ok', 'session.updated:a'], 'a notifies only after its Response');
});

test('SIGTERM stops the whole DSH process group before the Proxy exits', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gian-dsh-sigterm-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pidFile = join(root, 'pids.json');
  const proxy = spawn(process.execPath, [
    resolve('dist/src/cli/spawn.js'),
    `--bridge=${process.execPath}`,
    resolve('test/fixtures/fake-boot-bridge.mjs'),
  ], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, FAKE_BOOT_MODE: 'ok', FAKE_BOOT_PID_FILE: pidFile, FAKE_BOOT_IGNORE_TERM: '1' },
  });
  t.after(() => { if (proxy.exitCode === null) proxy.kill('SIGKILL'); });
  let stderr = '';
  proxy.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  const lines = createInterface({ input: proxy.stdout })[Symbol.asyncIterator]();
  proxy.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0', id: 'init', method: 'initialize',
    params: { protocol: { name: 'gian.proxy', versions: ['2.1'] }, host: { name: 'test', version: '0' } },
  })}\n`);
  const first = JSON.parse((await lines.next()).value as string) as { id?: string; result?: unknown };
  assert.equal(first.id, 'init');
  assert.ok(first.result, `${JSON.stringify(first)} ${stderr}`);
  const pids = JSON.parse(await readFile(pidFile, 'utf8')) as { child: number; grandchild: number };
  const exited = new Promise<number | null>(resolveExit => proxy.once('exit', code => resolveExit(code)));
  proxy.kill('SIGTERM');
  assert.equal(await exited, 0);
  const gone = (pid: number) => { try { process.kill(pid, 0); return false; } catch { return true; } };
  for (let i = 0; i < 40 && !(gone(pids.child) && gone(pids.grandchild)); i += 1) {
    await new Promise(r => setTimeout(r, 25));
  }
  assert.equal(gone(pids.child), true, 'DSH stopped');
  assert.equal(gone(pids.grandchild), true, 'DSH descendant stopped');
});

test('catalog.changed is held back until initialize and carries the new revision', async () => {
  const listeners = new Set<(n: { method: string; params: Record<string, unknown> }) => void>();
  const fake = {
    onNotification(listener: (n: { method: string; params: Record<string, unknown> }) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async request(method: string) {
      if (method === 'initialize') return { protocol: { name: 'gian.dsh.bridge', version: '1.0' }, capabilities: {} };
      if (method === 'catalog.list') return { catalogRevision: 'cordis-x-1', providers: [{ id: 'p' }], models: [{ id: 'm', provider: 'p' }] };
      throw new Error(`unexpected ${method}`);
    },
  };
  const adapter = new DshV2Adapter(fake as never, { pluginVersion: '0.0.0' });
  const written: Array<{ method: string; params: Record<string, unknown> }> = [];
  adapter.setEmitSink((method, params) => written.push({ method, params }));
  const push = (params: Record<string, unknown>) => { for (const listener of listeners) listener({ method: 'catalog.changed', params }); };
  push({ catalogRevision: 'cordis-x-0' });
  assert.equal(written.length, 0, 'boot churn before initialize is not written');
  await adapter.dispatch({ id: 'i', method: 'initialize', params: { protocol: { name: 'gian.proxy', versions: ['2.1'] } } });
  push({ catalogRevision: 'cordis-x-2' });
  push({});
  assert.deepEqual(written.map(event => event.method), ['catalog.changed', 'catalog.changed']);
  assert.match(String((written[0]?.params.data as { revision?: string }).revision), /^dsh-catalog-/);
  assert.deepEqual(written[1]?.params.data, { reason: 'catalog-changed' });
});
