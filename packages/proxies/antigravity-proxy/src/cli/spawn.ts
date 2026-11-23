#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { runProxyServer, type JsonRpcErrorObject } from '@gian/proxy-kit';
import { MAX_NDJSON_LINE_BYTES } from '@gian/proxy-protocol';
import { isRuntimeBootstrapOffer, serveRuntimeBootstrap } from '@gian/proxy-protocol/node';

import { AntigravityProxyService } from '../core/service.js';
import { AntigravityProtocolV2Adapter } from '../protocol/v2-adapter.js';
import { AntigravityAcpClient } from '../runtime/acp-client.js';
import { discoverAntigravityRuntimes, probeAntigravityRuntime } from '../runtime/discover.js';
import { planRuntimeInstallation } from '../runtime/install.js';
import { ProtocolError, standardError, validateRequest } from '../transport/protocol.js';

const PLUGIN_ID = 'io.gian.antigravity';

/** Requests that answer a runtime blocked inside a session request, so they
 *  never queue behind that session. */
const OVERTAKE_METHODS = new Set(['interaction.respond', 'turn.interrupt', 'shutdown']);
/** `initialize` runs alone: no session request starts before it settles. */
const BARRIER_METHODS = new Set(['initialize']);

function packageVersion(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth += 1) {
    try {
      const value = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as { name?: string; version?: string };
      if (value.name === '@gian/antigravity-proxy' && value.version) return value.version;
    } catch { /* The bundled and source entrypoints have different depths. */ }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error('Antigravity Proxy package identity is unavailable.');
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'antigravity-bin': { type: 'string' },
      'self-test': { type: 'boolean' },
      authenticate: { type: 'boolean' },
    },
  });
  const version = packageVersion();
  if (values['self-test']) {
    process.stdout.write(`${JSON.stringify({ schemaVersion: 4, id: PLUGIN_ID, pluginVersion: version, ok: true })}\n`);
    return;
  }
  if (isRuntimeBootstrapOffer()) {
    if (values.authenticate) throw new Error('Authentication is not a bootstrap operation.');
    await serveRuntimeBootstrap({
      pluginId: PLUGIN_ID, pluginName: 'Antigravity', pluginVersion: version, processScope: 'shared',
      installPlan: planRuntimeInstallation, discover: discoverAntigravityRuntimes, probe: probeAntigravityRuntime,
    });
    return;
  }
  // Either the `agy` CLI (launched as `agy acp`) or a legacy extracted server.
  const binaryPath = values['antigravity-bin'] ?? process.env.GIAN_RUNTIME_BIN ?? process.env.ANTIGRAVITY_BIN;
  if (!binaryPath || !isAbsolute(binaryPath)) throw new Error('An absolute Antigravity runtime path is required.');
  const runtime = new AntigravityAcpClient({ binaryPath });
  if (values.authenticate) {
    try {
      await runtime.ensureStarted();
      await runtime.authenticate({ methodId: 'oauth-personal' });
      process.stdout.write(`${JSON.stringify({ ok: true, authentication: 'oauth-personal' })}\n`);
    } finally { await runtime.stop(); }
    return;
  }

  await runProxyServer({
    tag: 'antigravity-proxy',
    toJsonRpcError: (error) => standardError(error) as unknown as JsonRpcErrorObject,
    overtakeMethods: OVERTAKE_METHODS,
    barrierMethods: BARRIER_METHODS,
    // Requests are serialized per session; different sessions run side by side.
    laneKey: (request) => (typeof request.params.sessionId === 'string' ? request.params.sessionId : ''),
    // An adapter whose request task rejects instead of answering is broken:
    // retire the owned runtime rather than keep serving.
    failClosedOnDispatchRejection: true,
    writer: {
      maxLineBytes: MAX_NDJSON_LINE_BYTES,
      oversized: () => new ProtocolError('RUNTIME_ERROR', 'Proxy output exceeds the negotiated frame limit.'),
    },
    // Native diagnostics can contain OAuth material, so a crash reports
    // nothing but the fact.
    onCrash: () => {
      process.stderr.write('Antigravity Proxy failed; retiring its owned runtime.\n');
    },
    async createHandler(_emit, emitImmediate) {
      const service = new AntigravityProxyService({ runtime });
      // The adapter orders its own notifications behind the Responses it
      // writes, so it emits directly.
      const adapter = new AntigravityProtocolV2Adapter(service, version, emitImmediate, {
        // Models and quota come from the same `agy` binary as the sessions.
        cliModels: { runtimeBinaryPath: binaryPath },
      });
      return {
        async dispatch(request, respond) {
          let validated;
          try {
            validated = validateRequest({ jsonrpc: '2.0', ...request });
          } catch (error) {
            respond(undefined, error);
            return;
          }
          await adapter.dispatch(validated, respond);
        },
        close: () => adapter.close(),
      };
    },
  });
}

main().catch(() => {
  // Native diagnostics can contain OAuth material. The structured normal
  // request path reports redacted errors; startup failures stay generic.
  process.stderr.write('Antigravity Proxy startup or transport failed.\n');
  process.exitCode = 1;
});
