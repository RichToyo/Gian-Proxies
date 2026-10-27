import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { AntigravityCliQuota } from '../src/runtime/cli-quota.js';
import { readAntigravityCliReport, type AntigravityCliModelsOptions } from '../src/runtime/cli-models.js';

const selection = { model: null, provider: null, identityNonce: 'a'.repeat(64) };
const skipWindows = { skip: process.platform === 'win32' };
type Row = { args: string[]; pid: number; cwd: string; home: string; geminiHome: string | null; agentHome: string };

async function fixture(run: (options: AntigravityCliModelsOptions, rows: () => Promise<Row[]>) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'gian-agy-quota-test-'));
  const home = join(root, 'os-user');
  const helper = join(root, 'agy');
  const report = join(root, 'report.jsonl');
  const here = dirname(fileURLToPath(import.meta.url));
  const testDir = basename(dirname(here)) === 'dist' ? join(here, '..', '..', 'test') : here;
  const source = join(testDir, 'fixtures', 'fake-antigravity-cli-quota.mjs');
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  try {
    await mkdir(join(home, '.gemini'), { recursive: true });
    await writeFile(helper, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(source)} "$@"\n`, { mode: 0o755 });
    const options = { candidates: [helper], osUserHome: home, env: { HOME: home, GIAN_AGENT_HOME: join(home, '.gemini'),
      PATH: '/usr/bin:/bin', FAKE_AGY_QUOTA_REPORT: report } };
    const rows = async () => (await readFile(report, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Row);
    await run(options, rows);
    for (const row of await rows()) {
      assert.throws(() => process.kill(row.pid, 0), `owned helper ${row.pid} must have exited`);
      await assert.rejects(access(row.cwd), 'private query cwd must have been removed');
    }
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('AGY quota executes only metadata preflight and the fixed native read-only invocation', skipWindows, async () => {
  await fixture(async (options, rows) => {
    const reader = new AntigravityCliQuota(options);
    try {
      const result = await reader.read(selection);
      assert.equal(result.status, 'ready');
      assert.equal(result.source, 'cli');
      assert.equal(result.authRevision, null);
      assert.equal(result.windows[0]?.usedRatio, 0.5);
      const calls = await rows();
      assert.deepEqual(calls.map(row => row.args), [['--help'], ['changelog'],
        ['--output-format', 'json', '--print', '/usage', '--print-timeout', '20s', '--disable-slash-commands=false']]);
      for (const row of calls) {
        assert.equal(row.home, options.env?.HOME);
        assert.equal(row.agentHome, options.env?.GIAN_AGENT_HOME);
        assert.equal(row.geminiHome, null, 'do not rewrite the CLI auth root');
        assert.notEqual(row.cwd, process.cwd());
      }
    } finally { await reader.stop(); }
  });
});

test('AGY help preflight accepts stdout, stderr and split streams without weakening data parsing', skipWindows, async () => {
  for (const helpStream of ['stdout', 'stderr', 'split']) {
    await fixture(async (options, rows) => {
      const reader = new AntigravityCliQuota({ ...options, env: { ...options.env,
        FAKE_AGY_HELP_STREAM: helpStream, FAKE_AGY_USAGE_STDERR: 'Diagnostic only, not JSON' } });
      try {
        const result = await reader.read(selection);
        assert.equal(result.status, 'ready');
        assert.equal(result.windows[0]?.usedRatio, 0.5);
        assert.equal((await rows()).length, 3);
        assert.doesNotMatch(JSON.stringify(result), /Diagnostic/);
      } finally { await reader.stop(); }
    });
  }
});

test('AGY never treats quota JSON on stderr as a successful data response', skipWindows, async () => {
  await fixture(async (options, rows) => {
    const reader = new AntigravityCliQuota({ ...options, env: { ...options.env, FAKE_AGY_QUOTA_OUTPUT: '',
      FAKE_AGY_USAGE_STDERR: JSON.stringify({ status: 'SUCCESS', command: { name: 'usage', data: { quota: null } } }) } });
    try {
      const result = await reader.read(selection);
      assert.equal(result.status, 'error');
      assert.equal(result.error, 'invalid_response');
      assert.equal((await rows()).length, 3);
    } finally { await reader.stop(); }
  });
});

test('AGY rejects oversized or failed help before invoking any quota command', skipWindows, async () => {
  for (const failure of ['overflow', 'exit']) {
    await fixture(async (options, rows) => {
      const reader = new AntigravityCliQuota({ ...options,
        ...(failure === 'overflow' ? { maxOutputBytes: 32 } : {}),
        env: { ...options.env, FAKE_AGY_HELP_FAIL: failure === 'exit' ? '1' : '0' } });
      try {
        const result = await reader.read(selection);
        assert.equal(result.status, 'error');
        assert.equal(result.error, failure === 'overflow' ? 'invalid_response' : 'unavailable');
        assert.deepEqual((await rows()).map(row => row.args), [['--help']]);
      } finally { await reader.stop(); }
    });
  }
});

test('AGY rejects old helpers and non-default HOME before any quota request', skipWindows, async () => {
  await fixture(async (options, rows) => {
    const wrongHome = new AntigravityCliQuota({ ...options, env: { ...options.env, GIAN_AGENT_HOME: '/different/.gemini' } });
    try { assert.equal((await wrongHome.read(selection)).status, 'unsupported'); }
    finally { await wrongHome.stop(); }
    assert.deepEqual(await rows(), []);
    const old = new AntigravityCliQuota({ ...options, env: { ...options.env, FAKE_AGY_VERSION: '1.1.10' } });
    try { assert.equal((await old.read(selection)).status, 'unsupported'); }
    finally { await old.stop(); }
    assert.deepEqual((await rows()).map(row => row.args), [['--help'], ['changelog']]);
  });
});

test('AGY rejects a replaced helper before invoking it', skipWindows, async () => {
  await fixture(async (options, rows) => {
    const help = await readAntigravityCliReport('help', options);
    await assert.rejects(readAntigravityCliReport('usage', options, { ...help.helper, mtimeMs: help.helper.mtimeMs + 1 }),
      (error: unknown) => error instanceof Error && error.message.includes('changed'));
    assert.equal((await rows()).length, 1);
  });
});

test('AGY sign-in waits, timeouts and oversized output are stopped and sanitized', skipWindows, async () => {
  for (const mode of ['auth', 'hang', 'overflow']) {
    await fixture(async (options, rows) => {
      const reader = new AntigravityCliQuota({ ...options, timeoutMs: mode === 'hang' ? 500 : 3_000,
        env: { ...options.env, FAKE_AGY_MODE: mode } });
      try {
        const result = await reader.read(selection);
        assert.equal(result.status, mode === 'auth' ? 'auth_required' : 'error');
        assert.equal(result.error, mode === 'auth' ? null : mode === 'hang' ? 'timeout' : 'invalid_response');
        assert.deepEqual(result.windows, []);
        assert.doesNotMatch(JSON.stringify(result), /private-token|invalid.test|os-user/);
        assert.equal((await rows()).length, 3);
      } finally { await reader.stop(); }
    });
  }
});
