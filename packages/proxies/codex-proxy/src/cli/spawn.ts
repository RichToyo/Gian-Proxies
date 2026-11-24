#!/usr/bin/env node

import { parseProxyArgs, runProxyServer, runSelfTest, type WireRequest } from '@gian/proxy-kit';
import { MAX_NDJSON_LINE_BYTES } from '@gian/proxy-protocol';
import { isRuntimeBootstrapOffer, serveRuntimeBootstrap } from '@gian/proxy-protocol/node';

import { CodexProxyService } from '../core/service.js';
import { readPluginVersion } from '../plugin-version.js';
import { CodexProtocolV2Adapter, standardError } from '../protocol/v2-adapter.js';
import { CodexAppServerClient } from '../runtime/codex-app-server-client.js';
import { discoverCodexRuntimes, probeCodexRuntime } from '../runtime/discover.js';
import { applyAgentHome } from '../runtime/home.js';
import { planRuntimeInstallation } from '../runtime/install.js';
import { CodexProtocolError, jsonRpcError } from '../transport/protocol.js';
import { requestSessionKeys, SessionNotificationGate } from './notification-gate.js';

const PLUGIN_VERSION = readPluginVersion();

/** Requests that never emit and need no session ordering: they run beside
 *  every session lane, so a slow native-history page, quota read or
 *  customization scan never blocks live session traffic (and vice versa). */
const PIPELINED_METHODS = new Set([
  'customization.list',
  'customization.detail',
  'catalog.list',
  'session.native.list',
  'account.quota.read',
  'runtime.discover',
  'runtime.probe',
]);
/** Requests that answer a turn already running in a session, so they never
 *  queue behind that session's own requests. */
const OVERTAKE_METHODS = new Set(['interaction.respond', 'turn.interrupt', 'shutdown']);
/** `initialize` runs alone: no session request starts before it settles. */
const BARRIER_METHODS = new Set(['initialize']);

/** One lane per session (or the Side Chat a request targets); sessions run
 *  concurrently on the shared app-server. */
function laneKey(request: WireRequest): string {
  return requestSessionKeys(request.params)[0] ?? '';
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (runSelfTest(argv, { id: 'codex', pluginVersion: PLUGIN_VERSION })) return;
  // Map the Host's Agent HOME onto CODEX_HOME before any probe, quota read
  // or app-server child sees the environment.
  applyAgentHome();
  if (isRuntimeBootstrapOffer()) {
    await serveRuntimeBootstrap({
      installPlan: planRuntimeInstallation,
      pluginId: process.env.GIAN_PLUGIN_ID ?? 'codex',
      pluginName: 'Codex',
      pluginVersion: PLUGIN_VERSION,
      processScope: 'shared',
      discover: discoverCodexRuntimes,
      probe: probeCodexRuntime,
    });
    return;
  }
  const options = parseProxyArgs(argv);
  const codexBin = typeof options['codex-bin'] === 'string'
    ? options['codex-bin']
    : process.env.GIAN_RUNTIME_BIN ?? process.env.CODEX_BIN;

  await runProxyServer({
    tag: 'codex-proxy',
    // Service and runtime errors reach the Host with their domain code.
    toJsonRpcError: (error) => jsonRpcError(standardError(error)),
    pipelinedMethods: PIPELINED_METHODS,
    overtakeMethods: OVERTAKE_METHODS,
    barrierMethods: BARRIER_METHODS,
    laneKey,
    // A request task that rejects instead of answering means the adapter is
    // broken: retire the shared app-server rather than keep serving.
    failClosedOnDispatchRejection: true,
    writer: {
      maxLineBytes: MAX_NDJSON_LINE_BYTES,
      oversized: () => new CodexProtocolError('RUNTIME_ERROR', 'Proxy output exceeds the negotiated frame limit.'),
    },
    async createHandler(_emit, emitImmediate) {
      const runtime = new CodexAppServerClient(codexBin ? { codexBin } : {});
      const service = new CodexProxyService({ runtime });
      // The adapter's notifications are ordered per session by the gate,
      // not by the kit's process-wide hold.
      const gate = new SessionNotificationGate(emitImmediate);
      const adapter = new CodexProtocolV2Adapter(
        service,
        PLUGIN_VERSION,
        (method, params) => gate.emit(method, params),
      );
      await service.initialize();
      return {
        async dispatch(request, respond) {
          const keys = requestSessionKeys(request.params);
          const release = gate.hold(keys);
          try {
            let result: unknown;
            try {
              result = await adapter.handle(request);
            } catch (error) {
              respond(undefined, error);
              return;
            }
            if (request.method === 'sidechat.close') gate.flush(keys);
            respond(result);
          } finally {
            // Held notifications follow the Response they belong behind.
            release();
          }
        },
        close: async () => {
          await adapter.close();
          await service.close();
        },
      };
    },
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
