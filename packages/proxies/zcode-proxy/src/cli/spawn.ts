#!/usr/bin/env node
/**
 * com.zhipu.zcode — shared-scope gian.proxy/2.1 over ZCode Protocol v1.
 *
 * The Host spawns this entry with:
 *   GIAN_RUNTIME_BIN      path to the managed ZCode CLI Runtime (zcode.cjs)
 *   GIAN_PLUGIN_DATA_DIR  plugin-owned data dir (identity mapping, 0600 files)
 *   GIAN_PLUGIN_ID        must equal com.zhipu.zcode
 *
 * The wire loop is @gian/proxy-kit: requests are serialized per Gian session
 * and run concurrently across sessions and workspaces; interaction.respond,
 * turn.interrupt and shutdown overtake a blocked session request; initialize
 * is a barrier. The Shared Service owns notification order (each session's
 * notifications follow the Responses of that session's in-flight requests)
 * and writes through emitImmediate.
 *
 * Environment: the app-server receives this process's environment (SHELL,
 * HTTPS_PROXY/NO_PROXY, user PATH, locale) minus Gian internals, with the
 * Host's HOME contract (buildAppServerEnvironment).
 */

import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { isJsonRpcErrorObject, runProxyServer, type JsonRpcErrorObject } from '@gian/proxy-kit';
import { MAX_NDJSON_LINE_BYTES } from '@gian/proxy-protocol';
import { isRuntimeBootstrapOffer, serveRuntimeBootstrap } from '@gian/proxy-protocol/node';

import { planRuntimeInstallation } from '../runtime/install.js';
import { DEFAULT_IDLE_TIMEOUT_MS, ZcodeSharedService } from '../service.js';
import { PLUGIN_ID, PLUGIN_NAME, PLUGIN_VERSION } from '../identity.js';
import {
  builtinProviderConfigCandidates,
  discoverZcodeRuntimes,
  locateBuiltinProviderConfig,
  probeZcodeRuntime,
} from '../runtime/discover.js';
import { buildAppServerEnvironment, redactSecrets } from '../inner/transport.js';

/** Requests that answer a runtime blocked inside a session request. */
const OVERTAKE_METHODS = new Set(['interaction.respond', 'turn.interrupt', 'shutdown']);
/** `initialize` runs alone: no other request starts before it settles. */
const BARRIER_METHODS = new Set(['initialize']);

function selfTest(): void {
  // Verify the module graph loads and the wire constants are coherent.
  if (PLUGIN_ID !== 'com.zhipu.zcode') throw new Error('plugin id drifted');
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 4,
    id: PLUGIN_ID,
    pluginVersion: PLUGIN_VERSION,
    ok: true,
  })}\n`);
}

function idleTimeoutFromEnv(): number {
  const raw = process.env.GIAN_ZCODE_IDLE_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_IDLE_TIMEOUT_MS;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : DEFAULT_IDLE_TIMEOUT_MS;
}

/** Errors leave the adapters as ready-made JSON-RPC objects; anything else
 *  is an internal failure with redacted text. */
function toJsonRpcError(error: unknown): JsonRpcErrorObject {
  if (isJsonRpcErrorObject(error)) return error;
  return {
    code: -32603,
    message: String(redactSecrets(error instanceof Error ? error.message : String(error))),
  } as JsonRpcErrorObject;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) {
    selfTest();
    return;
  }
  if (isRuntimeBootstrapOffer()) {
    await serveRuntimeBootstrap({
      installPlan: planRuntimeInstallation,
      pluginId: process.env.GIAN_PLUGIN_ID ?? PLUGIN_ID,
      pluginName: PLUGIN_NAME,
      pluginVersion: PLUGIN_VERSION,
      processScope: 'shared',
      discover: discoverZcodeRuntimes,
      probe: probeZcodeRuntime,
    });
    return;
  }

  const runtimeBin = process.env.GIAN_RUNTIME_BIN;
  if (runtimeBin === undefined || runtimeBin === '') {
    throw new Error('zcode-proxy requires GIAN_RUNTIME_BIN pointing at the managed ZCode CLI entry.');
  }
  if (process.env.GIAN_PLUGIN_ID !== undefined && process.env.GIAN_PLUGIN_ID !== PLUGIN_ID) {
    throw new Error(`zcode-proxy expects plugin id ${PLUGIN_ID}, received ${process.env.GIAN_PLUGIN_ID}.`);
  }
  const dataDir = process.env.GIAN_PLUGIN_DATA_DIR ?? null;

  // Pre-spawn diagnostic: a missing builtin provider config makes the inner
  // app-server exit before answering anything. Warn once with the checked
  // paths; initialize then fails with the app-server's own stderr.
  if (await locateBuiltinProviderConfig(resolve(runtimeBin)) === null) {
    const [near, up] = builtinProviderConfigCandidates(resolve(runtimeBin));
    process.stderr.write(
      `[zcode-proxy:runtime] builtin provider config not found (checked ${near}, ${up}); `
      + 'reinstall the complete certified ZCode CLI Runtime package.\n',
    );
  }

  await runProxyServer({
    tag: 'zcode-proxy',
    toJsonRpcError,
    overtakeMethods: OVERTAKE_METHODS,
    barrierMethods: BARRIER_METHODS,
    // One lane per Gian session; a fork is serialized with its source.
    // Session-less requests (catalog, native list, customization) share one.
    laneKey: (request) => {
      const params = request.params as Record<string, unknown>;
      const id = request.method === 'session.fork' ? params.sourceSessionId : params.sessionId;
      return typeof id === 'string' ? `session:${id}` : '';
    },
    // A request task that rejects instead of answering means the adapter is
    // broken: retire the app-servers rather than keep serving.
    failClosedOnDispatchRejection: true,
    writer: { maxLineBytes: MAX_NDJSON_LINE_BYTES },
    // Native diagnostics can carry provider details; report only the fact.
    onCrash: (kind, error) => {
      process.stderr.write(`[zcode-proxy:${kind}] ${String(redactSecrets(error instanceof Error ? error.message : String(error)))}\n`);
    },
    async createHandler(_emit, emitImmediate) {
      const service = new ZcodeSharedService({
        runtimeBin,
        dataDir,
        catalogWorkspace: dataDir ?? tmpdir(),
        interactionEnabled: process.env.GIAN_ZCODE_DISABLE_INTERACTION !== '1',
        env: buildAppServerEnvironment(process.env, { home: process.env.HOME ?? '', tmpdir: tmpdir() }),
        idleTimeoutMs: idleTimeoutFromEnv(),
        // Test seam: shorten the interrupt confirmation deadline.
        ...(Number(process.env.GIAN_ZCODE_INTERRUPT_DEADLINE_MS) > 0
          ? { interruptDeadlineMs: Number(process.env.GIAN_ZCODE_INTERRUPT_DEADLINE_MS) } : {}),
        onStderr: (_runtimeKey, line) => {
          process.stderr.write(`[zcode-proxy:app-server] ${String(line)}\n`);
        },
        onDiagnostic: (_runtimeKey, info) => {
          process.stderr.write(`[zcode-proxy:inner] ${JSON.stringify(info)}\n`);
        },
      });
      // The service orders notifications behind the Responses it writes.
      service.setEmitSink((notification) => emitImmediate(notification.method, notification.params));
      return {
        dispatch: (request, respond) => service.dispatchOrdered({
          id: request.id,
          method: request.method,
          params: (request.params ?? {}) as Record<string, unknown>,
        }, respond),
        close: () => service.close(),
      };
    },
  });
}

main().catch((error) => {
  process.stderr.write(`[zcode-proxy] ${String(redactSecrets(error instanceof Error ? error.message : String(error)))}\n`);
  process.exit(1);
});
