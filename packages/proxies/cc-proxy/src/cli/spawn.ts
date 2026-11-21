#!/usr/bin/env node

import { readPluginVersion, runProxyServer, runSelfTest } from '@gian/proxy-kit';
import { isRuntimeBootstrapOffer, serveRuntimeBootstrap } from '@gian/proxy-protocol/node';
import { planRuntimeInstallation } from '../runtime/install.js';

import { CcProxyService } from '../core/service.js';
import { ClaudeProtocolV2Adapter } from '../protocol/v2-adapter.js';
import { ClaudeStreamRuntime } from '../runtime/claude-stream-runtime.js';
import { discoverClaudeRuntimes, probeClaudeRuntime } from '../runtime/discover.js';
import { jsonRpcError } from '../transport/protocol.js';

const PLUGIN_VERSION = readPluginVersion(import.meta.url, '0.4.1');

// Customization scans are pipelined (never await each other) so every kind
// of an aggregate inspection is answered within its own bound: a slow kind
// must not queue the remaining kinds behind it and push them past the Host
// per-request timeout. Session requests (including shutdown) stay serialized.
const PIPELINED_METHODS = new Set(['customization.list', 'customization.detail']);

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (runSelfTest(argv, { id: 'claude', pluginVersion: PLUGIN_VERSION })) return;
  if (isRuntimeBootstrapOffer()) {
    await serveRuntimeBootstrap({
      installPlan: planRuntimeInstallation,
      pluginId: process.env.GIAN_PLUGIN_ID ?? 'claude',
      pluginName: 'Claude Code',
      pluginVersion: PLUGIN_VERSION,
      processScope: 'session',
      discover: discoverClaudeRuntimes,
      probe: probeClaudeRuntime,
    });
    return;
  }
  // `--data-dir` is ignored. The proxy is stateless; Host may still pass it.
  if (process.env.GIAN_RUNTIME_BIN) {
    process.env.CLAUDE_BIN = process.env.GIAN_RUNTIME_BIN;
  }

  await runProxyServer({
    tag: 'cc-proxy',
    toJsonRpcError: jsonRpcError,
    pipelinedMethods: PIPELINED_METHODS,
    async createHandler(emit) {
      const runtime = new ClaudeStreamRuntime();
      const service = new CcProxyService({ runtime });
      const adapter = new ClaudeProtocolV2Adapter(service, PLUGIN_VERSION, emit);
      await service.initialize();
      return {
        async handle(request) {
          try {
            return await adapter.handle(request);
          } finally {
            // The adapter defers what it produced while handling; releasing it
            // into the kit's ordered emitter keeps it behind this Response.
            adapter.flushDeferredNotifications();
          }
        },
        close: () => service.close(),
      };
    },
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
