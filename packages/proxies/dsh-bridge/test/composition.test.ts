import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '../..');
const presetNames = ['standard', 'ptc', 'minimal', 'cordis'] as const;

async function read(relative: string): Promise<string> {
  return readFile(join(packageDir, relative), 'utf8');
}

test('the Bridge bundle mounts all four official presets after its host patch', async () => {
  const manifest = JSON.parse(await read('package.json')) as {
    exports: Record<string, string>;
    files: string[];
    dsh: { bundle: { patch: string[] } };
  };
  assert.deepEqual(manifest.dsh.bundle.patch, [
    './cordis.patch.yml',
    ...presetNames.map(name => `./presets/${name}.patch.yml`),
  ]);
  assert.ok(manifest.files.includes('presets/*.patch.yml'));
  assert.equal(manifest.exports['./presets/*.patch.yml'], './presets/*.patch.yml');
});

test('the host patch supplies preset services and disables every official base-global tool row', async () => {
  const patch = await read('cordis.patch.yml');
  for (const service of [
    '@deepseek-ai/dsh-web-app/startup',
    '@deepseek-ai/dsh-client-connection',
    '@deepseek-ai/dsh-client-file-upload',
    '@deepseek-ai/dsh-workspace',
    '@deepseek-ai/dsh-api-session-controller',
    '@deepseek-ai/dsh-schedule',
    '@deepseek-ai/dsh-cordis-host-runner',
    '@deepseek-ai/dsh-tool-subagent/model-selection-settings',
    '@deepseek-ai/dsh-tool-cordis/host',
    '@deepseek-ai/dsh-agent-preset-registry',
  ]) {
    assert.match(patch, new RegExp(`name: '${service.replaceAll('/', '\\/')}'`));
  }
  for (const row of [
    'tool-bash', 'tool-pwsh', 'tool-jobs', 'tool-fs', 'tool-fs-search',
    'skill-filesystem', 'tool-skill', 'command-goal', 'tool-goal', 'plan-mode',
    'compaction-basic', 'command-compact', 'tool-result-pruner',
    'tool-subagent-control', 'tool-subagent',
    'tool-subagent-fork', 'workflow-ptc', 'tool-workflow', 'agent-instructions',
    'tool-todo', 'tool-web',
  ]) {
    assert.match(patch, new RegExp(`- id: ${row}\\n  disabled: true`));
  }
  assert.match(patch, /default: standard/);
  assert.doesNotMatch(patch, /tool-subagent-list-agents/, 'dsh-base no longer has this row');
  assert.match(patch, /name: '@deepseek-ai\/dsh-skill-office'\n\s+config:\n\s+pythonEnvironment: user/);
});

test('the host patch disables the official-API Session-log upload', async () => {
  const patch = await read('cordis.patch.yml');
  assert.match(patch, /^- id: session-log-deepseek\n  disabled: true$/m);
});

test('preset declarations retain their distinct native tool compositions', async () => {
  const standard = await read('presets/standard.patch.yml');
  const ptc = await read('presets/ptc.patch.yml');
  const minimal = await read('presets/minimal.patch.yml');
  const cordis = await read('presets/cordis.patch.yml');
  assert.match(standard, /name: '@deepseek-ai\/dsh-tool-web'/);
  assert.match(standard, /name: '@deepseek-ai\/dsh-tool-workflow'/);
  assert.match(ptc, /name: '@deepseek-ai\/dsh-tool-executor-ptc'/);
  assert.doesNotMatch(ptc, /dsh-agent-tool-presentation/);
  assert.match(cordis, /name: '@deepseek-ai\/dsh-tool-cordis'/);
  assert.match(minimal, /read: false/);
  assert.match(minimal, /write: false/);
  assert.match(minimal, /name: '@deepseek-ai\/dsh-tool-bash-persistent'/);
  assert.doesNotMatch(minimal, /name: '@deepseek-ai\/dsh-tool-web'/);
  assert.doesNotMatch(minimal, /name: '@deepseek-ai\/dsh-tool-subagent'/);
  assert.doesNotMatch(minimal, /name: '@deepseek-ai\/dsh-tool-workflow'/);
});

test('presets carry the rc.5 office tool, bundled skills and non-interrupting subagent control', async () => {
  for (const name of ['standard', 'ptc']) {
    assert.match(await read(`presets/${name}.patch.yml`), /name: '@deepseek-ai\/dsh-tool-office'/, name);
  }
  for (const name of ['standard', 'ptc', 'cordis']) {
    const patch = await read(`presets/${name}.patch.yml`);
    assert.match(patch, /name: '@deepseek-ai\/dsh-tool-subagent-control'\n\s+config:\n\s+interrupt: false/, name);
    assert.match(patch, /provider: spawn\n\s+toolName: subagent\n\s+modelSelection: true\n\s+modelDiscovery: true/, name);
    assert.doesNotMatch(patch, /list-agents|0\.2\.0|0\.2\.1-rc/, name);
  }
  for (const name of ['standard', 'cordis']) {
    const patch = await read(`presets/${name}.patch.yml`);
    assert.match(patch, /customSkillDirs:\n\s+- !!js .*'@deepseek-ai\/dsh-agent-preset\/package\.json'.*'skills'\)/, name);
  }
  // Gian keeps plugin installation out of the standard preset: the profile is
  // Proxy-managed and rewritten on launch.
  const standard = await read('presets/standard.patch.yml');
  assert.match(standard, /name: '@deepseek-ai\/dsh-plugin-manager\/tools'\n\s+disabled: true/);
});
