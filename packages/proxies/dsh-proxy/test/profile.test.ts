import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { dshHome, ensureGianProfile, gianProfileName, resolveBridgePackageDir } from '../src/runtime/profile.js';

async function makeRoot(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'gian-dsh-profile-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function makeBridgePackage(root: string, name = '@gian/dsh-bridge'): Promise<string> {
  const dir = join(root, 'bridge');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'package.json'),
    `${JSON.stringify({ name, version: '0.0.0' }, null, 2)}\n`,
    'utf8',
  );
  return dir;
}

function envFor(home: string, bridgeDir: string): NodeJS.ProcessEnv {
  return { DSH_HOME: home, GIAN_DSH_BRIDGE_PACKAGE_DIR: bridgeDir };
}

function profileDirFor(home: string, bridgeDir: string): string {
  return join(home, 'profiles', gianProfileName(envFor(home, bridgeDir)));
}

function linkPathFor(home: string, bridgeDir: string): string {
  return join(profileDirFor(home, bridgeDir), 'node_modules', '@gian', 'dsh-bridge');
}

test('dshHome trims DSH_HOME and defaults to ~/.dsh', () => {
  assert.equal(dshHome({ DSH_HOME: '  /tmp/dsh-custom  ' }), '/tmp/dsh-custom');
  assert.match(dshHome({}), /\.dsh$/);
});

test('first boot creates the binding-scoped profile manifest and bridge symlink', async (t) => {
  const root = await makeRoot(t);
  const home = join(root, 'home');
  const bridge = await makeBridgePackage(root);

  const result = await ensureGianProfile(envFor(home, bridge));

  assert.match(result.profileName, /^gian-[a-f0-9]{16}$/);
  assert.equal(result.profileDir, profileDirFor(home, bridge));
  assert.equal(result.bridgePackageDir, bridge);
  assert.ok(result.actions.length > 0);
  const manifest = JSON.parse(
    await readFile(join(result.profileDir, 'package.json'), 'utf8'),
  ) as { dependencies: Record<string, string>; dsh: { profile: { bundles: string[] } } };
  assert.equal(manifest.dependencies['@gian/dsh-bridge'], `file:${bridge}`);
  assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@gian/dsh-bridge']);
  const linkPath = linkPathFor(home, bridge);
  assert.ok((await lstat(linkPath)).isSymbolicLink());
  assert.equal(await readlink(linkPath), bridge);
});

test('a consistent profile is left untouched', async (t) => {
  const root = await makeRoot(t);
  const home = join(root, 'home');
  const bridge = await makeBridgePackage(root);

  await ensureGianProfile(envFor(home, bridge));
  const manifestPath = join(profileDirFor(home, bridge), 'package.json');
  const before = await readFile(manifestPath, 'utf8');
  const second = await ensureGianProfile(envFor(home, bridge));

  assert.deepEqual(second.actions, []);
  assert.equal(await readFile(manifestPath, 'utf8'), before);
  assert.equal(await readlink(linkPathFor(home, bridge)), bridge);
});

test('a broken bridge symlink is repaired', async (t) => {
  const root = await makeRoot(t);
  const home = join(root, 'home');
  const bridge = await makeBridgePackage(root);
  await ensureGianProfile(envFor(home, bridge));

  const linkPath = linkPathFor(home, bridge);
  await rm(linkPath);
  await symlink(join(root, 'missing-target'), linkPath, 'dir');

  const result = await ensureGianProfile(envFor(home, bridge));

  assert.equal(await readlink(linkPath), bridge);
  assert.ok(result.actions.some((action) => action.includes('symlink')));
});

test('a bridge symlink pointing at the wrong target is repaired', async (t) => {
  const root = await makeRoot(t);
  const home = join(root, 'home');
  const bridge = await makeBridgePackage(root);
  const other = await makeBridgePackage(join(root, 'other'), '@gian/other');
  await ensureGianProfile(envFor(home, bridge));

  const linkPath = linkPathFor(home, bridge);
  await rm(linkPath);
  await symlink(other, linkPath, 'dir');

  const result = await ensureGianProfile(envFor(home, bridge));

  assert.equal(await readlink(linkPath), bridge);
  assert.ok(result.actions.some((action) => action.includes('symlink')));
});

test('a drifted package.json is rewritten to the canonical manifest', async (t) => {
  const root = await makeRoot(t);
  const home = join(root, 'home');
  const bridge = await makeBridgePackage(root);
  await ensureGianProfile(envFor(home, bridge));

  const manifestPath = join(profileDirFor(home, bridge), 'package.json');
  await writeFile(manifestPath, JSON.stringify({
    name: 'gian-dsh-profile',
    private: true,
    dependencies: { '@gian/dsh-bridge': 'file:/somewhere/stale' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
  }), 'utf8');

  const result = await ensureGianProfile(envFor(home, bridge));

  assert.ok(result.actions.some((action) => action.includes('package.json')));
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    dependencies: Record<string, string>;
    dsh: { profile: { bundles: string[] } };
  };
  assert.equal(manifest.dependencies['@gian/dsh-bridge'], `file:${bridge}`);
  assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@gian/dsh-bridge']);
});

test('different Runtime and Proxy bindings never rewrite each other or the legacy profile', async (t) => {
  const root = await makeRoot(t);
  const home = join(root, 'home');
  const firstBridge = await makeBridgePackage(join(root, 'first'));
  const secondBridge = await makeBridgePackage(join(root, 'second'));
  const legacyManifest = join(home, 'profiles', 'gian', 'package.json');
  await mkdir(join(home, 'profiles', 'gian'), { recursive: true });
  await writeFile(legacyManifest, '{"legacy":true}\n', 'utf8');
  const firstEnv = {
    ...envFor(home, firstBridge),
    GIAN_DATA_DIR: join(root, 'gian-data'),
    GIAN_RUNTIME_BIN: join(root, 'runtime-a', 'bin.js'),
  };
  const secondEnv = {
    ...envFor(home, secondBridge),
    GIAN_DATA_DIR: join(root, 'gian-dev-data'),
    GIAN_RUNTIME_BIN: join(root, 'runtime-b', 'bin.js'),
  };

  const first = await ensureGianProfile(firstEnv);
  const second = await ensureGianProfile(secondEnv);
  const firstManifest = JSON.parse(await readFile(join(first.profileDir, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>;
  };
  const secondManifest = JSON.parse(await readFile(join(second.profileDir, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>;
  };

  assert.notEqual(first.profileDir, second.profileDir);
  assert.equal(await readFile(legacyManifest, 'utf8'), '{"legacy":true}\n');
  assert.equal(firstManifest.dependencies['@gian/dsh-bridge'], `file:${firstBridge}`);
  assert.equal(secondManifest.dependencies['@gian/dsh-bridge'], `file:${secondBridge}`);
  assert.equal(await readlink(join(first.profileDir, 'node_modules', '@gian', 'dsh-bridge')), firstBridge);
  assert.equal(await readlink(join(second.profileDir, 'node_modules', '@gian', 'dsh-bridge')), secondBridge);
});

test('an explicit bridge dir that is not @gian/dsh-bridge fails closed', async (t) => {
  const root = await makeRoot(t);
  const home = join(root, 'home');
  const wrong = await makeBridgePackage(join(root, 'wrong'), '@gian/not-the-bridge');

  await assert.rejects(
    () => ensureGianProfile(envFor(home, wrong)),
    /is not a @gian\/dsh-bridge package directory/,
  );
  await assert.rejects(
    () => resolveBridgePackageDir({ GIAN_DSH_BRIDGE_PACKAGE_DIR: join(root, 'does-not-exist') }),
    /is not a @gian\/dsh-bridge package directory/,
  );
  assert.equal(await lstat(home).catch(() => null), null, 'no profile was created');
});

test('a real directory at the symlink path is refused, not replaced', async (t) => {
  const root = await makeRoot(t);
  const home = join(root, 'home');
  const bridge = await makeBridgePackage(root);
  await ensureGianProfile(envFor(home, bridge));

  const linkPath = linkPathFor(home, bridge);
  await rm(linkPath);
  await mkdir(linkPath, { recursive: true });

  await assert.rejects(
    () => ensureGianProfile(envFor(home, bridge)),
    /exists and is not a symlink/,
  );
});

test('the development fallback resolves the sibling dsh-bridge package', async () => {
  const dir = await resolveBridgePackageDir({});
  assert.ok(dir.endsWith(join('proxies', 'dsh-bridge')));
});

test('a packaged Proxy prefers its bound Bridge over a legacy App Bridge', async t => {
  const root = await makeRoot(t);
  const bridge = await makeBridgePackage(root);
  const resolved = await resolveBridgePackageDir(
    { GIAN_DSH_BRIDGE_PACKAGE_DIR: join(root, 'old-app-bridge') },
    pathToFileURL(join(root, 'proxy.mjs')).href,
  );
  assert.equal(resolved, bridge);
});
