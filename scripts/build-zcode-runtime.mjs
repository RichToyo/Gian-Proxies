import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, chmod, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';
import { promisify } from 'node:util';

import { validateZcodeRuntimeSource, zcodeRuntimeSource as source } from './zcode-runtime-source.mjs';
import { installZcodeIntegration } from './zcode-runtime-integration.mjs';

const execFileAsync = promisify(execFile);

/** Native key-store binding for this platform (upstream keyringPlatformPackage). */
export const ZCODE_KEYRING_PACKAGES = Object.freeze(['@napi-rs/keyring', '@napi-rs/keyring-darwin-arm64']);

/** 3.18 encrypts credentials.json with a key held in the system key store
 * through the external `@napi-rs/keyring` native module. Upstream stages it
 * next to the Desktop agent bundle (scripts/stage-credential-keyring.mjs), but
 * `build:zcode` does not ship it. Stage the same two locked packages, with the
 * same resolution root and filter, next to zcode.cjs so the standalone
 * cipher can load its key. */
export async function stageZcodeCredentialKeyring(checkout, agentDir) {
  // The binding resolves its platform package from its own location (pnpm
  // keeps that package beside it in the store, not beside packages/shared).
  const fromShared = createRequire(join(checkout, 'packages/shared/package.json'));
  const fromKeyring = createRequire(fromShared.resolve(`${ZCODE_KEYRING_PACKAGES[0]}/package.json`));
  // Node resolves zcode.cjs's `import("@napi-rs/keyring")` from agent/node_modules
  // first; the binding then finds its platform package beside itself.
  const target = name => join(agentDir, 'node_modules', name);
  const staged = async name => {
    try {
      const manifest = JSON.parse(await readFile(join(target(name), 'package.json'), 'utf8'));
      await access(join(target(name), manifest.main ?? 'index.js'));
      return true;
    } catch { return false; }
  };
  for (const name of ZCODE_KEYRING_PACKAGES) {
    if (await staged(name)) continue;
    const source = dirname((name === ZCODE_KEYRING_PACKAGES[0] ? fromShared : fromKeyring).resolve(`${name}/package.json`));
    const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
    if (name !== ZCODE_KEYRING_PACKAGES[0]) await access(join(source, manifest.main));
    await cp(source, target(name), {
      recursive: true, dereference: true, errorOnExist: true, force: false,
      filter: file => !file.slice(source.length).split(sep).includes('node_modules'),
    });
  }
  for (const name of ZCODE_KEYRING_PACKAGES) {
    if (!await staged(name)) {
      throw new Error(`ZCode Runtime does not resolve its staged ${name}.`);
    }
  }
}

/** Build only on the selected hosted release runner. Installation on a user's
 * machine downloads the resulting archive; it never clones or runs pnpm. */
export async function stageZcodeRuntime(workDir, releaseBaseUrl) {
  validateZcodeRuntimeSource();
  if (`${process.platform}-${process.arch}` !== source.platform
    || process.versions.node !== source.nodeVersion) {
    throw new Error(`ZCode build requires ${source.platform} with Node ${source.nodeVersion}.`);
  }
  const checkout = join(workDir, 'zcode-source');
  await mkdir(checkout, { recursive: false, mode: 0o700 });
  const env = { ...process.env, ELECTRON_SKIP_BINARY_DOWNLOAD: '1', CI: 'true' };
  const run = (command, args, timeout = 60_000) => execFileAsync(command, args, {
    cwd: checkout, env, encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024,
  });
  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  if ((await run(pnpm, ['--version'])).stdout.trim() !== source.pnpmVersion) {
    throw new Error(`ZCode build requires pnpm ${source.pnpmVersion}.`);
  }
  console.log(`[zcode-runtime] fetching ${source.commit}`);
  await run('git', ['init', '--quiet']);
  await run('git', ['remote', 'add', 'origin', source.repository]);
  await run('git', ['fetch', '--depth=1', 'origin', source.commit], 5 * 60_000);
  await run('git', ['checkout', '--detach', 'FETCH_HEAD']);
  if ((await run('git', ['rev-parse', 'HEAD'])).stdout.trim() !== source.commit) {
    throw new Error('ZCode checkout does not match the pinned commit.');
  }
  const lock = await readFile(join(checkout, 'pnpm-lock.yaml'));
  if (createHash('sha256').update(lock).digest('hex') !== source.lockfileSha256) {
    throw new Error('ZCode dependency lock differs from the pinned source.');
  }
  const cli = JSON.parse(await readFile(join(checkout, 'apps/zcode-cli/package.json'), 'utf8'));
  if (cli.version !== source.cliVersion) throw new Error('ZCode CLI version differs from the source lock.');
  console.log('[zcode-runtime] installing locked dependencies and building the CLI distribution');
  await run(pnpm, ['install', '--frozen-lockfile'], 15 * 60_000);
  // `build:zcode` (the CLI/SEA pipeline) consumes `@zcode/shared`'s compiled
  // dist but upstream's full `pnpm build` also builds the whole Desktop and
  // downloads multi-platform Node/asset bundles — far beyond what the CLI
  // runtime needs. Compile exactly the prerequisite package graph instead;
  // today that is packages/shared's own tsconfig.
  console.log('[zcode-runtime] building @zcode/shared dist for the CLI pipeline');
  await run(pnpm, ['exec', 'tsc', '-p', 'packages/shared/tsconfig.json'], 10 * 60_000);
  const integration = await installZcodeIntegration(checkout);
  await run(pnpm, ['build:zcode', '--base-url', releaseBaseUrl], 30 * 60_000);
  // Upstream removes its staging tree after packaging. Extract into an
  // isolated build directory, then materialize links before Host-safe packing.
  const index = JSON.parse(await readFile(join(checkout, 'dist/zcode/latest.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+$/.test(index.version)
    || index.tarball !== `zcode-${index.version}.tar.gz`) {
    throw new Error('Unexpected ZCode distribution layout.');
  }
  const extracted = join(workDir, 'zcode-extracted');
  await mkdir(extracted, { mode: 0o700 });
  const archive = join(checkout, 'dist/zcode/releases', index.version, index.tarball);
  const archiveBytes = await readFile(archive);
  if (createHash('sha256').update(archiveBytes).digest('hex') !== index.sha256) {
    throw new Error('ZCode distribution differs from its build checksum.');
  }
  await run('/usr/bin/tar', ['-xzf', archive, '-C', extracted]);
  const runtimeRoot = join(workDir, 'zcode-runtime');
  await mkdir(runtimeRoot, { mode: 0o700 });
  await cp(join(extracted, 'zcode'), join(runtimeRoot, 'zcode'), {
    recursive: true, dereference: true, errorOnExist: true, force: false,
  });
  await stageZcodeCredentialKeyring(checkout, join(runtimeRoot, 'zcode/agent'));
  for (const name of ['LICENSE', 'NOTICE.md', 'THIRD-PARTY-NOTICES.md']) {
    await cp(join(checkout, name), join(runtimeRoot, 'zcode', name));
  }
  // Preserve the exact source/toolchain identity inside the downloadable tree.
  await writeFile(join(runtimeRoot, 'zcode/gian-source.json'), `${JSON.stringify(source, null, 2)}\n`);
  await writeFile(join(runtimeRoot, 'zcode/gian-integration.json'), `${JSON.stringify(integration, null, 2)}\n`);
  await writeFile(join(runtimeRoot, 'zcode/GIAN-INTEGRATION.md'),
    '# Gian ZCode integration\n\nBuilt from zai-org/ZCode at ' + source.commit + '.\n\n'
    + 'Gian modifies the protocol entrypoint to use the official standalone CLI Provider lifecycle, '
    + 'including its request-time authentication port and its in-process credential cipher, '
    + 'and adds gian/modelCatalog for metadata-only discovery. '
    + 'The darwin-arm64 @napi-rs/keyring binding is staged next to zcode.cjs, as upstream does for Desktop. '
    + 'No provider credentials or headers are returned by this method. '
    + 'gian-source.json and gian-integration.json record source and modification digests.\n');
  await chmod(join(runtimeRoot, source.entryRelativePath), 0o755);
  await readFile(join(runtimeRoot, 'zcode/agent/provider/zcode-builtin.json'));
  return runtimeRoot;
}
