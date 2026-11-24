import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { zcodeRuntimeSource } from './zcode-runtime-source.mjs';

// This source-reviewed overlay belongs to the Proxy release, not upstream.
// Its exact input hash makes upstream upgrades fail closed until re-reviewed.
export const entrypointSha256 = zcodeRuntimeSource.protocolEntrypointSha256;
export const integrationVersion = zcodeRuntimeSource.integrationVersion;

export function integrateZcodeEntrypoint(original) {
  if (createHash('sha256').update(original).digest('hex') !== entrypointSha256) {
    throw new Error('ZCode protocol entrypoint differs from the reviewed integration source.');
  }
  return applyZcodeIntegrationEdits(original);
}

export function applyZcodeIntegrationEdits(original) {
  let text = original;
  const replace = (before, after) => {
    if (text.split(before).length !== 2) throw new Error('ZCode integration anchor is missing or ambiguous.');
    text = text.replace(before, after);
  };
  // app-server normally expects an Electron Host to supply account overlays.
  // Use the very same standalone lifecycle as the upstream Prompt CLI/TUI.
  replace('create: () => startProcessProviderRegistryRuntime(runtimeEnv),',
    'create: () => startProcessProviderRegistryRuntime(runtimeEnv, { standalone: {} }),');
  replace('          env: {\n            ...telemetryEnv,',
    '          ...(activeProviderRegistryRuntime.providerRuntimeHeadersPort\n'
    + '            ? { providerRuntimeHeadersPort: activeProviderRegistryRuntime.providerRuntimeHeadersPort } : {}),\n'
    + '          env: {\n            ...telemetryEnv,');
  // 3.18 encrypts credentials.json with a system key-store key and sends the
  // app-server's MCP OAuth store through interaction/requestCredentialCipher,
  // because ZCode Desktop's main process owns that key. Gian has no such
  // owner: the standalone lifecycle above already decrypts with the
  // in-process system cipher, as the upstream Prompt CLI/TUI MCP pool does
  // (createSharedZCodeCredentialStore() with its default cipher).
  replace('      cipher: credentialCipherBridge.cipher,\n',
    '      // Gian: standalone in-process credential cipher, as in the upstream Prompt CLI/TUI.\n');
  replace('      handleMessage: (message) => server.handleMessage(message),', `      handleMessage: async (message) => {
        if ("id" in message && "method" in message && message.method === "gian/modelCatalog") {
          try {
            await activeProviderRegistryRuntime.runtime.registryService.refresh("gian-model-catalog");
            const preferred = await activeProviderRegistryRuntime.modelSelectionConfigRepository.read();
            return { id: message.id, result: serializeModelCatalog(modelSelectionFacade.getView(preferred)) };
          } catch (error) {
            // Keep the Registry's own reason, but only one bounded line with
            // key-like tokens masked: config errors can echo values.
            const reason = (String(error instanceof Error ? error.message : error).split(/\\r?\\n/)[0] ?? "")
              .replace(/\\b(?:sk|pk|ak)-[A-Za-z0-9_-]{6,}/g, "[redacted]")
              .replace(/[A-Za-z0-9+=_-]{32,}/g, "[redacted]")
              .slice(0, 300);
            return { id: message.id, error: { code: -32603, message: reason
              ? "ZCode model catalog is unavailable: " + reason : "ZCode model catalog is unavailable" } };
          }
        }
        return server.handleMessage(message);
      },`);
  return '// Modified by Gian: standalone Provider lifecycle and credential cipher, metadata-only model catalog.\n'
    + 'import { serializeModelCatalog } from "./gian-model-catalog.js";\n' + text;
}

export async function installZcodeIntegration(checkout) {
  const path = join(checkout, 'apps/zcode-cli/packages/bootstrap/src/zcode-protocol-entrypoint.ts');
  const original = await readFile(path, 'utf8');
  const integrated = integrateZcodeEntrypoint(original);
  const projection = await readFile(new URL('../packages/proxies/zcode-proxy/src/runtime/model-catalog.ts', import.meta.url));
  await writeFile(join(checkout, 'apps/zcode-cli/packages/bootstrap/src/gian-model-catalog.ts'), projection, { flag: 'wx' });
  await writeFile(path, integrated);
  return {
    schemaVersion: integrationVersion,
    upstreamEntrypointSha256: entrypointSha256,
    integratedEntrypointSha256: createHash('sha256').update(integrated).digest('hex'),
    catalogProjectionSha256: createHash('sha256').update(projection).digest('hex'),
  };
}
