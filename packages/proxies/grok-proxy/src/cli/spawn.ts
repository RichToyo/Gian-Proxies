#!/usr/bin/env node

import { isAbsolute } from 'node:path';

import {
  parseProxyArgs,
  readPluginVersion,
  runProxyServer,
  runSelfTest,
  type JsonRpcErrorObject,
} from '@gian/proxy-kit';
import { MAX_NDJSON_LINE_BYTES } from '@gian/proxy-protocol';
import { isRuntimeBootstrapOffer, serveRuntimeBootstrap } from '@gian/proxy-protocol/node';

import { GrokProxyService } from '../core/service.js';
import {
  GrokProtocolV2Adapter,
  PIPELINED_METHODS,
  requestLane,
  standardError,
} from '../protocol/v2-adapter.js';
import { discoverGrokRuntimes, probeGrokRuntime } from '../runtime/discover.js';
import { planRuntimeInstallation } from '../runtime/install.js';
import { GrokFrameLimitError, jsonRpcError } from '../transport/protocol.js';

const PLUGIN_VERSION = readPluginVersion(import.meta.url, '0.4.0');

/**
 * Requests that answer a runtime blocked inside a session request, so they
 * never queue behind that session's lane. A turn blocked on a permission
 * reverse request must still receive interaction.respond, turn.interrupt and
 * turn.steer (native x.ai/interject), and shutdown must not wait for a lane.
 */
const OVERTAKE_METHODS = new Set(['interaction.respond', 'turn.interrupt', 'turn.steer', 'shutdown']);
/** `initialize` runs alone: no session request starts before it settles. */
const BARRIER_METHODS = new Set(['initialize']);

function grokBinary(options: Record<string, string | boolean>): string {
  const grokBin = typeof options['grok-bin'] === 'string'
    ? options['grok-bin']
    : process.env.GIAN_RUNTIME_BIN ?? process.env.GROK_BIN;
  if (!grokBin || !isAbsolute(grokBin)) {
    throw new Error('--grok-bin (or GROK_BIN) must be an absolute managed binary path.');
  }
  return grokBin;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (runSelfTest(argv, { id: 'grok', pluginVersion: PLUGIN_VERSION })) return;
  if (isRuntimeBootstrapOffer()) {
    await serveRuntimeBootstrap({
      installPlan: planRuntimeInstallation,
      pluginId: process.env.GIAN_PLUGIN_ID ?? 'grok',
      pluginName: 'Grok Build',
      pluginVersion: PLUGIN_VERSION,
      processScope: 'session',
      discover: discoverGrokRuntimes,
      probe: probeGrokRuntime,
    });
    return;
  }
  const binaryPath = grokBinary(parseProxyArgs(argv));

  await runProxyServer({
    tag: 'grok-proxy',
    toJsonRpcError: (error) => jsonRpcError(standardError(error)) as JsonRpcErrorObject,
    overtakeMethods: OVERTAKE_METHODS,
    barrierMethods: BARRIER_METHODS,
    pipelinedMethods: PIPELINED_METHODS,
    // Requests are serialized per session; a parent and its Side Chats run
    // side by side.
    laneKey: requestLane,
    // The adapter answers every request itself; a task that rejects instead
    // is broken, so the owned Grok processes are retired.
    failClosedOnDispatchRejection: true,
    writer: {
      maxLineBytes: MAX_NDJSON_LINE_BYTES,
      oversized: () => new GrokFrameLimitError(),
    },
    async createHandler(_emit, emitImmediate) {
      const service = new GrokProxyService({ binaryPath, pluginVersion: PLUGIN_VERSION });
      // The adapter orders its own notifications behind the Responses it
      // writes, per session, so it emits directly.
      const adapter = new GrokProtocolV2Adapter(service, PLUGIN_VERSION, emitImmediate);
      return {
        dispatch: (request, respond) => adapter.dispatch(request, respond),
        close: () => service.close(),
      };
    },
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
