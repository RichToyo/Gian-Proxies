#!/usr/bin/env node

import { isAbsolute } from 'node:path';

import { parseProxyArgs, readPluginVersion, runProxyServer, runSelfTest, type JsonRpcErrorObject } from '@gian/proxy-kit';
import { isRuntimeBootstrapOffer, serveRuntimeBootstrap } from '@gian/proxy-protocol/node';

import { KimiProxyService } from '../core/service.js';
import { KimiProtocolV2Adapter, kimiRequestScope } from '../protocol/v2-adapter.js';
import { discoverKimiRuntimes, probeKimiRuntime } from '../runtime/discover.js';
import { bindKimiCodeHome } from '../runtime/home.js';
import { planRuntimeInstallation } from '../runtime/install.js';
import { jsonRpcError } from '../transport/protocol.js';

/** The artifact carries its own package.json; a missing identity fails
 *  closed instead of reporting a stale default. */
const PLUGIN_VERSION = readPluginVersion(import.meta.url);

/** Requests that answer a runtime blocked inside a session request, so they
 *  never queue behind that session. */
const OVERTAKE_METHODS = new Set(['interaction.respond', 'turn.interrupt', 'shutdown']);
/** `initialize` runs alone: no session request starts before it settles. */
const BARRIER_METHODS = new Set(['initialize']);
/** Customization scans never wait on, or block, session traffic. */
const PIPELINED_METHODS = new Set(['customization.list', 'customization.detail']);

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (runSelfTest(argv, { id: 'kimi', pluginVersion: PLUGIN_VERSION })) return;
  // The Host's Agent home becomes KIMI_CODE_HOME for every reader in this
  // process: Runtime spawn and probe, customization scans and quota.
  bindKimiCodeHome(process.env);
  if (isRuntimeBootstrapOffer()) {
    await serveRuntimeBootstrap({
      installPlan: planRuntimeInstallation,
      pluginId: process.env.GIAN_PLUGIN_ID ?? 'kimi',
      pluginName: 'Kimi Code',
      pluginVersion: PLUGIN_VERSION,
      processScope: 'shared',
      discover: discoverKimiRuntimes,
      probe: probeKimiRuntime,
    });
    return;
  }
  const options = parseProxyArgs(argv);
  const kimiBin = typeof options['kimi-bin'] === 'string'
    ? options['kimi-bin']
    : process.env.GIAN_RUNTIME_BIN ?? process.env.KIMI_BIN;
  if (!kimiBin || !isAbsolute(kimiBin)) {
    throw new Error('--kimi-bin (or KIMI_BIN) must be an absolute managed binary path.');
  }
  const dataDir = process.env.GIAN_PLUGIN_DATA_DIR ?? null;

  await runProxyServer({
    tag: 'kimi-proxy',
    toJsonRpcError: (error) => jsonRpcError(error) as JsonRpcErrorObject,
    overtakeMethods: OVERTAKE_METHODS,
    barrierMethods: BARRIER_METHODS,
    pipelinedMethods: PIPELINED_METHODS,
    // Requests are serialized per session; different sessions run side by side.
    laneKey: (request) => kimiRequestScope(request.params),
    // An adapter whose request task rejects instead of answering is broken:
    // retire the owned `kimi web` rather than keep serving.
    failClosedOnDispatchRejection: true,
    async createHandler(_emit, emitImmediate) {
      // The Kimi local server (`kimi web`) is spawned lazily on the first
      // request that needs it, supervised, and stopped on shutdown.
      const service = new KimiProxyService({ kimiBin, ...(dataDir !== null ? { dataDir } : {}) });
      // The adapter orders its own notifications behind the Responses it
      // writes, per session, so it emits directly.
      const adapter = new KimiProtocolV2Adapter(service, PLUGIN_VERSION, emitImmediate);
      return {
        dispatch: (request, respond) => adapter.dispatch(request, respond),
        close: () => adapter.shutdown(),
      };
    },
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
