#!/usr/bin/env node
// Minimal Bridge stand-in for BridgeClient lifecycle tests.
// FAKE_BOOT_MODE: ok | silent | crash. In `ok` mode it spawns a grandchild in
// its process group and records its pid in FAKE_BOOT_PID_FILE.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const mode = process.env.FAKE_BOOT_MODE ?? 'ok';
process.stderr.write('booting fake DSH\n');
if (mode === 'crash') {
  process.stderr.write('Error: profile gian-test failed to mount: boom\n');
  process.exit(3);
}
if (mode === 'ok' && process.env.FAKE_BOOT_PID_FILE) {
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  writeFileSync(process.env.FAKE_BOOT_PID_FILE, JSON.stringify({ child: process.pid, grandchild: grandchild.pid }));
}
// Ignore SIGTERM so only the group SIGKILL can end a stuck DSH.
if (process.env.FAKE_BOOT_IGNORE_TERM === '1') process.on('SIGTERM', () => undefined);
for await (const line of createInterface({ input: process.stdin })) {
  if (mode === 'silent') continue;
  const request = JSON.parse(line);
  const result = request.method === 'initialize'
    ? { protocol: { name: 'gian.dsh.bridge', version: '1.0' }, capabilities: {} }
    : { echo: { method: request.method, deadlineAt: request.deadlineAt ?? null } };
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
}
