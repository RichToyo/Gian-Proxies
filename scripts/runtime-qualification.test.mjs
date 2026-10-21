import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { selectReleaseDefinitions } from './catalog-docs-policy.mjs';

const standalone = existsSync(new URL('./build-managed-runtime-candidates.mjs', import.meta.url));
const builderUrl = new URL(standalone ? './build-managed-runtime-candidates.mjs' : '../../../scripts/build-managed-runtime-candidates.mjs', import.meta.url);
const { withPublishedRuntimeAsset, selectRuntimeProviders } = await import(builderUrl.href);
const { proxyDefinitions } = await import(new URL('./build-proxy-artifacts.mjs', builderUrl).href);

test('the real standalone verifier imports without Host and retains the package-owned probe', async () => {
  const verifierUrl = new URL('./verify-managed-runtime-candidates.mjs', builderUrl);
  const verifier = await import(verifierUrl.href);
  assert.equal(typeof verifier.verifyProxyRuntimeCandidate, 'function');
  assert.doesNotMatch(readFileSync(verifierUrl, 'utf8'), /\bdev-runtime-(?:provision|coordinates)\.[cm]?js(?=['"`?#])/);
  if (standalone) {
    assert.equal(existsSync(new URL('../packages/host', builderUrl)), false);
    assert.doesNotMatch(readFileSync(verifierUrl, 'utf8'), /packages\/host\//);
  }
  assert.ok(existsSync(new URL('./build-antigravity-runtime.mjs', builderUrl)));
});

test('this batch selects only ZCode on signed base Catalog 32 and preserves the other released tuples', () => {
  const selection = JSON.parse(readFileSync(new URL('../release-selection.json', import.meta.url), 'utf8'));
  assert.deepEqual(selection, { schema: 1, providers: ['zcode'], baseCatalogRepository: 'RichLogic/Gian-Proxies', baseCatalogTag: 'catalog-v1.32.0' });
  const selected = selectReleaseDefinitions(proxyDefinitions, selection);
  assert.deepEqual(selected.map(item => item.id), ['zcode']);
  assert.deepEqual(selectRuntimeProviders(selected.map(item => item.id)), ['zcode']);
  assert.equal(selected[0].pluginVersion, '0.4.6');
  assert.deepEqual(selected[0].runtime.verifiedCliVersions, ['0.17.0']);
  for (const id of ['claude', 'codex', 'kimi', 'grok', 'dsh', 'zcode', 'antigravity']) assert.ok(proxyDefinitions.some(item => item.id === id));
});

test('Runtime publication derives its URL and preserves actual candidate digest/size, not invented evidence', () => {
  // Synthetic candidate only; no Runtime, archive, certificate or release is produced.
  const candidate = { provider: 'antigravity', version: '1.4.1', asset: {
    name: 'runtime-fixture.tar.gz', path: '/fixture/runtime.tar.gz', size: 123, sha256: 'a'.repeat(64), publish: false,
  } };
  const result = withPublishedRuntimeAsset(candidate);
  const repository = standalone ? 'RichToyo/Gian-Proxies' : 'RichToyo/Gian';
  assert.equal(result.asset.url, `https://github.com/${repository}/releases/download/proxy-antigravity-v0.0.2/runtime-fixture.tar.gz`);
  assert.equal(result.asset.publish, true);
  assert.equal(result.asset.sha256, candidate.asset.sha256);
  assert.equal(result.asset.size, candidate.asset.size);
  assert.equal(candidate.asset.publish, false);
  assert.throws(() => withPublishedRuntimeAsset({ ...candidate, version: '1.3.0' }), /identity is invalid/);
});

test('hosted qualification and Catalog workflows execute the new regression surfaces without removing existing ones', () => {
  const product = readFileSync(new URL('./release-product.mjs', import.meta.url), 'utf8');
  const workflow = readFileSync(new URL('../.github/workflows/catalog.yml', import.meta.url), 'utf8');
  for (const name of ['scripts/build-managed-runtime-candidates.test.mjs', 'scripts/proxy-release-metadata.test.mjs',
    'scripts/catalog-docs-policy.test.mjs', 'scripts/runtime-qualification.test.mjs']) assert.ok(product.includes(name));
  for (const name of ['catalog/proxy-information/project.test.mjs', 'scripts/catalog-docs-policy.test.mjs', 'scripts/runtime-qualification.test.mjs']) {
    assert.ok(workflow.includes(name));
  }
  assert.ok(product.includes('assertQualifiedRuntime(record, definition, certificate)'));
  assert.ok(product.includes('if (proof) assertSelectedCatalogPlan(previous, sequence, proof)'));
  assert.ok(product.includes('selectedCatalogRecords(inherited.previous, certificate.proxies)'));
});
