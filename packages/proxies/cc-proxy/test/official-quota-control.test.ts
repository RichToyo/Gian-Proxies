import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readClaudeOfficialQuota, withClaudeQuotaControl } from '../src/runtime/official-quota-control.js';

async function fixture(run: (executable: string, root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'claude-quota-fixture-'));
  const executable = join(root, 'claude-fixture');
  try {
    await writeFile(executable, `#!${process.execPath}
import readline from 'node:readline';
const requests = [];
readline.createInterface({ input: process.stdin }).on('line', line => {
  const frame = JSON.parse(line);
  requests.push(frame);
  if (process.env.FIXTURE_MODE === 'timeout') return;
  if (process.env.FIXTURE_MODE === 'unexpected') {
    process.stdout.write(JSON.stringify({ type: 'control_request', request: { subtype: 'can_use_tool' } }) + '\\n');
    return;
  }
  const body = process.env.FIXTURE_MODE === 'unsupported'
    ? { subtype: 'error', error: 'get_usage is not supported in this context' }
    : { subtype: 'success', response: { requests, args: process.argv.slice(2), pid: process.pid, cwd: process.cwd() } };
  process.stdout.write(JSON.stringify({ type: 'control_response', response: { request_id: frame.request_id, ...body } }) + '\\n');
});
`, { mode: 0o700 });
    await run(executable, root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('Claude metadata child receives no prompt and is closed before returning', { skip: process.platform === 'win32' }, async () => {
  await fixture(async (executable, root) => {
    const result = await withClaudeQuotaControl(executable, { ...process.env, HOME: root }, async request => {
      await request({ subtype: 'initialize', hooks: {} });
      return await request({ subtype: 'get_usage', skip_behaviors: true }) as {
        requests: Array<{ type: string; request: unknown }>; args: string[]; pid: number; cwd: string;
      };
    });
    assert.deepEqual(result.requests.map(item => item.type), ['control_request', 'control_request']);
    assert.deepEqual(result.requests[1]?.request, { subtype: 'get_usage', skip_behaviors: true });
    for (const arg of ['--no-session-persistence', '--strict-mcp-config', '{"disableAllHooks":true}']) assert.ok(result.args.includes(arg));
    assert.ok(!result.args.includes('/usage'));
    assert.notEqual(result.cwd, root);
    assert.throws(() => process.kill(result.pid, 0));
  });
});

test('Claude native inspection is bounded and refuses reverse controls without responding', { skip: process.platform === 'win32' }, async () => {
  await fixture(async (executable, root) => {
    for (const [mode, error] of [['timeout', 'timeout'], ['unexpected', 'invalid_response'], ['unsupported', 'unsupported']]) {
      await assert.rejects(withClaudeQuotaControl(executable,
        { ...process.env, HOME: root, FIXTURE_MODE: mode }, request => request({ subtype: 'initialize', hooks: {} }),
        mode === 'timeout' ? 100 : 2_000), new RegExp(error!));
    }
  });
});

test('Claude quota refuses an unbound profile without invoking the executable', async () => {
  const result = await readClaudeOfficialQuota({ model: null, provider: null, identityNonce: 'a'.repeat(64) },
    { GIAN_RUNTIME_BIN: '/must-not-launch', GIAN_AGENT_HOME: '/isolated/a', CLAUDE_CONFIG_DIR: '/isolated/b' });
  assert.equal(result.status, 'unsupported');
});
