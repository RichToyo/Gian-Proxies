import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF_TEST_FLAG = '--self-test';

/** Version of the `@gian/*-proxy` package that contains `moduleUrl`. Pass the
 * caller's `import.meta.url`: walking up from the kit itself would find the
 * kit's package, not the Proxy's. Without a fallback, a missing package
 * identity throws instead of guessing. */
export function readPluginVersion(moduleUrl: string, fallback?: string): string {
  let dir = dirname(fileURLToPath(moduleUrl));
  for (let i = 0; i < 6; i += 1) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        name?: string;
        version?: string;
      };
      if (
        typeof pkg.version === 'string'
        && pkg.version.length > 0
        && typeof pkg.name === 'string'
        && pkg.name.startsWith('@gian/')
        && pkg.name.endsWith('-proxy')
      ) {
        return pkg.version;
      }
    } catch {
      /* keep walking */
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (fallback === undefined) throw new Error('Proxy package version is unavailable.');
  return fallback;
}

/** `--key value` and bare `--flag` options. Positional arguments are ignored. */
export function parseProxyArgs(argv: readonly string[]): Record<string, string | boolean> {
  const options: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current?.startsWith('--')) continue;
    const key = current.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      options[key] = true;
      continue;
    }
    options[key] = next;
    index += 1;
  }
  return options;
}

/** Answers `--self-test` with the artifact identity line. Returns true when it
 * handled the invocation and the caller should exit. */
export function runSelfTest(
  argv: readonly string[],
  identity: { id: string; pluginVersion: string },
  output: NodeJS.WritableStream = process.stdout,
): boolean {
  if (!argv.includes(SELF_TEST_FLAG)) return false;
  output.write(`${JSON.stringify({
    schemaVersion: 4,
    id: identity.id,
    pluginVersion: identity.pluginVersion,
    ok: true,
  })}\n`);
  return true;
}
