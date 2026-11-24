/**
 * EXPLICIT CANARY (platform compatibility) — NOT part of the default
 * deterministic suite. Run it via `pnpm --filter @gian/zcode-proxy
 * test:real-app-server` (or scripts/run-zcode-app-server-canary.mjs).
 *
 * The code-generated synthetic config (see
 * test/fixtures/synthetic-zcode-config.mjs) must be accepted by the REAL
 * ZCode app-server — `session/create` then `session/read` succeed with a
 * fresh mkdtemp HOME and workspace.
 *
 * The runtime is the Gian-built ZCode CLI Runtime (App-source v3.18.2 at
 * fec9759, CLI 0.17.1): point ZCODE_CJS at its `zcode/agent/zcode.cjs`
 * (scripts/build-managed-runtime-candidates.mjs --provider zcode, or an
 * installed managed Runtime). ZCode.app is not a runtime source. Without
 * ZCODE_CJS, or without `provider/zcode-builtin.json` next to the entry,
 * this canary SKIPS with an explicit unavailable note — an honest "not
 * executed", never a fake PASS.
 *
 * Hard guarantees enforced by this test:
 *  - NO session/send (never any model/provider traffic, no quota);
 *  - no user data: the HOME/workspace are throwaway mkdtemp dirs; the user's
 *    real ~/.zcode is never read or written;
 *  - the app-server child is always stopped and temp dirs removed.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  INNER_PROTOCOL_NAME,
  INNER_PROTOCOL_VERSION,
} from '../src/identity.js';
import {
  buildAppServerEnvironment,
  registerGianReverseHandlers,
  ZCodeTransport,
} from '../src/inner/transport.js';

test('real app-server accepts the synthetic config: session/create then session/read', async (t) => {
  const runtimeBin = process.env.ZCODE_CJS ?? '';
  if (runtimeBin === '' || !existsSync(runtimeBin)) {
    t.skip(
      `real ZCode app-server unavailable (ZCODE_CJS=${runtimeBin || 'unset'}); `
      + 'synthetic-config lifecycle regression NOT executed — report unavailable, not a pass',
    );
    return;
  }
  // The standalone runtime needs its built-in provider config next to the
  // entry (provider-runtime-env.ts resolveBundledZCodeBuiltinProviderConfig).
  if (!existsSync(join(runtimeBin, '..', 'provider', 'zcode-builtin.json'))) {
    t.skip(
      `${runtimeBin} cannot start standalone: provider/zcode-builtin.json is missing. `
      + 'synthetic-config lifecycle regression NOT executed — report unavailable, not a pass. '
      + 'Point ZCODE_CJS at a standalone runtime build to execute this canary.',
    );
    return;
  }

  const { buildSyntheticZcodeConfig, SYNTHETIC_MODEL_REF } = await import(
    pathToFileURL(resolve('test/fixtures/synthetic-zcode-config.mjs')).href
  );

  // NOTE: keep the throwaway dirs on the SHORT /tmp path — the app-server
  // binds a unix socket under its HOME, and macOS's long default temp dir
  // (~90 chars) overflows sun_path (listen EINVAL). POSIX /tmp is the
  // portable short choice for the platforms ZCode supports.
  const home = mkdtempSync('/tmp/zcode-real-home-');
  const workspace = mkdtempSync('/tmp/zcode-real-ws-');
  let transport: ZCodeTransport | null = null;
  // Stop the app-server first: it keeps writing logs below HOME until exit.
  t.after(async () => {
    await transport?.stop();
    rmSync(home, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  // Synthetic config, generated entirely by code, written into the throwaway
  // HOME only. The user's real ~/.zcode is never touched.
  mkdirSync(join(home, '.zcode/cli'), { recursive: true });
  writeFileSync(
    join(home, '.zcode/cli/config.json'),
    JSON.stringify(buildSyntheticZcodeConfig(), null, 2),
    { mode: 0o600 },
  );
  // Guard against accidental reliance on the developer's real config: the
  // config we just wrote must contain the synthetic ref and nothing real.
  const written = JSON.parse(
    readFileSync(join(home, '.zcode/cli/config.json'), 'utf8'),
  ) as { model: { main: string } };
  assert.equal(written.model.main, SYNTHETIC_MODEL_REF);

  const childTmp = join(home, 'tmp');
  mkdirSync(childTmp, { recursive: true });
  transport = new ZCodeTransport({
    runtimeBin,
    cwd: workspace,
    // Only the basics: never the developer's credentials or proxy settings.
    env: buildAppServerEnvironment(
      { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8', TMPDIR: childTmp },
      { home, tmpdir: childTmp },
    ),
  });
  const stderrLines: string[] = [];
  transport.on('stderr', (line) => stderrLines.push(String(line)));
  registerGianReverseHandlers(transport);
  transport.start();

  // 1. session/create must succeed against the synthetic config.
  const withStderr = (error: unknown): unknown => {
    if (stderrLines.length > 0 && error instanceof Error) {
      return new Error(`${error.message} | app-server stderr: ${stderrLines.slice(-4).join(' / ')}`);
    }
    return error;
  };
  const created = await transport.request('session/create', {
    workspace: { workspacePath: workspace, workspaceKey: workspace },
  }, 60_000).catch((error: unknown) => {
    throw withStderr(error);
  }) as {
    session?: { sessionId?: string; status?: string };
    protocol?: { name?: string; version?: number };
  } | null;
  assert.ok(created, 'session/create returned a result');
  const sessionId = created.session?.sessionId;
  assert.ok(
    typeof sessionId === 'string' && sessionId.startsWith('sess_'),
    `session/create returned a native session id (got ${String(sessionId)})`,
  );
  assert.equal(created.protocol?.name, INNER_PROTOCOL_NAME);
  assert.equal(created.protocol?.version, INNER_PROTOCOL_VERSION);

  // 2. session/read must succeed for the created session.
  const read = await transport.request('session/read', {
    sessionId,
  }, 30_000).catch((error: unknown) => {
    throw withStderr(error);
  }) as {
    session?: { sessionId?: string; status?: string };
  } | null;
  assert.ok(read, 'session/read returned a result');
  assert.equal(read.session?.sessionId, sessionId);
  assert.equal(read.session?.status, 'idle');

  // 3. Deliberately NO session/send anywhere in this test: the synthetic
  // provider endpoint (127.0.0.1:9) is unreachable, and the lifecycle under
  // test never issues a model request.
  void stderrLines; // surfaced on failure below
});
