import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { applyAgentHome, resolveCodexHome } from '../src/runtime/home.js';
import { probeCodexRuntime } from '../src/runtime/discover.js';

test('GIAN_AGENT_HOME becomes CODEX_HOME and wins over the Host bridge value', t => {
  const root = mkdtempSync(join(tmpdir(), 'codex-agent-home-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const agentHome = join(root, 'homes', 'codex', 'agent-1');
  const env: NodeJS.ProcessEnv = { HOME: root, GIAN_AGENT_HOME: agentHome, CODEX_HOME: join(root, 'stale') };
  assert.equal(resolveCodexHome(env), agentHome);
  assert.equal(applyAgentHome(env), agentHome);
  assert.equal(env.CODEX_HOME, agentHome);
  // Codex refuses a missing CODEX_HOME, so the Agent HOME exists, owner-only.
  assert.equal(statSync(agentHome).isDirectory(), true);
  assert.equal(statSync(agentHome).mode & 0o777, 0o700);
});

test('without GIAN_AGENT_HOME the inherited CODEX_HOME or the Codex default applies', () => {
  const inherited: NodeJS.ProcessEnv = { HOME: '/Users/fixture', CODEX_HOME: '/Volumes/codex-home' };
  assert.equal(applyAgentHome(inherited), null);
  assert.equal(inherited.CODEX_HOME, '/Volumes/codex-home');
  assert.equal(resolveCodexHome(inherited), '/Volumes/codex-home');
  assert.equal(resolveCodexHome({ HOME: '/Users/fixture' }), '/Users/fixture/.codex');
  // A relative value is never trusted as a state root.
  const relative: NodeJS.ProcessEnv = { HOME: '/Users/fixture', GIAN_AGENT_HOME: 'relative/home' };
  assert.equal(applyAgentHome(relative), null);
  assert.equal(existsSync('relative/home'), false);
  assert.equal(resolveCodexHome(relative), '/Users/fixture/.codex');
});

test('the Runtime probe reports the Agent HOME as its config home', async t => {
  const root = mkdtempSync(join(tmpdir(), 'codex-probe-home-'));
  const previous = { GIAN_AGENT_HOME: process.env.GIAN_AGENT_HOME, CODEX_HOME: process.env.CODEX_HOME };
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  process.env.GIAN_AGENT_HOME = join(root, 'agent');
  process.env.CODEX_HOME = join(root, 'bridge');
  const fakeCodex = join(root, 'codex');
  writeFileSync(fakeCodex, '#!/bin/sh\necho "codex-cli 0.171.0"\n', { mode: 0o755 });
  const probe = await probeCodexRuntime(fakeCodex);
  assert.equal(probe.version, '0.171.0');
  assert.equal(probe.configHome, join(root, 'agent'));
});
