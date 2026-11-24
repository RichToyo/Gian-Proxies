import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';

test('the Proxy launches DSH with telemetry disabled and the Host Agent Home as DSH_HOME', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gian-dsh-launch-env-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const envFile = join(root, 'env.json');
  const agentHome = join(root, 'agent-home');
  const child = spawn(process.execPath, [
    resolve('dist/src/cli/spawn.js'),
    `--bridge=${process.execPath}`,
    resolve('test/fixtures/fake-dsh-bridge.mjs'),
  ], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      DSH_FAKE_ENV_FILE: envFile,
      GIAN_AGENT_HOME: agentHome,
      DSH_HOME: join(root, 'inherited-dsh-home'),
      DSH_TELEMETRY_DISABLED: '',
    },
  });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 'init',
    method: 'initialize',
    params: { protocol: { name: 'gian.proxy', versions: ['2.1'] }, host: { name: 'test', version: '0' } },
  })}\n`);
  for (;;) {
    const next = await lines.next();
    assert.equal(next.done, false);
    if ((JSON.parse(next.value) as { id?: string }).id === 'init') break;
  }
  const recorded = JSON.parse(await readFile(envFile, 'utf8')) as Record<string, unknown>;
  assert.equal(recorded.DSH_TELEMETRY_DISABLED, '1');
  assert.equal(recorded.DSH_HOME, agentHome);
  child.stdin.end();
  await new Promise(resolveExit => child.once('exit', resolveExit));
});
