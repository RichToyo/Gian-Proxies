import { strict as assert } from 'node:assert';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { KIMI_SERVER_WATCHDOG, reclaimOrphanedKimiServers } from '../src/runtime/orphan-servers.js';

// A leftover Kimi server is a `kimi-code` process re-parented to launchd that
// still holds a "Kimi Code Web" session lock. These tests build exactly that
// shape with /bin/sleep started as argv[0] `kimi-code` (the real server sets
// its process title the same way; a renamed copy of a system binary would be
// refused by code signing).

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitFor = async (predicate: () => boolean, ms = 5_000) => {
  const deadline = Date.now() + ms;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  return predicate();
};

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'kimi-orphans-'));
  const home = join(root, 'home');
  mkdirSync(join(home, 'locks', 'sessions'), { recursive: true });
  return { root, home };
}

/** A `kimi-code` process whose parent exits at once: launchd adopts it. */
function orphan(): number {
  const pid = Number(execFileSync('/bin/bash', ['-c', '(exec -a kimi-code /bin/sleep 60) >/dev/null 2>&1 & echo $!']).toString().trim());
  assert.ok(pid > 1);
  return pid;
}

/** A `kimi-code` process that is this test's own child. */
function owned() {
  return spawn('/bin/bash', ['-c', 'exec -a kimi-code /bin/sleep 60'], { stdio: 'ignore' });
}

function lock(home: string, session: string, pid: number, client = 'Kimi Code Web', host = hostname()) {
  writeFileSync(join(home, 'locks', 'sessions', `${session}.lock`), JSON.stringify({
    version: 1, token: `${pid}:fixture`, pid, hostname: host, startedAt: Date.now(),
    clientIdentity: 'kimi_code_cli', clientDisplayName: client,
  }));
}

test('a leftover Kimi Code Web server holding a session lock is stopped', { skip: process.platform === 'win32' }, async () => {
  const { root, home } = fixture();
  const pid = orphan();
  try {
    await waitFor(() => execFileSync('/bin/ps', ['-o', 'ppid=', '-p', String(pid)]).toString().trim() === '1');
    lock(home, 'session_a', pid);
    const stopped = await reclaimOrphanedKimiServers(home);
    assert.deepEqual(stopped, [pid]);
    assert.equal(await waitFor(() => !alive(pid)), true);
  } finally {
    try { process.kill(pid, 'SIGKILL'); } catch { /* stopped */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test('a scan limited to one session, a kept pid, another client or host, or a live parent stop nothing', { skip: process.platform === 'win32' }, async () => {
  const { root, home } = fixture();
  const leftover = orphan();
  const child = owned();
  try {
    await waitFor(() => execFileSync('/bin/ps', ['-o', 'ppid=', '-p', String(leftover)]).toString().trim() === '1');
    lock(home, 'session_b', leftover);
    lock(home, 'session_cli', leftover, 'Kimi Code CLI');
    lock(home, 'session_other_host', leftover, 'Kimi Code Web', 'another-mac.local');
    await waitFor(() => execFileSync('/bin/ps', ['-o', 'comm=', '-p', String(child.pid)]).toString().trim() === 'kimi-code');
    lock(home, 'session_owned', child.pid!);
    assert.deepEqual(await reclaimOrphanedKimiServers(home, { nativeSessionIds: ['session_cli', 'session_other_host', 'session_owned'] }), []);
    assert.deepEqual(await reclaimOrphanedKimiServers(home, { nativeSessionIds: ['session_b'], keep: [leftover] }), []);
    assert.equal(alive(leftover), true);
    assert.deepEqual(await reclaimOrphanedKimiServers(home, { nativeSessionIds: ['session_owned'] }), []);
    assert.equal(alive(child.pid!), true, 'a server whose parent is alive is never touched');
  } finally {
    try { process.kill(leftover, 'SIGKILL'); } catch { /* gone */ }
    child.kill('SIGKILL');
    rmSync(root, { recursive: true, force: true });
  }
});

test('the watchdog stops the server when its Proxy disappears and exits on its own otherwise', { skip: process.platform === 'win32' }, async () => {
  const { root } = fixture();
  const proxy = spawn('/bin/sleep', ['60'], { stdio: 'ignore' });
  const server = spawn('/bin/sleep', ['60'], { stdio: 'ignore', detached: true });
  const watchdog = spawn('/bin/sh', ['-c', KIMI_SERVER_WATCHDOG, 'gian-kimi-watchdog', String(proxy.pid), String(server.pid)], { stdio: 'ignore' });
  try {
    await new Promise(resolve => setTimeout(resolve, 1_500));
    assert.equal(alive(server.pid!), true, 'the server keeps running while its Proxy lives');
    proxy.kill('SIGKILL');
    assert.equal(await waitFor(() => !alive(server.pid!), 8_000), true, 'the server stops after its Proxy is gone');
    assert.equal(await waitFor(() => watchdog.exitCode !== null || watchdog.signalCode !== null, 8_000), true);

    const proxy2 = spawn('/bin/sleep', ['60'], { stdio: 'ignore' });
    const server2 = spawn('/bin/sleep', ['1'], { stdio: 'ignore' });
    const watchdog2 = spawn('/bin/sh', ['-c', KIMI_SERVER_WATCHDOG, 'gian-kimi-watchdog', String(proxy2.pid), String(server2.pid)], { stdio: 'ignore' });
    assert.equal(await waitFor(() => watchdog2.exitCode !== null, 8_000), true, 'the watchdog exits when the server stops first');
    assert.equal(alive(proxy2.pid!), true);
    proxy2.kill('SIGKILL');
  } finally {
    for (const child of [proxy, server, watchdog]) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
    rmSync(root, { recursive: true, force: true });
  }
});
