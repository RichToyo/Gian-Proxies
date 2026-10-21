import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_ARTIFACT_REPOSITORIES,
  DEFAULT_RUNTIME_ASSET_PREFIXES,
  LEGACY_OFFICIAL_APP_REPOSITORY,
  LEGACY_OFFICIAL_PROXY_REPOSITORY,
  MAX_CATALOG_DOCUMENT_BYTES,
  OFFICIAL_APP_REPOSITORY,
  OFFICIAL_PROXY_REPOSITORY,
  compileOfficialCatalogSource,
  ephemeralCatalogSigningKey,
  loadOfficialCatalogSource,
  verifyOfficialCatalogSource,
  type OfficialCatalogSourcePlugin,
} from '../src/index.js';

function officialSourceRoot(): string {
  const fromSrc = fileURLToPath(new URL('../../../catalog/official-source', import.meta.url));
  const fromDist = fileURLToPath(new URL('../../../../catalog/official-source', import.meta.url));
  return existsSync(fromSrc) ? fromSrc : fromDist;
}

async function copyOfficialSource(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'gian-official-source-'));
  await cp(officialSourceRoot(), root, { recursive: true });
  return root;
}

test('installable official-source coordinates compile when they satisfy the URL policy', async () => {
  const root = await copyOfficialSource();
  try {
    const sidecar = await readFile(join(root, 'plugins', 'claude', 'sidecar.json'));
    const entryPath = join(root, 'plugins', 'claude', 'entry.json');
    const entry = JSON.parse(await readFile(entryPath, 'utf8')) as {
      channels: { stable: Record<string, unknown> };
    };
    entry.channels.stable.manifest = {
      url: 'https://github.com/RichLogic/Gian/releases/download/proxy-claude-v0.2.4/gian-proxy-claude-0.2.4-darwin-arm64.tar.gz.manifest.json',
      sha256: createHash('sha256').update(sidecar).digest('hex'),
      size: sidecar.byteLength,
    };
    entry.channels.stable.artifacts = {
      'darwin-arm64': {
        url: 'https://github.com/RichLogic/Gian/releases/download/proxy-claude-v0.2.4/gian-proxy-claude-0.2.4-darwin-arm64.tar.gz',
        sha256: createHash('sha256').update('archive').digest('hex'),
        size: 1234,
      },
    };
    await writeFile(entryPath, `${JSON.stringify(entry, null, 2)}\n`);
    const plugins = await loadOfficialCatalogSource(root);
    verifyOfficialCatalogSource(plugins);
    const bundle = await compileOfficialCatalogSource({
      sourceRoot: root,
      sequence: 9,
      issuedAt: '2026-09-03T00:00:00.000Z',
      signingKey: ephemeralCatalogSigningKey(),
    });
    const claude = bundle.index.plugins.find((plugin) => plugin.pluginId === 'claude');
    assert.ok(claude?.stable.manifest);
    assert.ok(claude?.stable.artifacts['darwin-arm64']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('official source rejects symlink escape, undeclared files, duplicates, and oversized docs', async () => {
  const root = await copyOfficialSource();
  try {
    const plugin = join(root, 'plugins', 'claude');
    await unlink(join(plugin, 'overview.md'));
    await symlink('/etc/passwd', join(plugin, 'overview.md'));
    await assert.rejects(loadOfficialCatalogSource(root), /symlink/);

    await unlink(join(plugin, 'overview.md'));
    await writeFile(join(plugin, 'overview.md'), '# Overview\n');
    await writeFile(join(plugin, 'extra.bin'), 'undeclared');
    await assert.rejects(loadOfficialCatalogSource(root), /undeclared file/);
    await unlink(join(plugin, 'extra.bin'));

    const entryPath = join(plugin, 'entry.json');
    const entry = JSON.parse(await readFile(entryPath, 'utf8')) as {
      documentation: Record<string, string>;
    };
    entry.documentation.setup = 'overview.md';
    await writeFile(entryPath, `${JSON.stringify(entry, null, 2)}\n`);
    await assert.rejects(loadOfficialCatalogSource(root), /duplicate path/);
    entry.documentation.setup = 'setup.md';
    await writeFile(entryPath, `${JSON.stringify(entry, null, 2)}\n`);

    await writeFile(join(plugin, 'overview.md'), `${'A'.repeat(MAX_CATALOG_DOCUMENT_BYTES + 1)}\n`);
    await assert.rejects(loadOfficialCatalogSource(root), /exceeds size bound/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('official source rejects a special file when the platform can create one', async () => {
  const root = await copyOfficialSource();
  try {
    const fifo = join(root, 'plugins', 'claude', 'extra.fifo');
    const created = spawnSync('mkfifo', [fifo], { encoding: 'utf8' });
    if (created.status !== 0) {
      return;
    }
    await assert.rejects(loadOfficialCatalogSource(root), /special file|undeclared/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const NON_SENTINEL_SHA256 = '0123456789abcdef'.repeat(4);

function releaseAssetUrl(repository: string, asset: string): string {
  return `https://github.com/${repository}/releases/download/proxy-claude-v0.2.4/${asset}`;
}

function pluginsWithClaudeRelease(
  source: readonly OfficialCatalogSourcePlugin[],
  manifestUrl: string,
  artifactUrl: string,
  runtimeUrl?: string,
): OfficialCatalogSourcePlugin[] {
  return source.map((plugin) => {
    if (plugin.entry.pluginId !== 'claude') return plugin;
    const entry = structuredClone(plugin.entry);
    entry.channels.stable.manifest = {
      url: manifestUrl,
      sha256: NON_SENTINEL_SHA256,
      size: 32,
    };
    entry.channels.stable.artifacts = {
      'darwin-arm64': {
        url: artifactUrl,
        sha256: NON_SENTINEL_SHA256,
        size: 32,
      },
    };
    if (runtimeUrl) {
      entry.channels.stable.combination = {
        generationId: 'claude-generation',
        certificate: { id: 'claude-certificate', sha256: NON_SENTINEL_SHA256 },
        runtime: {
          kind: 'native-binary',
          runtimeId: 'claude',
          version: '1.0.0',
          asset: { url: runtimeUrl, sha256: NON_SENTINEL_SHA256, size: 32 },
          format: 'raw',
          entryRelativePath: 'claude',
        },
        companions: [],
      };
    }
    return { ...plugin, entry };
  });
}

async function writeClaudeRelease(root: string, repository: string): Promise<void> {
  const sidecar = await readFile(join(root, 'plugins', 'claude', 'sidecar.json'));
  const entryPath = join(root, 'plugins', 'claude', 'entry.json');
  const entry = JSON.parse(await readFile(entryPath, 'utf8')) as {
    channels: { stable: Record<string, unknown> };
  };
  entry.channels.stable.manifest = {
    url: releaseAssetUrl(repository, 'gian-proxy-claude-0.2.4-darwin-arm64.tar.gz.manifest.json'),
    sha256: createHash('sha256').update(sidecar).digest('hex'),
    size: sidecar.byteLength,
  };
  entry.channels.stable.artifacts = {
    'darwin-arm64': {
      url: releaseAssetUrl(repository, 'gian-proxy-claude-0.2.4-darwin-arm64.tar.gz'),
      sha256: createHash('sha256').update('archive').digest('hex'),
      size: 1234,
    },
  };
  await writeFile(entryPath, `${JSON.stringify(entry, null, 2)}\n`);
}

test('official compile and verify defaults accept the new and legacy release repositories', async () => {
  assert.deepEqual(DEFAULT_ARTIFACT_REPOSITORIES, [
    OFFICIAL_PROXY_REPOSITORY,
    OFFICIAL_APP_REPOSITORY,
    LEGACY_OFFICIAL_PROXY_REPOSITORY,
    LEGACY_OFFICIAL_APP_REPOSITORY,
  ]);
  assert.deepEqual([
    OFFICIAL_PROXY_REPOSITORY,
    OFFICIAL_APP_REPOSITORY,
    LEGACY_OFFICIAL_PROXY_REPOSITORY,
    LEGACY_OFFICIAL_APP_REPOSITORY,
  ], [
    'RichToyo/Gian-Proxies',
    'RichToyo/Gian',
    'RichLogic/Gian-Proxies',
    'RichLogic/Gian',
  ]);
  assert.deepEqual(DEFAULT_RUNTIME_ASSET_PREFIXES, [
    'https://downloads.claude.ai/claude-code-releases/',
    'https://github.com/openai/codex/releases/download/',
    'https://github.com/MoonshotAI/kimi-code/releases/download/',
    'https://github.com/MoonshotAI/kimi-cli/releases/download/',
    'https://github.com/RichToyo/Gian-Proxies/releases/download/',
    'https://github.com/RichToyo/Gian/releases/download/',
    'https://github.com/RichLogic/Gian-Proxies/releases/download/',
    'https://github.com/RichLogic/Gian/releases/download/',
    'https://x.ai/cli/',
  ]);

  const source = await loadOfficialCatalogSource(officialSourceRoot());
  const legacyArtifact = releaseAssetUrl(
    LEGACY_OFFICIAL_APP_REPOSITORY,
    'gian-proxy-claude-0.2.4-darwin-arm64.tar.gz',
  );
  for (const repository of DEFAULT_ARTIFACT_REPOSITORIES) {
    const url = releaseAssetUrl(repository, 'gian-proxy-claude-0.2.4-darwin-arm64.tar.gz');
    verifyOfficialCatalogSource(pluginsWithClaudeRelease(source, url, url));
  }
  for (const prefix of DEFAULT_RUNTIME_ASSET_PREFIXES) {
    verifyOfficialCatalogSource(pluginsWithClaudeRelease(
      source,
      legacyArtifact,
      legacyArtifact,
      `${prefix}claude`,
    ));
  }
  for (const repository of ['untrusted/Gian-Proxies', 'someone-else/Gian-Proxies', 'RichLogic/Gian-Proxy-Catalog']) {
    const url = releaseAssetUrl(repository, 'gian-proxy-claude-0.2.4-darwin-arm64.tar.gz');
    assert.throws(
      () => verifyOfficialCatalogSource(pluginsWithClaudeRelease(source, url, url)),
      /allowed artifact URL/,
    );
    assert.throws(
      () => verifyOfficialCatalogSource(pluginsWithClaudeRelease(
        source,
        legacyArtifact,
        legacyArtifact,
        releaseAssetUrl(repository, 'runtime'),
      )),
      /allowed artifact URL/,
    );
  }

  const root = await copyOfficialSource();
  try {
    await writeClaudeRelease(root, OFFICIAL_PROXY_REPOSITORY);
    const bundle = await compileOfficialCatalogSource({
      sourceRoot: root,
      sequence: 9,
      issuedAt: '2026-09-03T00:00:00.000Z',
      signingKey: ephemeralCatalogSigningKey(),
    });
    const claude = bundle.index.plugins.find((plugin) => plugin.pluginId === 'claude');
    assert.equal(
      claude?.stable.manifest?.url,
      releaseAssetUrl(OFFICIAL_PROXY_REPOSITORY, 'gian-proxy-claude-0.2.4-darwin-arm64.tar.gz.manifest.json'),
    );
    await writeClaudeRelease(root, 'RichLogic/Gian-Proxy-Catalog');
    await assert.rejects(compileOfficialCatalogSource({
      sourceRoot: root,
      sequence: 9,
      issuedAt: '2026-09-03T00:00:00.000Z',
      signingKey: ephemeralCatalogSigningKey(),
    }), /allowed artifact URL/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('production official source stays documentation-only', async () => {
  const plugins = await loadOfficialCatalogSource(officialSourceRoot());
  verifyOfficialCatalogSource(plugins);
  for (const plugin of plugins) {
    assert.equal(plugin.entry.channels.stable.manifest, undefined);
    assert.equal(
      Object.values(plugin.entry.channels.stable.artifacts ?? {}).some(Boolean),
      false,
    );
  }
});

test('Antigravity source follows its Manifest and has complete docs without invented release coordinates', async () => {
  const plugins = await loadOfficialCatalogSource(officialSourceRoot());
  verifyOfficialCatalogSource(plugins);
  const plugin = plugins.find(item => item.entry.pluginId === 'io.gian.antigravity');
  assert.ok(plugin);
  const manifest = JSON.parse(await readFile(join(officialSourceRoot(), 'plugins', 'io.gian.antigravity', 'sidecar.json'), 'utf8'));
  assert.equal(manifest.id, 'io.gian.antigravity');
  assert.equal(plugin.entry.channels.stable.pluginVersion, manifest.pluginVersion);
  assert.notEqual(plugin.entry.branding.logoLight.path, plugin.entry.branding.logoDark.path);
  assert.equal(plugin.entry.channels.stable.manifest, undefined);
  assert.equal(plugin.entry.channels.stable.combination, undefined);
  for (const document of Object.values(plugin.documents)) assert.ok(document.byteLength > 0);
  assert.match(Buffer.from(plugin.documents.overview).toString('utf8'), /not a successful/);
});
