/**
 * Binding-scoped Gian DSH profile installer.
 *
 * Profiles live below the shared DSH home, but each Gian/Runtime/Bridge binding
 * owns a separate directory so formal and development processes cannot rewrite
 * one another's composition. Credentials, sessions, and official settings stay
 * in the shared home.
 *
 * DSH 0.2.0 imports `$DSH_HOME/settings.yaml` once and renames it
 * `settings.yaml.imported`. This installer writes only the profile package
 * manifest and the bridge symlink. Credentials stay at
 * `$DSH_HOME/.credentials.yaml`; settings are not copied into the profile
 * directory.
 */

import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const BRIDGE_PACKAGE_NAME = '@gian/dsh-bridge';
const PROFILE_MANIFEST_NAME = 'gian-dsh-profile';
const PROFILE_BUNDLES = ['@deepseek-ai/dsh-base', '@gian/dsh-bridge'];

export interface EnsureProfileResult {
  profileName: string;
  profileDir: string;
  bridgePackageDir: string;
  /** Empty when the profile was already consistent (no writes performed). */
  actions: string[];
}

function identityPath(value: string | undefined): string {
  const trimmed = value?.trim();
  return trimmed ? resolve(trimmed) : '';
}

export function gianProfileName(
  env: NodeJS.ProcessEnv = process.env,
  proxyEntry: string | undefined = process.argv[1],
): string {
  const identity = JSON.stringify([
    identityPath(env.GIAN_DATA_DIR ?? env.GIAN_PLUGIN_DATA_DIR),
    identityPath(env.GIAN_RUNTIME_BIN ?? env.DSH_HOST_ENTRY),
    identityPath(proxyEntry),
    identityPath(env.GIAN_DSH_BRIDGE_PACKAGE_DIR),
  ]);
  return `gian-${createHash('sha256').update(identity).digest('hex').slice(0, 16)}`;
}

export function dshHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.DSH_HOME?.trim();
  return configured ? resolve(configured) : join(homedir(), '.dsh');
}

async function readBridgePackageName(dir: string): Promise<string | null> {
  try {
    const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as { name?: unknown };
    return typeof manifest.name === 'string' ? manifest.name : null;
  } catch {
    return null;
  }
}

/**
 * Independently released bundles carry their exact Bridge beside proxy.mjs.
 * Legacy packages can use GIAN_DSH_BRIDGE_PACKAGE_DIR.
 * The development fallback resolves the sibling packages/proxies/dsh-bridge
 * directory relative to this module (dist/src/runtime → proxies/dsh-bridge).
 * Fails closed: the DSH host must never boot without a valid bridge package.
 */
export async function resolveBridgePackageDir(
  env: NodeJS.ProcessEnv = process.env,
  moduleUrl: string = import.meta.url,
): Promise<string> {
  const bundled = resolve(dirname(fileURLToPath(moduleUrl)), 'bridge');
  if (await readBridgePackageName(bundled) === BRIDGE_PACKAGE_NAME) return bundled;
  const configured = env.GIAN_DSH_BRIDGE_PACKAGE_DIR?.trim();
  if (configured) {
    const dir = resolve(configured);
    if (await readBridgePackageName(dir) === BRIDGE_PACKAGE_NAME) return dir;
    throw new Error(
      `GIAN_DSH_BRIDGE_PACKAGE_DIR (${dir}) is not a ${BRIDGE_PACKAGE_NAME} package directory.`,
    );
  }
  const sibling = resolve(dirname(fileURLToPath(moduleUrl)), '../../../../dsh-bridge');
  if (await readBridgePackageName(sibling) === BRIDGE_PACKAGE_NAME) return sibling;
  throw new Error(
    `Cannot locate the ${BRIDGE_PACKAGE_NAME} package directory; set GIAN_DSH_BRIDGE_PACKAGE_DIR.`,
  );
}

function canonicalManifest(bridgePackageDir: string): string {
  return `${JSON.stringify({
    name: PROFILE_MANIFEST_NAME,
    private: true,
    dependencies: { [BRIDGE_PACKAGE_NAME]: `file:${bridgePackageDir}` },
    dsh: { profile: { bundles: [...PROFILE_BUNDLES] } },
  }, null, 2)}\n`;
}

function manifestMatches(raw: string, bridgePackageDir: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  const manifest = parsed as {
    name?: unknown;
    private?: unknown;
    dependencies?: Record<string, unknown>;
    dsh?: { profile?: { bundles?: unknown } };
  } | null;
  const bundles = manifest?.dsh?.profile?.bundles;
  return manifest?.name === PROFILE_MANIFEST_NAME
    && manifest?.private === true
    && manifest?.dependencies?.[BRIDGE_PACKAGE_NAME] === `file:${bridgePackageDir}`
    && Array.isArray(bundles)
    && bundles.length === PROFILE_BUNDLES.length
    && bundles.every((bundle, index) => bundle === PROFILE_BUNDLES[index]);
}

/** mkdir -p below the DSH home, refusing to follow symlinks out of it. */
async function mkdirWithinHome(home: string, target: string): Promise<void> {
  if (target !== home && !target.startsWith(`${home}${sep}`)) {
    throw new Error(`refusing to create ${target} outside the DSH home ${home}`);
  }
  await mkdir(home, { recursive: true });
  let current = home;
  for (const segment of target.slice(home.length).split(sep).filter(Boolean)) {
    current = join(current, segment);
    const stats = await lstat(current).catch(() => null);
    if (stats === null) {
      await mkdir(current);
    } else if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(`refusing to follow non-directory ${current} inside the DSH home`);
    }
  }
}

export async function ensureGianProfile(
  env: NodeJS.ProcessEnv = process.env,
): Promise<EnsureProfileResult> {
  const home = dshHome(env);
  const bridgePackageDir = await resolveBridgePackageDir(env);
  const profileName = gianProfileName(env);
  const profileDir = join(home, 'profiles', profileName);
  const actions: string[] = [];

  await mkdirWithinHome(home, join(profileDir, 'node_modules', '@gian'));

  const manifestPath = join(profileDir, 'package.json');
  const manifestStats = await lstat(manifestPath).catch(() => null);
  const existing = manifestStats !== null && !manifestStats.isSymbolicLink()
    ? await readFile(manifestPath, 'utf8')
    : null;
  if (existing === null || !manifestMatches(existing, bridgePackageDir)) {
    if (manifestStats?.isSymbolicLink()) await rm(manifestPath);
    await writeFile(manifestPath, canonicalManifest(bridgePackageDir), 'utf8');
    actions.push(existing === null ? 'created package.json' : 'repaired package.json');
  }

  const linkPath = join(profileDir, 'node_modules', '@gian', 'dsh-bridge');
  const linkStats = await lstat(linkPath).catch(() => null);
  if (linkStats === null) {
    await symlink(bridgePackageDir, linkPath, 'dir');
    actions.push('created node_modules/@gian/dsh-bridge symlink');
  } else if (linkStats.isSymbolicLink()) {
    const target = await readlink(linkPath);
    if (resolve(dirname(linkPath), target) !== bridgePackageDir) {
      await rm(linkPath);
      await symlink(bridgePackageDir, linkPath, 'dir');
      actions.push('repaired node_modules/@gian/dsh-bridge symlink');
    }
  } else {
    throw new Error(
      `${linkPath} exists and is not a symlink; refusing to replace it. Move it aside and retry.`,
    );
  }

  return { profileName, profileDir, bridgePackageDir, actions };
}
