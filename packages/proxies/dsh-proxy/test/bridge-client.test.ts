import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { BridgeClient, StderrTail } from '../src/runtime/bridge-client.js';

const FIXTURE = resolve('test/fixtures/fake-boot-bridge.mjs');

function client(env: Record<string, string>, options: { startTimeoutMs?: number; requestTimeoutMs?: number } = {}) {
  return new BridgeClient({
    command: process.execPath,
    args: [FIXTURE],
    env,
    stderr: () => undefined,
    ...options,
  });
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitGone(pid: number, ms = 3000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!alive(pid)) return true;
    await new Promise(r => setTimeout(r, 25));
  }
  return !alive(pid);
}

test('start resolves only with the Bridge handshake', async () => {
  const bridge = client({ FAKE_BOOT_MODE: 'ok' });
  const init = await bridge.start();
  assert.deepEqual((init as { protocol: unknown }).protocol, { name: 'gian.dsh.bridge', version: '1.0' });
  assert.equal(await bridge.ready(), init, 'ready() shares the handshake');
  await bridge.stop();
});

test('a DSH that never answers fails start within the start timeout, with its stderr', async () => {
  const bridge = client({ FAKE_BOOT_MODE: 'silent' }, { startTimeoutMs: 300 });
  await assert.rejects(bridge.start(), (error: Error) => {
    assert.match(error.message, /did not answer the Bridge handshake within 300 ms/);
    assert.match(error.message, /booting fake DSH/);
    return true;
  });
});

test('a DSH that dies while booting fails start with its exit status and stderr tail', async () => {
  const bridge = client({ FAKE_BOOT_MODE: 'crash' });
  await assert.rejects(bridge.start(), (error: Error) => {
    assert.match(error.message, /DSH exited \(code=3, signal=null\)/);
    assert.match(error.message, /failed to mount: boom/);
    return true;
  });
  assert.equal(bridge.exitInfo?.code, 3);
  await assert.rejects(bridge.request('catalog.list'), /DSH is not running \(exited code=3.*boom/s);
});

test('requests carry a deadline fenced before the client timeout', async () => {
  const bridge = client({ FAKE_BOOT_MODE: 'ok' });
  await bridge.start();
  const before = Date.now();
  const result = await bridge.request('catalog.list', {}, 10_000) as { echo: { deadlineAt: number } };
  assert.ok(result.echo.deadlineAt >= before + 8_000 - 50 && result.echo.deadlineAt <= Date.now() + 8_000);
  await bridge.stop();
});

test('stop reaps the whole DSH process group, even a DSH that ignores SIGTERM', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gian-dsh-group-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pidFile = join(root, 'pids.json');
  const bridge = client({ FAKE_BOOT_MODE: 'ok', FAKE_BOOT_PID_FILE: pidFile, FAKE_BOOT_IGNORE_TERM: '1' });
  await bridge.start();
  const pids = JSON.parse(await readFile(pidFile, 'utf8')) as { child: number; grandchild: number };
  assert.ok(alive(pids.grandchild));
  await bridge.stop(200);
  assert.equal(await waitGone(pids.child), true, 'DSH launcher stopped');
  assert.equal(await waitGone(pids.grandchild), true, 'DSH descendant stopped');
});

test('the stderr tail keeps whole recent lines within its bound', () => {
  const tail = new StderrTail(32);
  tail.push('first line that is long enough\n');
  tail.push('second\nthird\n');
  assert.equal(tail.toString(), 'second\nthird');
});
