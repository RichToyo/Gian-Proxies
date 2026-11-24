#!/usr/bin/env node
/**
 * ai.deepseek.harness — shared-scope gian.proxy/2.1 over gian.dsh.bridge/1.0.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isJsonRpcErrorObject, runProxyServer } from '@gian/proxy-kit';
import { isRuntimeBootstrapOffer, serveRuntimeBootstrap } from '@gian/proxy-protocol/node';
import { planRuntimeInstallation } from '../runtime/install.js';
import { DshV2Adapter, normalizeError } from '../protocol/v2-adapter.js';
import { BridgeClient } from '../runtime/bridge-client.js';
import { discoverDshRuntimes, probeDshRuntime } from '../runtime/discover.js';
import { dshHome, ensureGianProfile } from '../runtime/profile.js';
import { bridgeEnvironment, parseArgs } from './bridge-launch.js';
import { BARRIER_METHODS, OVERTAKE_METHODS, PIPELINED_METHODS, dshLaneKey } from './lanes.js';

function readPluginVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i += 1) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string; version?: string };
      if (pkg.name === '@gian/dsh-proxy' && typeof pkg.version === 'string' && pkg.version.length > 0) return pkg.version;
    } catch { /* keep walking */ }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('DSH Proxy package version is unavailable');
}

const PLUGIN_VERSION = readPluginVersion();

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) {
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 4,
      id: 'ai.deepseek.harness',
      pluginVersion: PLUGIN_VERSION,
      ok: true,
    })}\n`);
    return;
  }
  if (isRuntimeBootstrapOffer()) {
    await serveRuntimeBootstrap({
      installPlan: planRuntimeInstallation,
      pluginId: process.env.GIAN_PLUGIN_ID ?? 'ai.deepseek.harness',
      pluginName: 'DeepSeek Harness',
      pluginVersion: PLUGIN_VERSION,
      processScope: 'shared',
      discover: discoverDshRuntimes,
      probe: probeDshRuntime,
    });
    return;
  }
  const options = parseArgs(argv);
  if (options.managedProfile) {
    const profile = await ensureGianProfile();
    if (profile.actions.length > 0) {
      process.stderr.write(
        `[dsh-proxy] gian profile ${profile.actions.join(', ')} at ${profile.profileDir}\n`,
      );
    }
  }
  const bridge = new BridgeClient({ command: options.bridgeCommand, args: options.args, env: bridgeEnvironment() });
  // Boot DSH and its Bridge handshake now; `initialize` waits for it and
  // reports a failed boot with DSH's own stderr tail.
  bridge.start().catch(() => undefined);
  // A terminating Proxy stops DSH first, so in-flight requests settle at once
  // and the kit's drain does not wait out their timeouts.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => { void bridge.stop(); });
  }

  const adapter = new DshV2Adapter(bridge, {
    pluginVersion: PLUGIN_VERSION,
    dshHome: dshHome(),
    ...(process.env.GIAN_HOST_BINDING_KEY
      ? { hostBindingKey: process.env.GIAN_HOST_BINDING_KEY }
      : {}),
  });

  await runProxyServer({
    tag: 'dsh-proxy',
    toJsonRpcError: (error) => (isJsonRpcErrorObject(error) ? error : normalizeError(error)),
    laneKey: dshLaneKey,
    overtakeMethods: OVERTAKE_METHODS,
    barrierMethods: BARRIER_METHODS,
    pipelinedMethods: PIPELINED_METHODS,
    // The adapter answers every request itself; a rejecting task is a bug.
    failClosedOnDispatchRejection: true,
    async createHandler(_emit, emitImmediate) {
      // The adapter orders each session's notifications behind the Response
      // it writes, so it emits directly.
      adapter.setEmitSink(emitImmediate);
      return {
        async dispatch(request, respond) {
          await adapter.dispatch(request, respond);
        },
        // EOF, shutdown, SIGINT/SIGTERM and crashes all end here: stop the
        // DSH process group (stdin EOF + SIGTERM, then SIGKILL).
        close: () => bridge.stop(),
      };
    },
  });
}

main().catch((error) => {
  process.stderr.write(`[dsh-proxy] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
