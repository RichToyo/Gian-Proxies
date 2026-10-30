import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { projectInformation, projectTutorial } from './project.mjs';
import { assertHistoryEvidenceUrl, validateReview } from './validate.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const current = JSON.parse(readFileSync(join(root, 'evidence/current-combinations.json'), 'utf8'));
const certified = current.plugins.map(p => ({ pluginId: p.id, version: p.version, runtime: p.combination.runtime }));

test('history evidence accepts only the exact new and retained public repositories', () => {
  for (const owner of ['RichLogic', 'RichToyo']) {
    for (const repository of ['Gian', 'Gian-Proxies']) {
      assert.doesNotThrow(() => assertHistoryEvidenceUrl(`https://github.com/${owner}/${repository}/releases/tag/fixture`));
    }
  }
  for (const url of [
    'https://github.com/untrusted/Gian-Proxies/releases/tag/fixture',
    'https://github.com/RichToyo/Gian-Dev/blob/main/fixture',
    'https://github.com/RichLogic/Gian-Proxy-Catalog/releases/tag/fixture',
    'https://github.com.evil.invalid/RichToyo/Gian-Proxies/fixture',
    'http://github.com/RichToyo/Gian-Proxies/fixture',
    'https://github.com/RichToyo/Gian/../../untrusted/Gian-Proxies/fixture',
    'https://user@github.com/RichToyo/Gian-Proxies/fixture',
    'https://github.com:8443/RichToyo/Gian-Proxies/fixture',
  ]) assert.throws(() => assertHistoryEvidenceUrl(url));
});

test('authored histories remain complete and their Markdown projection matches', () => {
  assert.deepEqual(validateReview(), { proxies: 7, versions: 118, distributions: 121, metadataOnly: 28 });
});

test('v1 tutorial concatenation preserves all nine chapters byte for byte', () => {
  for (const plugin of current.plugins) {
    const tutorial = readFileSync(join(root, plugin.id, 'tutorial.md'), 'utf8');
    const history = readFileSync(join(root, plugin.id, 'changelog.md'), 'utf8');
    const docs = projectTutorial(tutorial, history, 'en');
    assert.deepEqual(Object.keys(docs), ['overview', 'setup', 'usage', 'troubleshooting']);
    assert.equal(docs.setup + docs.usage + docs.troubleshooting, tutorial);
    assert.equal(docs.overview, history);
    assert.throws(() => projectTutorial(tutorial.replace('## 9.', '## 10.'), history), /chapter contract/);
    assert.throws(() => projectTutorial(tutorial + '\n<script>alert(1)</script>\n', history), /HTML/);
  }
});

test('publication replaces only v1 documents and rejects mismatched certified versions', () => {
  const target = mkdtempSync(join(tmpdir(), 'gian-information-'));
  try {
    cpSync(join(root, '../official-source'), target, { recursive: true });
    const before = new Map(current.plugins.map(p => [p.id, readFileSync(join(target, 'plugins', p.id, 'entry.json'), 'utf8')]));
    const { localizations } = projectInformation(target, certified);
    for (const p of current.plugins) {
      const en = localizations[p.id].en;
      const zh = localizations[p.id]['zh-CN'];
      assert.equal(zh.tagline, en.tagline);
      assert.equal(zh.displayName, en.displayName);
      assert.deepEqual(zh.documents, en.documents);
      const published = zh.tagline + en.tagline + Object.values(en.documents).join('');
      assert.doesNotMatch(published, /\p{Script=Han}/u);
      assert.equal(en.documents.setup + en.documents.usage + en.documents.troubleshooting,
        readFileSync(join(root, p.id, 'tutorial.md'), 'utf8'));
      const history = JSON.parse(readFileSync(join(root, p.id, 'changelog.json'), 'utf8'));
      for (const entry of history.entries) assert.ok(en.documents.overview.includes(`## ${entry.version}\n`));
      assert.equal(readFileSync(join(target, 'plugins', p.id, 'entry.json'), 'utf8'), before.get(p.id));
      assert.equal(readFileSync(join(target, 'plugins', p.id, 'overview.md'), 'utf8'),
        readFileSync(join(root, p.id, 'changelog.md'), 'utf8'));
    }
    const mismatched = structuredClone(certified);
    mismatched[0].version = '99.0.0';
    assert.throws(() => projectInformation(target, mismatched), /Proxy snapshot differs/);
    const runtimeMismatch = structuredClone(certified);
    runtimeMismatch[0].runtime.version = '99.0.0';
    assert.throws(() => projectInformation(target, runtimeMismatch), /Runtime snapshot differs/);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test('catalog authoring has no second locale file and no Han product copy', () => {
  assert.equal(existsSync(join(root, 'history-copy.en.json')), false);
  const han = /\p{Script=Han}/u;
  const authored = [
    'README.md',
    'CONTRACT.md',
    'localizations.json',
    'project.mjs',
    'project.test.mjs',
    'validate.mjs',
    'evidence/README.md',
    'evidence/current-combinations.json',
    'evidence/dsh-bridge-versions.json',
    'evidence/manifests.json',
    'evidence/releases.json',
  ];
  for (const plugin of current.plugins) {
    for (const name of ['basic.md', 'changelog.json', 'changelog.md', 'tutorial.md']) {
      authored.push(`${plugin.id}/${name}`);
    }
  }
  for (const rel of authored) {
    assert.doesNotMatch(readFileSync(join(root, rel), 'utf8'), han, rel);
  }
});

test('new selected qualified metadata leaves excluded signed content and localizations untouched', () => {
  const target = mkdtempSync(join(tmpdir(), 'gian-information-addition-'));
  try {
    cpSync(join(root, '../official-source'), target, { recursive: true });
    // Antigravity is history-backed since Catalog 29; simulate the next
    // history-less provider with a synthetic fixture instead.
    const pluginId = 'io.fixture.newproxy';
    const directory = join(target, 'plugins', pluginId);
    const manifest = { schemaVersion: 4, id: pluginId, pluginVersion: '0.1.0',
      protocol: { name: 'gian.proxy', range: '>=2.2 <3.0' }, process: { scope: 'shared' },
      runtime: { kind: 'external', id: 'fixture-acp', verifiedVersions: ['1.0.0'] } };
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'entry.json'), JSON.stringify({ pluginId,
      channels: { stable: { pluginVersion: '0.1.0' } },
      documentation: { overview: 'overview.md', setup: 'setup.md', usage: 'usage.md', troubleshooting: 'troubleshooting.md' } }));
    writeFileSync(join(directory, 'sidecar.json'), JSON.stringify(manifest));
    for (const doc of ['overview.md', 'setup.md', 'usage.md', 'troubleshooting.md']) writeFileSync(join(directory, doc), `# ${doc}\n`);
    const addition = { pluginId, version: '0.1.0', manifest, runtime: { runtimeId: 'fixture-acp', version: '1.0.0' } };
    const oldPath = join(target, 'plugins', current.plugins[0].id, 'overview.md');
    writeFileSync(oldPath, '# Exact signed base28 content\n');
    const inheritedLocalizations = { [current.plugins[0].id]: {
      en: { displayName: 'Signed name', tagline: 'Signed tagline', documents: { overview: Buffer.from('signed localized bytes') } },
    } };
    const before = readFileSync(join(directory, 'overview.md'));
    const options = { selectedIds: [pluginId], inheritedLocalizations };
    const result = projectInformation(target, [...certified, addition], options);
    assert.equal(readFileSync(oldPath, 'utf8'), '# Exact signed base28 content\n');
    assert.deepEqual(Buffer.from(result.localizations[current.plugins[0].id].en.documents.overview),
      inheritedLocalizations[current.plugins[0].id].en.documents.overview);
    assert.deepEqual(readFileSync(join(directory, 'overview.md')), before);
    assert.throws(() => projectInformation(target, [...certified, { ...addition, version: '0.2.0' }], options), /version differs/);
    assert.throws(() => projectInformation(target, [...certified, { ...addition, manifest: { ...manifest, id: 'other' } }], options), /Manifest differs/);
    assert.throws(() => projectInformation(target, [...certified, { ...addition, runtime: { runtimeId: 'fixture-acp', version: '2.0.0' } }], options), /Runtime version differs/);
    writeFileSync(join(directory, 'usage.md'), '');
    assert.throws(() => projectInformation(target, [...certified, addition], options), /documentation is incomplete/);
  } finally { rmSync(target, { recursive: true, force: true }); }
});
