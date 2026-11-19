import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { parseProxyArgs, readPluginVersion, runSelfTest } from '../dist/index.js';

test('readPluginVersion walks up from the caller module to its @gian/*-proxy package', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'proxy-kit-version-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'gian-proxies', version: '9.9.9' }));
  const proxyDir = join(root, 'example-proxy');
  mkdirSync(join(proxyDir, 'dist', 'src', 'cli'), { recursive: true });
  writeFileSync(join(proxyDir, 'package.json'), JSON.stringify({ name: '@gian/example-proxy', version: '1.2.3' }));
  const moduleUrl = pathToFileURL(join(proxyDir, 'dist', 'src', 'cli', 'spawn.js')).href;
  assert.equal(readPluginVersion(moduleUrl, '0.0.0'), '1.2.3');
});

test('readPluginVersion ignores non-Proxy packages and falls back', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'proxy-kit-version-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@gian/proxy-kit', version: '0.1.0' }));
  const moduleUrl = pathToFileURL(join(root, 'index.js')).href;
  assert.equal(readPluginVersion(moduleUrl, '0.0.7'), '0.0.7');
});

test('parseProxyArgs reads --key value pairs and bare flags', () => {
  assert.deepEqual(
    parseProxyArgs(['--codex-bin', '/bin/codex', '--verbose', '--data-dir', '/tmp/x', 'positional']),
    { 'codex-bin': '/bin/codex', verbose: true, 'data-dir': '/tmp/x' },
  );
  assert.deepEqual(parseProxyArgs(['--a', '--b', 'v']), { a: true, b: 'v' });
});

test('runSelfTest answers only --self-test with the artifact identity line', () => {
  const output = new PassThrough();
  let written = '';
  output.on('data', (chunk) => { written += chunk.toString('utf8'); });
  assert.equal(runSelfTest(['--other'], { id: 'codex', pluginVersion: '1.0.0' }, output), false);
  assert.equal(written, '');
  assert.equal(runSelfTest(['--self-test'], { id: 'codex', pluginVersion: '1.0.0' }, output), true);
  assert.deepEqual(JSON.parse(written), { schemaVersion: 4, id: 'codex', pluginVersion: '1.0.0', ok: true });
});

test('readPluginVersion without a fallback throws instead of guessing', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'proxy-kit-version-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const moduleUrl = pathToFileURL(join(root, 'index.js')).href;
  assert.throws(() => readPluginVersion(moduleUrl), /package version is unavailable/);
});
