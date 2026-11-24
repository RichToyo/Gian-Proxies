import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { discoverGrokRuntimes, probeGrokRuntime } from '../src/runtime/discover.js';

async function fakeGrok(path: string): Promise<void> {
  await writeFile(path, '#!/bin/sh\necho "grok 1.0.92 (b06756fd6256)"\n');
  await chmod(path, 0o755);
}

test('discovery looks for ~/.grok/bin/grok under the machine HOME, not under the Agent HOME', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'grok-discover-'));
  const saved = { HOME: process.env.HOME, PATH: process.env.PATH, GIAN_AGENT_HOME: process.env.GIAN_AGENT_HOME };
  t.after(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });
  const home = join(root, 'home');
  const agentHome = join(root, 'agent-home', '.grok');
  await mkdir(join(home, '.grok', 'bin'), { recursive: true });
  await mkdir(join(agentHome, '.grok', 'bin'), { recursive: true });
  await fakeGrok(join(home, '.grok', 'bin', 'grok'));
  // A binary at the old, wrong location must not be offered.
  await fakeGrok(join(agentHome, '.grok', 'bin', 'grok'));
  process.env.HOME = home;
  process.env.GIAN_AGENT_HOME = agentHome;
  process.env.PATH = join(root, 'empty-path');

  const found = await discoverGrokRuntimes();
  const paths = found.candidates.map((candidate) => candidate.path);
  assert.ok(paths.includes(join(home, '.grok', 'bin', 'grok')));
  assert.ok(!paths.includes(join(agentHome, '.grok', 'bin', 'grok')));

  const probed = await probeGrokRuntime(join(home, '.grok', 'bin', 'grok'));
  assert.equal(probed.version, '1.0.92');
  // Grok's state lives in the Agent HOME.
  assert.equal(probed.configHome, agentHome);
});
