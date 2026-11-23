import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';

import {
  runtimeDiscoverResultSchema,
  runtimeProbeResultSchema,
  type RuntimeDiscoverResult,
  type RuntimeProbeResult,
} from '@gian/proxy-protocol';

import { AntigravityAcpClient } from './acp-client.js';
import { AntigravityRuntimeError } from './errors.js';
import { resolveCliGeminiHome, resolveGeminiHome } from './home.js';
import {
  ANTIGRAVITY_AGENT_NAME,
  ANTIGRAVITY_CLI_AGENT_NAME,
  ANTIGRAVITY_CLI_MIN_VERSION,
  ANTIGRAVITY_RUNTIME_DISPLAY_NAME,
  ANTIGRAVITY_RUNTIME_ID,
  assertServerExecutable,
  cliBasenames,
  isAntigravityCliBinary,
  resolvePairedHarness,
  serverBasenames,
  tryResolvePairedHarness,
} from './layout.js';

const SETUP_URL = 'https://antigravity.google/docs/ide/extensions/acp/';
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const PROBE_STARTUP_TIMEOUT_MS = 15_000;
const PROBE_GRACEFUL_STOP_MS = 1_000;
const MAX_CANDIDATES = 32;

export type RuntimeCandidateSource = 'official-user' | 'official-system' | 'path';

export function candidateSource(directory: string, home: string): RuntimeCandidateSource {
  if (directory === join(home, '.local', 'bin')) return 'official-user';
  if (directory === '/opt/homebrew/bin' || directory === '/usr/local/bin') return 'official-system';
  return 'path';
}

/**
 * `agy` CLI executables first, then explicit extracted server/harness pairs,
 * each in `~/.local/bin` then `PATH` order. The CLI needs no companion file.
 * A legacy server is a candidate only when its paired harness is in the same
 * directory. Host-managed installations use the exact provisioned path, not
 * this PATH discovery list.
 */
export async function discoverAntigravityRuntimes(
  env: NodeJS.ProcessEnv = process.env,
): Promise<RuntimeDiscoverResult> {
  const home = absoluteHome(env);
  const directories = searchDirectories(env, home);
  const seen = new Set<string>();
  const candidates: RuntimeDiscoverResult['candidates'] = [];
  const kinds = [
    { names: cliBasenames(), usable: executableFile },
    { names: serverBasenames(), usable: pairedServer },
  ];
  for (const kind of kinds) {
    for (const directory of directories) {
      for (const name of kind.names) {
        const path = resolve(directory, name);
        if (!isAbsolute(path) || seen.has(path)) continue;
        if (!(await kind.usable(path))) continue;
        seen.add(path);
        candidates.push({
          path,
          source: candidateSource(directory, home),
          label: ANTIGRAVITY_RUNTIME_DISPLAY_NAME,
        });
        if (candidates.length === MAX_CANDIDATES) break;
      }
      if (candidates.length === MAX_CANDIDATES) break;
    }
    if (candidates.length === MAX_CANDIDATES) break;
  }
  return runtimeDiscoverResultSchema.parse({
    candidates,
    setupActions: [
      { id: 'docs', kind: 'open_url', label: 'Install the agy CLI (Antigravity ACP)', url: SETUP_URL },
      { id: 'pick-server', kind: 'select_file', label: 'Choose the agy CLI or an extracted ACP server' },
    ],
  });
}

/**
 * Validates the binary, then performs one bounded ACP `initialize`.
 * The `agy` CLI runs as `agy acp`; it must report `agentInfo.name`
 * `Antigravity ACP Server` and a SemVer version of at least 1.5.9. A legacy
 * server must have its sibling harness and report `antigravity-acp`.
 * Another protocol-compatible executable is not this Runtime, even at 1.3.0.
 * It does not call `--version`, authenticate, or open a session.
 */
export async function probeAntigravityRuntime(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RuntimeProbeResult> {
  if (!isAbsolute(path)) {
    throw new AntigravityRuntimeError('Antigravity runtime path must be absolute.');
  }
  await assertServerExecutable(path);
  const cli = isAntigravityCliBinary(path);
  const harnessPath = cli ? null : await resolvePairedHarness(path);
  const client = new AntigravityAcpClient({
    binaryPath: path,
    cwd: dirname(path),
    env,
    startupTimeoutMs: PROBE_STARTUP_TIMEOUT_MS,
    gracefulStopMs: PROBE_GRACEFUL_STOP_MS,
  });
  try {
    const initialized = await client.ensureStarted();
    const agentName = initialized.agentInfo?.name;
    const expectedName = cli ? ANTIGRAVITY_CLI_AGENT_NAME : ANTIGRAVITY_AGENT_NAME;
    if (agentName !== expectedName) {
      throw new AntigravityRuntimeError(
        `Antigravity ACP initialize reported agentInfo.name ${JSON.stringify(agentName ?? null)}; expected ${expectedName}.`,
      );
    }
    const version = initialized.agentInfo?.version;
    if (typeof version !== 'string' || !SEMVER.test(version)) {
      throw new AntigravityRuntimeError('Antigravity ACP initialize did not report a SemVer agentInfo.version.');
    }
    if (cli && !atLeastVersion(version, ANTIGRAVITY_CLI_MIN_VERSION)) {
      throw new AntigravityRuntimeError(
        `agy ${version} is too old for Gian: \`agy acp\` needs agy ${ANTIGRAVITY_CLI_MIN_VERSION} or later to use your CLI sign-in. Update agy, then choose it again.`,
      );
    }
    return runtimeProbeResultSchema.parse({
      runtimeId: ANTIGRAVITY_RUNTIME_ID,
      displayName: ANTIGRAVITY_RUNTIME_DISPLAY_NAME,
      path,
      version,
      configHome: cli ? resolveCliGeminiHome(env) : resolveGeminiHome(env),
      contentRoots: harnessPath === null
        ? [{ path, mode: 'file' }]
        : [
          { path, mode: 'file' },
          { path: harnessPath, mode: 'file' },
        ],
    });
  } finally {
    await client.stop();
  }
}

/**
 * SemVer precedence against a release floor. Build metadata is ignored and a
 * pre-release of the floor itself is older than the floor.
 */
function atLeastVersion(version: string, minimum: string): boolean {
  const actual = versionCore(version);
  const floor = versionCore(minimum);
  if (actual === null || floor === null) return false;
  for (let index = 0; index < 3; index += 1) {
    const a = actual.core[index] ?? 0;
    const b = floor.core[index] ?? 0;
    if (a !== b) return a > b;
  }
  return !actual.prerelease || floor.prerelease;
}

function versionCore(version: string): { core: number[]; prerelease: boolean } | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(-[^+]+)?(?:\+.*)?$/.exec(version);
  if (!match) return null;
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4] !== undefined };
}

async function executableFile(path: string): Promise<boolean> {
  try {
    await assertServerExecutable(path);
    return true;
  } catch (error) {
    if (error instanceof AntigravityRuntimeError) return false;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw error;
  }
}

async function pairedServer(path: string): Promise<boolean> {
  if (!(await executableFile(path))) return false;
  return (await tryResolvePairedHarness(path)) !== null;
}

function searchDirectories(env: NodeJS.ProcessEnv, home: string): string[] {
  const directories = [join(home, '.local', 'bin')];
  for (const entry of (env.PATH ?? '').split(delimiter)) {
    if (entry.trim() === '') continue;
    directories.push(resolve(entry));
  }
  return [...new Set(directories)];
}

function absoluteHome(env: NodeJS.ProcessEnv): string {
  if (typeof env.HOME === 'string' && isAbsolute(env.HOME)) return env.HOME;
  return homedir();
}
