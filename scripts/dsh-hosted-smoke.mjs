import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runDshBridgeCanary } from './run-dsh-bridge-canary.mjs';
import { runDshProxyCanary } from './run-dsh-proxy-canary.mjs';
import { extractManagedRuntimeArchive } from '../support/runtime-extractor/dist/safe-extract.js';

const root = resolve('.');
const candidate = JSON.parse(await readFile(join(root, 'artifacts/runtimes/runtime-candidates.json'), 'utf8'))
  .candidates.find(item => item.provider === 'dsh');
assert.ok(candidate);
const bytes = await readFile(join(root, 'artifacts/runtimes', candidate.asset.name));
const sha256 = createHash('sha256').update(bytes).digest('hex');
assert.equal(bytes.length, candidate.asset.size);
assert.equal(sha256, candidate.asset.sha256);
const coordinates = JSON.parse(await readFile(join(root, 'support/runtime-extractor/dev-runtime-coordinates.json'), 'utf8'));
const coordinate = coordinates.find(item => item.pluginId === 'ai.deepseek.harness');
assert.equal(coordinate.version, candidate.version);
assert.equal(coordinate.asset.sha256, sha256);
assert.equal(coordinate.asset.size, bytes.length);
const temporary = await mkdtemp(join(tmpdir(), 'gian-dsh-hosted-'));
try {
  const history = JSON.parse(await readFile(join(root, 'catalog/proxy-information/evidence/current-combinations.json'), 'utf8'));
  const baseline = history.plugins.find(item => item.id === 'ai.deepseek.harness')?.combination?.runtime;
  assert.equal(baseline?.version, '0.2.2-rc.1');
  const baseUrl = new URL(baseline.asset.url);
  assert.equal(baseUrl.origin, 'https://github.com');
  const parts = baseUrl.pathname.split('/');
  assert.deepEqual(parts.slice(1, 5), ['RichToyo', 'Gian-Proxies', 'releases', 'download']);
  const tag = parts[5];
  const filename = parts[6];
  assert.ok(tag && filename && parts.length === 7);
  execFileSync('gh', ['release', 'download', tag, '--repo', 'RichToyo/Gian-Proxies', '--pattern', filename, '--dir', temporary], { timeout: 180000, stdio: 'inherit' });
  const baselineBytes = await readFile(join(temporary, filename));
  assert.equal(baselineBytes.length, baseline.asset.size);
  assert.equal(createHash('sha256').update(baselineBytes).digest('hex'), baseline.asset.sha256);
  const oldRuntime = join(temporary, 'baseline');
  await extractManagedRuntimeArchive(baselineBytes, oldRuntime);
  const oldBridge = await runDshBridgeCanary({ binaryPath: join(oldRuntime, baseline.entryRelativePath) });
  assert.equal(oldBridge.runtime.version, baseline.version);
  assert.equal(oldBridge.quotaConsuming, false);
  const runtime = join(temporary, 'runtime');
  await extractManagedRuntimeArchive(bytes, runtime);
  const binaryPath = join(runtime, candidate.entryRelativePath);
  const sdkDir = join(runtime, 'node_modules/@modelcontextprotocol/client/dist');
  const sdk = await import(pathToFileURL(join(sdkDir, 'index.mjs')).href);
  const stdio = await import(pathToFileURL(join(sdkDir, 'stdio.mjs')).href);
  assert.equal(typeof sdk.Client, 'function');
  assert.equal(typeof sdk.StreamableHTTPClientTransport, 'function');
  assert.ok(sdk.specTypeSchemas.CallToolResult);
  assert.equal(typeof stdio.StdioClientTransport, 'function');
  const redirects = [];
  const transport = new sdk.StreamableHTTPClientTransport(new URL('https://trusted.invalid/mcp'), {
    fetch: async (url, init) => {
      redirects.push({ url: String(url), redirect: init?.redirect });
      return new Response(null, { status: 307, headers: { location: 'https://untrusted.invalid/capture' } });
    },
    requestInit: { headers: { 'X-API-Key': 'fixture-only' } },
  });
  transport.onerror = () => {};
  await transport.start();
  try {
    await assert.rejects(transport.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
    assert.equal(redirects.length, 1);
    assert.equal(redirects[0].redirect, 'manual');
  } finally { await transport.close(); }
  const response = await fetch('https://registry.npmjs.org/@deepseek-ai/dsh-llm-mock-server/-/dsh-llm-mock-server-0.2.2-rc.2.tgz', { signal: AbortSignal.timeout(120000) });
  assert.ok(response.ok, `Official mock fixture download failed: ${response.status}`);
  const fixture = Buffer.from(await response.arrayBuffer());
  assert.equal(createHash('sha512').update(fixture).digest('base64'), 'txqzOAkNrvoxg0NUoruqM6/ojN7d6WfdptlZfJUMqRPHktyqFtWlMjbzP0rOAsAZEdrNtz/c5BzhWecsJnsPYw==');
  const archive = join(temporary, 'mock.tgz');
  const mockServerPath = join(temporary, 'mock-server.mjs');
  await writeFile(archive, fixture);
  const moduleBytes = execFileSync('/usr/bin/tar', ['-xOzf', archive, 'package/lib/index.js'], { maxBuffer: 1024 * 1024 });
  await writeFile(mockServerPath, moduleBytes);
  const bridge = await runDshBridgeCanary({ binaryPath });
  const proxy = await runDshProxyCanary({ binaryPath, mockServerPath });
  assert.equal(bridge.runtime.version, candidate.version);
  assert.equal(proxy.runtime.version, candidate.version);
  assert.equal(bridge.quotaConsuming, false);
  assert.equal(proxy.quotaConsuming, false);
  assert.ok(proxy.mockLlm.requests > 0);
  const evidence = { status: 'PASS', runtime: candidate.version, runtimeSha256: sha256,
    baselineRuntime: baseline.version, baselineRuntimeSha256: baseline.asset.sha256,
    baselineBridgeLifecycle: oldBridge.lifecycle,
    bridgeLifecycle: bridge.lifecycle, proxyLifecycle: proxy.lifecycle,
    mcpExports: 'PASS', mcpCrossOriginRedirect: 'REJECTED',
    mockProviderRequests: proxy.mockLlm.requests, realProviderTurns: 'NOT_RUN',
    baselineResidualProcesses: oldBridge.processTree.residualProcesses,
    bridgeResidualProcesses: bridge.processTree.residualProcesses,
    proxyResidualProcesses: proxy.processTree.residualProcesses };
  await writeFile(join(root, 'artifacts/release/dsh-native-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify(evidence));
} finally { await rm(temporary, { recursive: true, force: true }); }
