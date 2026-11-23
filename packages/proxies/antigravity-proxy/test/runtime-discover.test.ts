import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { execPath } from 'node:process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { AntigravityRuntimeError } from '../src/runtime/errors.js';
import {
  candidateSource,
  discoverAntigravityRuntimes,
  probeAntigravityRuntime,
} from '../src/runtime/discover.js';
import {
  ANTIGRAVITY_AGENT_NAME,
  ANTIGRAVITY_CLI_AGENT_NAME,
  ANTIGRAVITY_CLI_MIN_VERSION,
  ANTIGRAVITY_RUNTIME_DISPLAY_NAME,
  ANTIGRAVITY_RUNTIME_ID,
  cliBasenames,
  harnessBasenames,
  isAntigravityCliBinary,
  resolvePairedHarness,
  serverBasenames,
} from '../src/runtime/layout.js';

const posixOnly = process.platform === 'win32';

/** Compiled tests live in dist/test. The .mjs fixture stays in the source tree. */
function sourceFixturePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const parent = dirname(here);
  const testDir = basename(here) === 'test' && basename(parent) === 'dist'
    ? join(parent, '..', 'test')
    : here;
  return join(testDir, 'fixtures', 'fake-antigravity-acp.mjs');
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function writeServerWrapper(server: string): Promise<void> {
  const fixture = sourceFixturePath();
  await mkdir(dirname(server), { recursive: true });
  await writeFile(server, `#!/bin/sh\nexec ${shellQuote(execPath)} ${shellQuote(fixture)} "$@"\n`, { mode: 0o755 });
  await chmod(server, 0o755);
}

function requiredName(names: readonly string[]): string {
  const name = names[0];
  if (name === undefined) throw new Error('missing runtime basename');
  return name;
}

const serverName = requiredName(serverBasenames());
const harnessName = requiredName(harnessBasenames());
const cliName = requiredName(cliBasenames());

async function executable(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
  await chmod(path, 0o755);
}

async function pair(directory: string): Promise<{ server: string; harness: string }> {
  const server = join(directory, serverName);
  const harness = join(directory, harnessName);
  await executable(server, '#!/bin/sh\nexit 0\n');
  await executable(harness, '#!/bin/sh\nexit 0\n');
  return { server, harness };
}

test('classifies official directories without scanning them unconditionally', () => {
  assert.equal(candidateSource('/Users/owner/.local/bin', '/Users/owner'), 'official-user');
  assert.equal(candidateSource('/opt/homebrew/bin', '/Users/owner'), 'official-system');
  assert.equal(candidateSource('/usr/local/bin', '/Users/owner'), 'official-system');
  assert.equal(candidateSource('/opt/custom/bin', '/Users/owner'), 'path');
});

test('only the agy basename selects the CLI runtime', () => {
  assert.equal(isAntigravityCliBinary('/Users/owner/.local/bin/agy', 'darwin'), true);
  assert.equal(isAntigravityCliBinary('/usr/local/bin/agy', 'linux'), true);
  assert.equal(isAntigravityCliBinary('/opt/runtime/agy_acp_server.par', 'darwin'), false);
  assert.equal(isAntigravityCliBinary('/opt/runtime/agy.exe', 'darwin'), false);
  assert.equal(isAntigravityCliBinary('/opt/runtime/agy-old', 'linux'), false);
  assert.equal(isAntigravityCliBinary('C:\\Users\\owner\\.local\\bin\\agy.exe', 'win32'), true);
  assert.equal(isAntigravityCliBinary('C:\\Tools\\AGY.EXE', 'win32'), true);
  assert.equal(isAntigravityCliBinary('C:\\runtime\\agy_acp_server.exe', 'win32'), false);
  assert.deepEqual(cliBasenames('darwin'), ['agy']);
  assert.deepEqual(cliBasenames('win32'), ['agy.exe']);
});

test('requires the harness file beside the server and does not hash it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agy-layout-'));
  try {
    const directory = join(root, 'extract');
    const server = join(directory, serverName);
    const harness = join(directory, harnessName);
    await executable(server, 'server-bytes-aaa');
    await executable(harness, 'harness-bytes-bbb');
    const resolved = await resolvePairedHarness(server);
    assert.equal(resolved, harness);
    assert.equal(await readFile(resolved, 'utf8'), 'harness-bytes-bbb');
    assert.notEqual(await readFile(server, 'utf8'), await readFile(resolved, 'utf8'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('accepts a same-directory harness symlink and ignores one that leaves it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agy-link-'));
  try {
    const inside = join(root, 'inside');
    const outside = join(root, 'outside');
    await executable(join(inside, serverName), '#!/bin/sh\nexit 0\n');
    await executable(join(inside, 'localharness'), '#!/bin/sh\nexit 0\n');
    await symlink(join(inside, 'localharness'), join(inside, harnessName));
    const resolved = await resolvePairedHarness(join(inside, serverName));
    assert.equal(resolved, await realpath(join(inside, 'localharness')));

    const escaped = join(root, 'escaped');
    await executable(join(escaped, serverName), '#!/bin/sh\nexit 0\n');
    await executable(join(outside, 'foreign'), '#!/bin/sh\nexit 0\n');
    await symlink(join(outside, 'foreign'), join(escaped, harnessName));
    await assert.rejects(
      resolvePairedHarness(join(escaped, serverName)),
      (error: unknown) => error instanceof AntigravityRuntimeError && /Required localharness file is not in/.test(error.message),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('discovers a same-directory pair and skips a server without one', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agy-discover-'));
  try {
    const home = join(root, 'home');
    const paired = join(root, 'paired');
    const bare = join(root, 'bare');
    const hidden = join(root, 'hidden');
    await pair(paired);
    await executable(join(bare, serverName), '#!/bin/sh\nexit 0\n');
    await pair(hidden);
    const result = await discoverAntigravityRuntimes({
      HOME: home,
      PATH: [paired, bare].join(delimiter),
    });
    assert.deepEqual(result.candidates, [{
      path: join(paired, serverName),
      source: 'path',
      label: ANTIGRAVITY_RUNTIME_DISPLAY_NAME,
    }]);
    assert.equal(result.setupActions[0]?.kind, 'open_url');
    assert.equal(result.setupActions[1]?.kind, 'select_file');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('offers agy CLI candidates before extracted pairs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agy-cli-discover-'));
  try {
    const home = join(root, 'home');
    const userBin = join(home, '.local', 'bin');
    const pathBin = join(root, 'path-bin');
    const paired = join(root, 'paired');
    const { server } = await pair(paired);
    await executable(join(userBin, cliName), '#!/bin/sh\nexit 0\n');
    await executable(join(pathBin, cliName), '#!/bin/sh\nexit 0\n');
    const result = await discoverAntigravityRuntimes({
      HOME: home,
      PATH: [paired, pathBin, userBin].join(delimiter),
    });
    assert.deepEqual(result.candidates, [
      { path: join(userBin, cliName), source: 'official-user', label: ANTIGRAVITY_RUNTIME_DISPLAY_NAME },
      { path: join(pathBin, cliName), source: 'path', label: ANTIGRAVITY_RUNTIME_DISPLAY_NAME },
      { path: server, source: 'path', label: ANTIGRAVITY_RUNTIME_DISPLAY_NAME },
    ]);
    const [docs, picker] = result.setupActions;
    assert.equal(docs?.kind === 'open_url' ? docs.url : null, 'https://antigravity.google/docs/ide/extensions/acp/');
    assert.equal(picker?.kind, 'select_file');
    assert.match(picker?.label ?? '', /agy CLI/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('labels a pair under ~/.local/bin as official-user and dedupes PATH', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agy-user-'));
  try {
    const home = join(root, 'home');
    const bin = join(home, '.local', 'bin');
    await pair(bin);
    const result = await discoverAntigravityRuntimes({
      HOME: home,
      PATH: ['', bin, bin].join(delimiter),
    });
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0]?.source, 'official-user');
    assert.equal(result.candidates[0]?.path, join(bin, serverName));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('returns at most 32 candidates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agy-cap-'));
  try {
    const home = join(root, 'home');
    const dirs: string[] = [];
    for (let index = 0; index < 33; index += 1) {
      const directory = join(root, 'bin', String(index));
      await pair(directory);
      dirs.push(directory);
    }
    const last = dirs[32];
    const result = await discoverAntigravityRuntimes({
      HOME: home,
      PATH: dirs.join(delimiter),
    });
    assert.equal(result.candidates.length, 32);
    if (last !== undefined) {
      assert.equal(result.candidates.some((candidate) => candidate.path === join(last, serverName)), false);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('skips a non-executable harness', { skip: posixOnly }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agy-mode-'));
  try {
    const home = join(root, 'home');
    const directory = join(root, 'bin');
    const server = join(directory, serverName);
    const harness = join(directory, harnessName);
    await executable(server, '#!/bin/sh\nexit 0\n');
    await mkdir(directory, { recursive: true });
    await writeFile(harness, '#!/bin/sh\nexit 0\n');
    await chmod(harness, 0o644);
    const result = await discoverAntigravityRuntimes({ HOME: home, PATH: directory });
    assert.deepEqual(result.candidates, []);
    await assert.rejects(probeAntigravityRuntime(server, { HOME: home, PATH: directory }), /is not executable/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('probe displayName is the manifest Runtime display name', { skip: posixOnly }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agy-probe-'));
  const pidPath = join(root, 'pid');
  try {
    const home = join(root, 'home');
    const agentHome = join(root, 'agent-home');
    const directory = join(root, 'extract');
    await mkdir(home, { recursive: true });
    await mkdir(agentHome, { recursive: true });
    const server = join(directory, serverName);
    const harness = join(directory, harnessName);
    await writeServerWrapper(server);
    await executable(harness, '#!/bin/sh\nexit 0\n');
    const logPath = join(root, 'methods.log');
    const initPath = join(root, 'init.json');
    const envPath = join(root, 'env.json');
    const result = await probeAntigravityRuntime(server, {
      HOME: home,
      GIAN_AGENT_HOME: agentHome,
      GEMINI_HOME: join(root, 'ignored-gemini'),
      ANTIGRAVITY_HARNESS_PATH: join(root, 'stale-harness'),
      PATH: '',
      FAKE_AGY_LOG: logPath,
      FAKE_AGY_INIT_REPORT: initPath,
      FAKE_AGY_ENV_REPORT: envPath,
      FAKE_AGY_REQUIRE_HARNESS: '1',
      FAKE_AGY_PID: pidPath,
    });
    assert.equal(result.displayName, 'Antigravity ACP Server');
    assert.equal(result.displayName, ANTIGRAVITY_RUNTIME_DISPLAY_NAME);
    assert.equal(result.runtimeId, ANTIGRAVITY_RUNTIME_ID);
    assert.equal(result.version, '1.4.3');
    assert.equal(result.configHome, agentHome);
    assert.deepEqual(result.contentRoots, [
      { path: server, mode: 'file' },
      { path: harness, mode: 'file' },
    ]);
    assert.deepEqual((await readFile(logPath, 'utf8')).trim().split('\n'), ['initialize']);
    const init = JSON.parse(await readFile(initPath, 'utf8')) as {
      protocolVersion: number;
      clientInfo: { name: string; title: string; version: string };
      clientCapabilities: { terminal: boolean; fs: { readTextFile: boolean; writeTextFile: boolean } };
      _meta?: unknown;
    };
    assert.equal(init.protocolVersion, 1);
    assert.deepEqual(init.clientInfo, {
      name: 'gian-antigravity-proxy',
      title: 'Gian Antigravity Proxy',
      version: '0.0.1',
    });
    assert.equal(init.clientCapabilities.terminal, false);
    assert.deepEqual(init.clientCapabilities.fs, { readTextFile: false, writeTextFile: false });
    assert.equal(init._meta, undefined);
    const reported = JSON.parse(await readFile(envPath, 'utf8')) as {
      HOME: string;
      GEMINI_HOME: string;
      ANTIGRAVITY_HARNESS_PATH: string;
      argv: string[];
    };
    assert.equal(reported.HOME, home);
    assert.equal(reported.GEMINI_HOME, agentHome);
    assert.equal(reported.ANTIGRAVITY_HARNESS_PATH, harness);
    assert.equal(reported.argv.includes('--version'), false);
    const pid = Number(await readFile(pidPath, 'utf8'));
    assert.equal(processAlive(pid), false);
  } finally {
    await killPidFile(pidPath);
    await rm(root, { recursive: true, force: true });
  }
});

test('probe rejects a different ACP agent name even at version 1.4.3', { skip: posixOnly }, async () => {
  assert.equal(ANTIGRAVITY_AGENT_NAME, 'antigravity-acp');
  assert.equal(ANTIGRAVITY_RUNTIME_DISPLAY_NAME, 'Antigravity ACP Server');
  const root = await mkdtemp(join(tmpdir(), 'agy-peer-'));
  const pidPath = join(root, 'pid');
  try {
    const directory = join(root, 'extract');
    const server = join(directory, serverName);
    await writeServerWrapper(server);
    await executable(join(directory, harnessName), '#!/bin/sh\nexit 0\n');
    const agentReport = join(root, 'agent.json');
    await assert.rejects(
      probeAntigravityRuntime(server, {
        HOME: root,
        PATH: '',
        FAKE_AGY_AGENT_NAME: 'other-acp',
        FAKE_AGY_VERSION: '1.4.3',
        FAKE_AGY_AGENT_REPORT: agentReport,
        FAKE_AGY_PID: pidPath,
      }),
      (error: unknown) => {
        assert.ok(error instanceof AntigravityRuntimeError);
        assert.match(error.message, /agentInfo\.name "other-acp"/);
        assert.match(error.message, /expected antigravity-acp/);
        assert.equal(error.message.includes(ANTIGRAVITY_RUNTIME_DISPLAY_NAME), false);
        return true;
      },
    );
    assert.deepEqual(JSON.parse(await readFile(agentReport, 'utf8')), {
      name: 'other-acp',
      version: '1.4.3',
    });
    const pid = Number(await readFile(pidPath, 'utf8'));
    assert.equal(processAlive(pid), false);
  } finally {
    await killPidFile(pidPath);
    await rm(root, { recursive: true, force: true });
  }
});

test('probe rejects a non-SemVer initialize version', { skip: posixOnly }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agy-semver-'));
  const pidPath = join(root, 'pid');
  try {
    const directory = join(root, 'extract');
    const server = join(directory, serverName);
    await writeServerWrapper(server);
    await executable(join(directory, harnessName), '#!/bin/sh\nexit 0\n');
    await assert.rejects(
      probeAntigravityRuntime(server, {
        HOME: root,
        PATH: '',
        FAKE_AGY_VERSION: 'not-a-version',
        FAKE_AGY_PID: pidPath,
      }),
      /SemVer/,
    );
    const pid = Number(await readFile(pidPath, 'utf8'));
    assert.equal(processAlive(pid), false);
  } finally {
    await killPidFile(pidPath);
    await rm(root, { recursive: true, force: true });
  }
});

test('probe launches agy acp without a harness and accepts the CLI agent', { skip: posixOnly }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agy-cli-probe-'));
  const pidPath = join(root, 'pid');
  try {
    const home = join(root, 'home');
    await mkdir(home, { recursive: true });
    const cli = join(root, 'bin', cliName);
    await writeServerWrapper(cli);
    const logPath = join(root, 'methods.log');
    const envPath = join(root, 'env.json');
    const managedHome = join(root, 'gian-homes', 'io.gian.antigravity', 'agent-1');
    const result = await probeAntigravityRuntime(cli, {
      HOME: home,
      GIAN_AGENT_HOME: managedHome,
      GEMINI_HOME: managedHome,
      ANTIGRAVITY_HARNESS_PATH: join(root, 'stale-harness'),
      PATH: '',
      FAKE_AGY_LOG: logPath,
      FAKE_AGY_ENV_REPORT: envPath,
      FAKE_AGY_AGENT_NAME: ANTIGRAVITY_CLI_AGENT_NAME,
      FAKE_AGY_VERSION: '1.5.10',
      FAKE_AGY_PID: pidPath,
    });
    assert.equal(result.displayName, ANTIGRAVITY_RUNTIME_DISPLAY_NAME);
    assert.equal(result.runtimeId, ANTIGRAVITY_RUNTIME_ID);
    assert.equal(result.version, '1.5.10');
    // The CLI shares the user's own sign-in: its home is the account ~/.gemini
    // even when the Host bound a managed Agent HOME.
    assert.equal(result.configHome, join(home, '.gemini'));
    assert.deepEqual(result.contentRoots, [{ path: cli, mode: 'file' }]);
    assert.deepEqual((await readFile(logPath, 'utf8')).trim().split('\n'), ['initialize']);
    const reported = JSON.parse(await readFile(envPath, 'utf8')) as {
      ANTIGRAVITY_HARNESS_PATH: string | null;
      GEMINI_HOME: string | null;
      AGY_CLI_DISABLE_AUTO_UPDATE: string | null;
      argv: string[];
    };
    assert.equal(reported.ANTIGRAVITY_HARNESS_PATH, null);
    assert.equal(reported.GEMINI_HOME, null);
    assert.equal(reported.AGY_CLI_DISABLE_AUTO_UPDATE, 'true');
    assert.deepEqual(reported.argv.slice(2), ['acp']);
    const pid = Number(await readFile(pidPath, 'utf8'));
    assert.equal(processAlive(pid), false);
  } finally {
    await killPidFile(pidPath);
    await rm(root, { recursive: true, force: true });
  }
});

test('probe rejects an agy CLI older than 1.5.9 and the legacy agent name', { skip: posixOnly }, async () => {
  assert.equal(ANTIGRAVITY_CLI_MIN_VERSION, '1.5.9');
  const root = await mkdtemp(join(tmpdir(), 'agy-cli-old-'));
  const pidPath = join(root, 'pid');
  try {
    const cli = join(root, 'bin', cliName);
    await writeServerWrapper(cli);
    for (const version of ['1.5.8', '1.5.9-rc.1', '1.4.10']) {
      await assert.rejects(
        probeAntigravityRuntime(cli, {
          HOME: root,
          PATH: '',
          FAKE_AGY_AGENT_NAME: ANTIGRAVITY_CLI_AGENT_NAME,
          FAKE_AGY_VERSION: version,
          FAKE_AGY_PID: pidPath,
        }),
        (error: unknown) => {
          assert.ok(error instanceof AntigravityRuntimeError);
          assert.match(error.message, new RegExp(`agy ${version.replaceAll('.', '\\.')} is too old`));
          assert.match(error.message, /1\.5\.9 or later/);
          assert.match(error.message, /Update agy/);
          return true;
        },
      );
      assert.equal(processAlive(Number(await readFile(pidPath, 'utf8'))), false);
    }
    await assert.rejects(
      probeAntigravityRuntime(cli, { HOME: root, PATH: '', FAKE_AGY_VERSION: '1.5.10', FAKE_AGY_PID: pidPath }),
      /agentInfo\.name "antigravity-acp"; expected Antigravity ACP Server/,
    );
  } finally {
    await killPidFile(pidPath);
    await rm(root, { recursive: true, force: true });
  }
});

test('probe does not spawn when the required harness file is missing', { skip: posixOnly }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agy-missing-'));
  try {
    const directory = join(root, 'extract');
    const server = join(directory, serverName);
    await executable(server, '#!/bin/sh\nexit 0\n');
    const logPath = join(root, 'methods.log');
    await assert.rejects(
      probeAntigravityRuntime(server, { HOME: root, PATH: '', FAKE_AGY_LOG: logPath }),
      /Required localharness file is not in/,
    );
    await assert.rejects(access(logPath, constants.F_OK), (error: unknown) => (
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    ));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function killPidFile(path: string): Promise<void> {
  try {
    const pid = Number(await readFile(path, 'utf8'));
    if (Number.isInteger(pid) && pid > 0) process.kill(pid, 'SIGKILL');
  } catch {
    // The process is already gone or the pid file was never written.
  }
}
