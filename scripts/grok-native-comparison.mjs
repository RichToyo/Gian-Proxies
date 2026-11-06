import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const versions = [
  { version: '1.0.70', sha256: '5c8a688251bf61e35370b828b6a353b0a20fcc3f64000de8a91d426039f29cec', size: 179063008 },
  { version: '1.0.77', sha256: '197c66a63e5ac46e07450b0ca21d141ce665050a412180f185dadfae1c7a5b2a', size: 184995488 },
];
const root = await mkdtemp(join(tmpdir(), 'gian-grok-compare-'));
async function inspect(item) {
  const response = await fetch(`https://x.ai/cli/grok-${item.version}-macos-aarch64`, { signal: AbortSignal.timeout(180000) });
  assert.ok(response.ok, `Official download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(bytes.length, item.size);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), item.sha256);
  const bin = join(root, `grok-${item.version}`);
  const home = join(root, `home-${item.version}`);
  await writeFile(bin, bytes, { mode: 0o700 });
  await chmod(bin, 0o700);
  await mkdir(home);
  const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, GROK_DISABLE_AUTOUPDATER: '1', GROK_SANDBOX: 'workspace' };
  const version = spawnSync(bin, ['--version'], { env, encoding: 'utf8', timeout: 20000 });
  assert.equal(version.status, 0);
  assert.ok(version.stdout.includes(item.version));
  const result = await new Promise((resolve, reject) => {
    const child = spawn(bin, ['--deny', 'MCPTool(*)', '--disallowed-tools', 'search_tool,use_tool', 'agent', '--no-leader', 'stdio'], { cwd: home, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); child.kill(); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => finish(new Error(`ACP initialize timeout: ${stderr.slice(0, 500)}`)), 30000);
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => finish(error));
    child.on('exit', code => { if (!settled) finish(new Error(`ACP exited before initialize: ${code}; ${stderr.slice(0, 500)}`)); });
    child.stdout.on('data', chunk => {
      stdout += chunk;
      for (;;) {
        const end = stdout.indexOf('\n'); if (end < 0) break;
        const line = stdout.slice(0, end); stdout = stdout.slice(end + 1);
        let message; try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1) finish(message.error ? new Error(JSON.stringify(message.error)) : null, message.result);
      }
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientInfo: { name: 'gian-grok-proxy', version: '0.2.0' }, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, _meta: { clientIdentifier: 'gian-grok-proxy' } } })}\n`);
  });
  assert.equal(result.protocolVersion, 1);
  assert.equal(result._meta?.agentVersion, item.version);
  assert.equal(result._meta?.grokShell, true);
  return { version: item.version, sha256: item.sha256, capabilities: result.agentCapabilities, modelState: result._meta.modelState ?? null };
}
function retained(old, current, path = 'capabilities') {
  if (old && typeof old === 'object' && !Array.isArray(old)) {
    assert.ok(current && typeof current === 'object', `Removed ${path}`);
    for (const [key, value] of Object.entries(old)) retained(value, current[key], `${path}.${key}`);
  } else if (Array.isArray(old)) {
    assert.ok(Array.isArray(current), `Changed ${path}`);
    for (const entry of old) assert.ok(current.some(candidate => JSON.stringify(candidate) === JSON.stringify(entry)), `Removed ${path} entry`);
  } else assert.deepEqual(current, old, `Changed ${path}`);
}
try {
  const old = await inspect(versions[0]); const candidate = await inspect(versions[1]);
  retained(old.capabilities, candidate.capabilities);
  await mkdir('artifacts/release', { recursive: true });
  await writeFile('artifacts/release/grok-native-comparison.json', `${JSON.stringify({ result: 'PASS', old, candidate, providerTurns: 'NOT_RUN' }, null, 2)}\n`);
  console.log('Grok native version, spawn and ACP capabilities comparison passed.');
} finally { await rm(root, { recursive: true, force: true }); }
