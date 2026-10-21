import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { satisfies } from 'semver';

const here = dirname(fileURLToPath(import.meta.url));
// Compiled tests run from dist/test: package.json is two levels up, the
// repository root five.
const pkgRoot = join(here, '..', '..');
const repoRoot = join(here, '..', '..', '..', '..', '..');

/** The bridge peer range must admit the exact pinned Runtime with real semver
 *  resolution. npm treats prerelease tuples strictly: `^0.2.0-rc.2` does NOT
 *  satisfy 0.2.1-rc.2, so the range must name the 0.2.1 RC line explicitly
 *  while retaining the 0.2.0 RC line. */
test('bridge peer range admits the pinned DSH runtime and retains the 0.2.0 RC line', () => {
  const bridgePkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
  const range = bridgePkg.peerDependencies['@deepseek-ai/dsh'];
  assert.equal(typeof range, 'string');

  const runtimePkg = JSON.parse(readFileSync(
    join(repoRoot, 'runtimes', 'deepseek-harness', 'package.json'), 'utf8'));
  const pinned = runtimePkg.dependencies['@deepseek-ai/dsh'];
  const lock = JSON.parse(readFileSync(
    join(repoRoot, 'runtimes', 'deepseek-harness', 'package-lock.json'), 'utf8'));
  const locked = lock.packages['node_modules/@deepseek-ai/dsh']?.version;
  assert.equal(locked, pinned, 'lock must resolve the exact pinned version');

  const manifest = JSON.parse(readFileSync(
    join(repoRoot, 'packages', 'proxies', 'dsh-proxy', 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.runtime.verifiedVersions, [pinned],
    'the Proxy manifest must verify exactly the pinned runtime');

  assert.equal(satisfies(pinned, range, { includePrerelease: false }), true,
    `${pinned} must satisfy the bridge peer range ${range}`);
  assert.equal(satisfies('0.2.0-rc.2', range), true,
    'the 0.2.0 RC line must stay admitted');
  assert.equal(satisfies('0.2.1-alpha.5', range), false,
    'the alpha channel must not be silently admitted');
  assert.equal(satisfies('0.3.0', range), false,
    'the next minor must stay outside the admitted range');
});
