/**
 * Kimi Code servers a dead Proxy left behind.
 *
 * The Proxy runs `kimi web` as its child. When the Proxy is killed outright
 * (SIGKILL, a crash, a Host force-stop), that server keeps running under
 * launchd and keeps the lock of every session it opened, so a new Proxy's
 * server is refused with 40931 ("This session is in use by another Kimi Code
 * Web instance") and the conversation cannot continue.
 *
 * A lock holder is reclaimed only when it is clearly such a leftover: a
 * "Kimi Code Web" lock on this host whose process is a `kimi-code` server that
 * was re-parented to launchd (its parent is gone). A user's terminal Kimi or a
 * server still owned by a live parent is never touched.
 */

import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const LOCK_DIR = ['locks', 'sessions'];
const WEB_CLIENT = 'Kimi Code Web';
const SERVER_COMMAND = 'kimi-code';
const STOP_GRACE_MS = 3_000;

interface LockHolder { pid: number; lockFile: string }

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function parentAndCommand(pid: number): Promise<{ ppid: number; command: string } | null> {
  try {
    const { stdout } = await execFileAsync('/bin/ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { timeout: 5_000 });
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(stdout.trim());
    return match ? { ppid: Number(match[1]), command: basename(match[2]!) } : null;
  } catch {
    return null;
  }
}

async function webLockHolders(kimiHome: string, nativeSessionIds?: readonly string[]): Promise<LockHolder[]> {
  const directory = join(kimiHome, ...LOCK_DIR);
  let names: string[];
  try { names = await readdir(directory); } catch { return []; }
  const wanted = nativeSessionIds ? new Set(nativeSessionIds.map(id => `${id}.lock`)) : null;
  const holders: LockHolder[] = [];
  for (const name of names) {
    if (!name.endsWith('.lock') || (wanted && !wanted.has(name))) continue;
    try {
      const lock = JSON.parse(await readFile(join(directory, name), 'utf8')) as Record<string, unknown>;
      if (lock.clientDisplayName !== WEB_CLIENT || lock.hostname !== hostname()) continue;
      if (!Number.isSafeInteger(lock.pid) || (lock.pid as number) <= 1) continue;
      holders.push({ pid: lock.pid as number, lockFile: name });
    } catch { /* unreadable or partially written lock: leave it to Kimi */ }
  }
  return holders;
}

/** Stop leftover Kimi Code Web servers that hold session locks in this Kimi
 *  home. `nativeSessionIds` limits the scan to those sessions; `keep` lists
 *  server pids that belong to this Proxy. Returns the pids stopped. */
export async function reclaimOrphanedKimiServers(
  kimiHome: string,
  options: { nativeSessionIds?: readonly string[]; keep?: readonly number[]; debug?: (message: string) => void } = {},
): Promise<number[]> {
  if (process.platform === 'win32') return [];
  const keep = new Set(options.keep ?? []);
  const pids = [...new Set((await webLockHolders(kimiHome, options.nativeSessionIds)).map(holder => holder.pid))]
    .filter(pid => !keep.has(pid) && pid !== process.pid && alive(pid));
  const stopped: number[] = [];
  for (const pid of pids) {
    const info = await parentAndCommand(pid);
    if (!info || info.ppid !== 1 || info.command !== SERVER_COMMAND) continue;
    options.debug?.(`[kimi] Stopping leftover Kimi Code Web server ${pid} that still holds a session lock.`);
    try { process.kill(pid, 'SIGTERM'); } catch { continue; }
    const deadline = Date.now() + STOP_GRACE_MS;
    while (alive(pid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
    stopped.push(pid);
  }
  return stopped;
}

/** Shell watchdog that stops the Kimi server once its Proxy is gone, and
 *  exits by itself when the server stops first. `$1` is the Proxy pid, `$2`
 *  the server pid. */
export const KIMI_SERVER_WATCHDOG = [
  'p="$1"; k="$2"',
  'while kill -0 "$k" 2>/dev/null; do',
  '  if ! kill -0 "$p" 2>/dev/null; then',
  '    kill -TERM "$k" 2>/dev/null; sleep 3; kill -KILL "$k" 2>/dev/null; exit 0',
  '  fi',
  '  sleep 1',
  'done',
].join('\n');
