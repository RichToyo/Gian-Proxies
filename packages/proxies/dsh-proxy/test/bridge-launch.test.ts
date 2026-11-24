import assert from 'node:assert/strict';
import test from 'node:test';

import { bridgeEnvironment, parseArgs } from '../src/cli/bridge-launch.js';
import { dshHome, gianProfileName, launchPatchPath } from '../src/runtime/profile.js';

const ENV_KEYS = [
  'GIAN_DSH_HOST_ARGS',
  'GIAN_DSH_HOST_ENTRY',
  'GIAN_RUNTIME_BIN',
  'DSH_HOST_ENTRY',
] as const;

function withEnv(
  env: Partial<Record<(typeof ENV_KEYS)[number], string>>,
  run: () => void,
): void {
  const saved = ENV_KEYS.map((key) => [key, process.env[key]] as const);
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, env);
  try {
    run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('a .js bridge command is spawned via process.execPath with --expose-internals', () => {
  withEnv({ GIAN_RUNTIME_BIN: '/opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js' }, () => {
    const launch = parseArgs([]);
    assert.equal(launch.bridgeCommand, process.execPath);
    assert.deepEqual(launch.args.slice(0, 2), [
      '--expose-internals',
      '/opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js',
    ]);
  });
});

test('a non-.js bridge command keeps the direct spawn behavior', () => {
  withEnv({ GIAN_DSH_HOST_ENTRY: '/usr/local/bin/dsh-host' }, () => {
    const launch = parseArgs([]);
    assert.equal(launch.bridgeCommand, '/usr/local/bin/dsh-host');
    assert.deepEqual(launch.args, ['--profile', gianProfileName()]);
  });
});

test('a .js bridge command injects the same binding-scoped profile and launch overlay as the installer', () => {
  withEnv({ GIAN_RUNTIME_BIN: '/opt/dsh/lib/bin.js' }, () => {
    const launch = parseArgs([]);
    assert.equal(launch.managedProfile, true);
    assert.deepEqual(launch.args.slice(2), ['--profile', gianProfileName(), '--patch', launchPatchPath()]);
    assert.ok(launchPatchPath().endsWith(`/profiles/${gianProfileName()}/gian-launch.patch.yml`));
  });
});

test('every DSH launch disables telemetry and receives the resolved DSH home', () => {
  assert.deepEqual(bridgeEnvironment({ DSH_TELEMETRY_DISABLED: '' }), {
    DSH_TELEMETRY_DISABLED: '1',
    DSH_HOME: dshHome({}),
  });
  assert.equal(bridgeEnvironment({ DSH_HOME: '/tmp/inherited' }).DSH_HOME, '/tmp/inherited');
  // The Host's Agent Home wins over an inherited provider variable.
  assert.equal(bridgeEnvironment({
    GIAN_AGENT_HOME: '/tmp/agent-home',
    DSH_HOME: '/tmp/inherited',
  }).DSH_HOME, '/tmp/agent-home');
  assert.equal(bridgeEnvironment({ GIAN_AGENT_HOME: 'relative', DSH_HOME: '/tmp/inherited' }).DSH_HOME, '/tmp/inherited');
});

test('an explicit --bridge= .js override is wrapped and skips --profile injection', () => {
  withEnv({}, () => {
    const launch = parseArgs(['--bridge=/tmp/fake-bridge.js', '--verbose', 'extra']);
    assert.equal(launch.bridgeCommand, process.execPath);
    assert.deepEqual(launch.args, ['--expose-internals', '/tmp/fake-bridge.js', 'extra']);
  });
});

test('GIAN_DSH_HOST_ENTRY wins over --bridge= and keeps direct spawn for binaries', () => {
  withEnv({ GIAN_DSH_HOST_ENTRY: '/usr/local/bin/dsh-host' }, () => {
    const launch = parseArgs(['--bridge=/tmp/fake-bridge.js', 'extra']);
    assert.equal(launch.bridgeCommand, '/usr/local/bin/dsh-host');
    assert.deepEqual(launch.args, ['extra']);
  });
});

test('GIAN_DSH_HOST_ARGS replaces the derived args but keeps the Node wrapper', () => {
  withEnv({
    GIAN_RUNTIME_BIN: '/opt/dsh/lib/bin.js',
    GIAN_DSH_HOST_ARGS: JSON.stringify(['--profile', 'custom', '--flag']),
  }, () => {
    const launch = parseArgs(['positional']);
    assert.equal(launch.bridgeCommand, process.execPath);
    assert.deepEqual(launch.args, [
      '--expose-internals',
      '/opt/dsh/lib/bin.js',
      '--profile',
      'custom',
      '--flag',
    ]);
  });
});

test('GIAN_DSH_HOST_ARGS rejects non-string-array JSON', () => {
  withEnv({
    GIAN_DSH_HOST_ENTRY: '/usr/local/bin/dsh-host',
    GIAN_DSH_HOST_ARGS: JSON.stringify({ profile: 'gian' }),
  }, () => {
    assert.throws(() => parseArgs([]), /GIAN_DSH_HOST_ARGS must be a JSON array of strings\./);
  });
});

test('parseArgs throws when no bridge command is configured', () => {
  withEnv({}, () => {
    assert.throws(() => parseArgs([]), /requires GIAN_DSH_HOST_ENTRY/);
  });
});
