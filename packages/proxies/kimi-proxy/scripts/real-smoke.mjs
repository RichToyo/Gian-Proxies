// Real Kimi Code smoke regression for the Kimi Proxy, driven like the Gian Host.
//
// Usage: OPENAI_KEY_FILE=<.env with OPENAI_API_KEY=…> \
//          node scripts/real-smoke.mjs <built dist/src/cli/spawn.js> <kimi binary> [scenario,...]
//
// Every run uses a new isolated Kimi home configured for an OpenAI model
// (gpt-5-mini through the Responses API), so no Kimi account is needed. The
// key is read from the file and never printed. HTTPS_PROXY / HTTP_PROXY /
// NO_PROXY are passed through when set. GIAN_KIMI_TRACE_FRAMES=1 also logs the
// native frames. Results, notifications (notes.jsonl) and the Proxy's stderr
// stay in the printed run directory. Exit status 1 when a check fails.
import { execSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { HostProtocolValidator } from '@gian/proxy-protocol/conformance';

const [entry, kimiBin, only] = process.argv.slice(2);
const selected = only ? new Set(only.split(',')) : null;
const key = readFileSync(process.env.OPENAI_KEY_FILE, 'utf8').split('\n')
  .find((l) => l.startsWith('OPENAI_API_KEY=')).slice(15).trim().replace(/^["']|["']$/g, '');
const redact = (s) => String(s).replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-[REDACTED]');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const H = realpathSync(mkdtempSync('/tmp/kimi-smoke-run.'));
for (const d of ['agent', 'home', 'ws', 'ws2']) mkdirSync(join(H, d), { recursive: true, mode: 0o700 });
writeFileSync(join(H, 'agent/config.toml'), `default_model = "openai/gpt-5-mini"

[providers.openai]
type = "openai_responses"
base_url = "https://api.openai.com/v1"
api_key = "${key}"

[models."openai/gpt-5-mini"]
provider = "openai"
model = "gpt-5-mini"
display_name = "GPT-5 mini (OpenAI Responses)"
max_context_size = 400000
capabilities = ["thinking", "tool_use", "image_in"]
support_efforts = ["low", "medium", "high"]
default_effort = "low"
`, { mode: 0o600 });
const passthrough = Object.fromEntries(['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'GIAN_KIMI_TRACE_FRAMES']
  .filter((name) => process.env[name]).map((name) => [name, process.env[name]]));
const env = { HOME: join(H, 'home'), GIAN_AGENT_HOME: join(H, 'agent'), PATH: '/usr/bin:/bin', TMPDIR: process.env.TMPDIR, LANG: 'en_US.UTF-8',
  KIMI_CODE_NO_AUTO_UPDATE: '1', ...passthrough };
const AUTO = { model: 'openai/gpt-5-mini', thinking: 'low', approval_mode: 'yolo' };
const ASK = { model: 'openai/gpt-5-mini', thinking: 'low', approval_mode: 'manual' };

// ---- Host stand-in ----
let proxy = null; let reqNo = 0;
const allErrors = []; // every domain error and failed turn seen
// Every frame also passes the Host's own conformance validator: a violation is
// what makes the App quarantine the session or turn.
const violations = [];
let currentScenario = 'setup';
const PLUGIN_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
function startProxy() {
  const child = spawn(process.execPath, [entry, '--kimi-bin', kimiBin], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const p = { child, pending: new Map(), notes: [], listeners: new Set(), stderr: '',
    validator: new HostProtocolValidator({ pluginId: 'kimi', pluginVersion: PLUGIN_VERSION, processScope: 'shared' }) };
  child.stderr.on('data', (d) => { p.stderr = (p.stderr + d).slice(-20000); appendFileSync(join(H, 'proxy-stderr.log'), redact(String(d))); });
  createInterface({ input: child.stdout }).on('line', (line) => {
    try { p.validator.acceptLine(line); } catch (error) {
      const message = `${error?.message ?? error}`;
      violations.push({ scenario: currentScenario, message });
      console.log(`FAIL  [${currentScenario}] Host protocol conformance  (${redact(message).slice(0, 300)})`);
      results.push({ scenario: currentScenario, name: 'Host protocol conformance', ok: false });
    }
    let m; try { m = JSON.parse(line); } catch { return; }
    if (m.id !== undefined && p.pending.has(m.id)) {
      const { resolve, reject } = p.pending.get(m.id); p.pending.delete(m.id);
      if (m.error) reject(Object.assign(new Error(`[${m.error.data?.domainCode ?? m.error.code}] ${m.error.message}`), { rpc: m.error }));
      else resolve(m.result);
      return;
    }
    if (m.method) {
      p.notes.push({ at: Date.now(), m });
      appendFileSync(join(H, 'notes.jsonl'), redact(JSON.stringify({ at: Date.now(), m })) + '\n');
      if (m.method === 'turn.failed') allErrors.push(`turn.failed ${m.params.turnId}: [${m.params.data?.error?.domainCode}] ${m.params.data?.error?.message}`);
      if (m.method === 'runtime.error') allErrors.push(`runtime.error: [${m.params.data?.domainCode}] ${m.params.data?.message}`);
      for (const l of p.listeners) l(m);
    }
  });
  return p;
}
function request(method, params, timeoutMs = 120000) {
  const p = proxy; const id = `r${++reqNo}`;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { p.pending.delete(id); reject(new Error(`timeout: ${method}`)); }, timeoutMs);
    p.pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); allErrors.push(`${method}: ${e.message}`); reject(e); } });
    const frame = { jsonrpc: '2.0', id, method, params };
    try { p.validator.registerRequest(frame); } catch (error) { console.log(`INFO  request ${method} rejected by the Host validator: ${error?.message ?? error}`); }
    p.child.stdin.write(JSON.stringify(frame) + '\n');
  });
}
function waitFor(pred, label, ms = 240000) {
  const p = proxy;
  return new Promise((resolve, reject) => {
    const hit = p.notes.find((n) => pred(n.m)); if (hit) return resolve(hit.m);
    const t = setTimeout(() => { p.listeners.delete(l); reject(new Error(`timeout waiting for ${label}`)); }, ms);
    const l = (m) => { if (pred(m)) { clearTimeout(t); p.listeners.delete(l); resolve(m); } };
    p.listeners.add(l);
  });
}
async function initialize() {
  // What the Host does for every Proxy process before it creates sessions.
  await request('initialize', { protocol: { name: 'gian.proxy', versions: ['2.3'] }, host: { name: 'gian-smoke', version: '0.0.0' } });
  await request('catalog.list', {});
}
const sessions = {};
async function create(sid, { native, cwd = join(H, 'ws') } = {}) {
  const r = await request('session.create', { sessionId: sid, workspace: { cwd, roots: [cwd] }, config: {}, ...(native ? { nativeSession: { id: native } } : {}) });
  sessions[sid] = { sessionId: sid, streamId: r.session.streamId, native: r.session.nativeSession?.id ?? native };
  return sessions[sid];
}
let turnNo = 0;
const textOf = (turnId) => proxy.notes.filter((n) => n.m.params?.turnId === turnId && n.m.method === 'content.delta' && n.m.params.data?.kind === 'text').map((n) => n.m.params.data.delta).join('');
const isEnd = (turnId) => (m) => (m.method === 'turn.completed' || m.method === 'turn.failed') && m.params.turnId === turnId;
async function startTurn(sid, text, cfg = AUTO, { onInteraction } = {}) {
  const turnId = `t${++turnNo}`;
  if (onInteraction) {
    const l = (m) => { if (m.method === 'interaction.requested' && m.params.turnId === turnId) void onInteraction(turnId, m.params.data).catch(() => {}); };
    proxy.listeners.add(l);
  }
  await request('turn.start', { ...pick(sessions[sid]), turnId, input: [{ type: 'text', text }], config: cfg });
  return turnId;
}
const pick = (s) => ({ sessionId: s.sessionId, streamId: s.streamId });
async function endOf(turnId, ms = 240000) {
  const end = await waitFor(isEnd(turnId), `end of ${turnId}`, ms);
  return { method: end.method, stopReason: end.params.data?.stopReason, error: end.params.data?.error, text: textOf(turnId) };
}
async function turn(sid, text, cfg = AUTO, opts = {}) { const id = await startTurn(sid, text, cfg, opts); const e = await endOf(id); return { turnId: id, ...e }; }
const interrupt = (sid, turnId) => request('turn.interrupt', { ...pick(sessions[sid]), turnId }, 30000);
const respond = (sid, turnId, data, re) => {
  const a = (data.actions ?? []).find((x) => re.test(`${x.id} ${x.label ?? ''}`) && !/always/i.test(`${x.id} ${x.label ?? ''}`));
  return request('interaction.respond', { ...pick(sessions[sid]), turnId, interactionId: data.interactionId, responseId: `resp-${data.interactionId}`, actionId: a?.id, values: {} });
};
const answerAny = (sid) => (turnId, data) => {
  const actions = data.actions ?? [];
  const a = actions.find((x) => /allow|approve|accept|yes|submit|confirm/i.test(`${x.id} ${x.label ?? ''}`) && !/always/i.test(`${x.id} ${x.label ?? ''}`)) ?? actions[0];
  const values = {};
  for (const input of data.inputs ?? []) {
    const first = (input.choices ?? [])[0]?.value;
    if (input.type === 'single_select' && first) values[input.id] = first;
    else if (input.type === 'multi_select' && first) values[input.id] = [first];
  }
  return request('interaction.respond', { ...pick(sessions[sid]), turnId, interactionId: data.interactionId, responseId: `resp-${data.interactionId}`, actionId: a?.id, values });
};
const firstOutput = (turnId) => waitFor((m) => m.params?.turnId === turnId && (m.method === 'content.delta' || m.method === 'activity.updated'), `first output of ${turnId}`, 180000);
const firstTool = (turnId) => waitFor((m) => m.params?.turnId === turnId && m.method === 'activity.updated' && !['plan', 'notice', 'reasoning'].includes(m.params.data?.kind), `tool activity of ${turnId}`, 180000);

// ---- results ----
const results = [];
const check = (scenario, name, ok, detail = '') => { results.push({ scenario, name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  [${scenario}] ${name}${detail ? `  (${redact(detail).slice(0, 300)})` : ''}`); };
const ok = (e) => e.method === 'turn.completed';
const desc = (e) => `${e.method}${e.stopReason ? `/${e.stopReason}` : ''}${e.error ? ` [${e.error.domainCode}] ${e.error.message}` : ''} ${JSON.stringify((e.text ?? '').slice(0, 60))}`;
// `interruptedAnswer` matches the reply to the interrupted request: when the
// interrupt lands before any answer text exists, Kimi drops the reasoning and
// the model answers that request on the next turn (native behavior).
async function recoverable(scenario, sid, label, interruptedAnswer = null) {
  try {
    const e = await turn(sid, 'Reply with exactly: ok', AUTO);
    const answeredOld = interruptedAnswer !== null && interruptedAnswer.test(e.text.trim());
    check(scenario, `${label}: next turn completes`, ok(e) && (/ok/i.test(e.text) || answeredOld), desc(e));
    if (answeredOld) console.log(`INFO  [${scenario}] ${label}: the model answered the interrupted request`);
    return ok(e);
  }
  catch (error) { check(scenario, `${label}: next turn completes`, false, error.message); return false; }
}

const scenarios = {
  async basic() {
    const s = 'basic'; await create(s);
    const a = await turn(s, 'Remember the word PELICAN. Reply with exactly: noted'); check(s, 'plain turn', ok(a), desc(a));
    const b = await turn(s, 'Use a shell command to print the current directory, then reply with DONE.'); check(s, 'tool turn', ok(b), desc(b));
    const c = await turn(s, 'What word did I ask you to remember? Reply with just the word.'); check(s, 'memory', ok(c) && /pelican/i.test(c.text), desc(c));
  },
  async backToBack() {
    const s = 'b2b'; await create(s);
    for (let i = 1; i <= 5; i += 1) { const e = await turn(s, `Reply with exactly: n${i}`); check(s, `turn ${i} immediately after the previous`, ok(e), desc(e)); }
  },
  async interruptText() {
    const s = 'intText'; await create(s);
    for (let i = 1; i <= 3; i += 1) {
      const id = await startTurn(s, 'Write the numbers from 1 to 400, one per line, no other text.');
      await firstOutput(id); await sleep(800);
      let ack = null; try { const t0 = Date.now(); await interrupt(s, id); ack = Date.now() - t0; } catch (e) { ack = e.message; }
      const e = await endOf(id, 60000).catch((err) => ({ method: 'none', error: { message: err.message } }));
      check(s, `round ${i}: interrupt during text ends the turn`, e.method !== 'none' && (e.stopReason === 'interrupted' || e.stopReason === 'cancelled'), `ack=${ack} ${desc(e)}`);
      await recoverable(s, s, `round ${i}`, /^1\s+2\s+3\b/);
    }
  },
  async interruptStress() {
    const s = 'stress'; await create(s);
    const delays = [200, 600, 1200, 2500, 400, 3500, 900, 1800];
    for (let i = 0; i < delays.length; i += 1) {
      const id = await startTurn(s, `Write the numbers from 1 to 300, one per line, prefixed with R${i}-. No other text.`);
      await firstOutput(id).catch(() => {}); await sleep(delays[i]);
      let ack = 'ok'; try { await interrupt(s, id); } catch (e) { ack = e.message; }
      const e = await endOf(id, 60000).catch((err) => ({ method: 'none', error: { message: err.message } }));
      check(s, `round ${i}: interrupted turn ends`, e.method !== 'none' && !e.error, `delay=${delays[i]} ack=${ack} ${desc(e)}`);
      const want = `okay${i}`;
      const n = await turn(s, `Reply with exactly: ${want}`).catch((err) => ({ method: 'none', error: { message: err.message }, text: '' }));
      const own = n.text.trim() === want; const answeredOld = new RegExp(`^R${i}-1\\b`).test(n.text.trim());
      check(s, `round ${i}: next turn completes with its own reply or the interrupted request's answer`, ok(n) && (own || answeredOld), desc(n));
      if (answeredOld) console.log(`INFO  [stress] round ${i}: the model answered the interrupted request (no answer text existed when it was interrupted)`);
    }
  },
  async interruptEarly() {
    const s = 'intEarly'; await create(s);
    for (let i = 1; i <= 3; i += 1) {
      const id = await startTurn(s, 'Explain in detail how a compiler works.');
      let ack = null; try { await interrupt(s, id); ack = 'ok'; } catch (e) { ack = e.message; }
      const e = await endOf(id, 60000).catch((err) => ({ method: 'none', error: { message: err.message } }));
      check(s, `round ${i}: interrupt right after turn.start ends the turn`, e.method !== 'none', `ack=${ack} ${desc(e)}`);
      await recoverable(s, s, `round ${i}`);
    }
  },
  async interruptTool() {
    const s = 'intTool'; await create(s);
    const id = await startTurn(s, 'Run the shell command `sleep 30` and then reply with DONE.');
    await firstTool(id); await sleep(2500);
    let ack = null; try { await interrupt(s, id); ack = 'ok'; } catch (e) { ack = e.message; }
    const e = await endOf(id, 60000).catch((err) => ({ method: 'none', error: { message: err.message } }));
    check(s, 'interrupt during a shell command ends the turn', e.method !== 'none', `ack=${ack} ${desc(e)}`);
    await recoverable(s, s, 'after tool interrupt');
  },
  async interruptApproval() {
    const s = 'intAsk'; await create(s);
    const id = await startTurn(s, 'Use a shell command to create a file named a.txt containing hi.', ASK);
    await waitFor((m) => m.method === 'interaction.requested' && m.params.turnId === id, 'approval request', 180000);
    let ack = null; try { await interrupt(s, id); ack = 'ok'; } catch (e) { ack = e.message; }
    const e = await endOf(id, 60000).catch((err) => ({ method: 'none', error: { message: err.message } }));
    check(s, 'interrupt while an approval is pending ends the turn', e.method !== 'none', `ack=${ack} ${desc(e)}`);
    await recoverable(s, s, 'after approval interrupt');
  },
  async approvals() {
    const s = 'approvals'; await create(s);
    const a = await turn(s, 'Use a shell command to create a file named hello.txt containing exactly: hi', ASK, { onInteraction: (t, d) => respond(s, t, d, /allow|approve|accept|yes/i) });
    check(s, 'approve runs the command', ok(a) && existsSync(join(H, 'ws/hello.txt')), desc(a));
    const b = await turn(s, 'Use a shell command to delete hello.txt.', ASK, { onInteraction: (t, d) => respond(s, t, d, /deny|reject|decline|no\b/i) });
    check(s, 'deny keeps the file', b.method !== 'none' && existsSync(join(H, 'ws/hello.txt')), desc(b));
    await recoverable(s, s, 'after deny');
  },
  async steer() {
    const s = 'steer'; await create(s);
    const id = await startTurn(s, 'Run the shell command `sleep 8`, then reply with the word FIRST.');
    await firstTool(id);
    let st = null; try { await request('turn.steer', { ...pick(sessions[s]), turnId: id, input: [{ type: 'text', text: 'Also add the word SECOND at the end of your reply.' }] }); st = 'ok'; } catch (e) { st = e.message; }
    const e = await endOf(id).catch((err) => ({ method: 'none', error: { message: err.message } }));
    check(s, 'steer during a running turn is accepted and the turn ends', st === 'ok' && e.method !== 'none', `steer=${st} ${desc(e)}`);
    await recoverable(s, s, 'after steer');
  },
  async background() {
    const s = 'bg'; await create(s);
    const a = await turn(s, 'Start the shell command `sleep 25 && echo BGDONE > bg.txt` as a background task (run it in the background, do not wait), then immediately reply with STARTED.');
    check(s, 'turn that starts a background task ends', a.method !== 'none', desc(a));
    const b = await turn(s, 'Reply with exactly: meanwhile');
    check(s, 'a turn while the background task runs', ok(b), desc(b));
    await sleep(30000);
    check(s, 'background command finished', existsSync(join(H, 'ws/bg.txt')));
    await recoverable(s, s, 'after background completion');
    const c = await turn(s, 'Reply with exactly: later');
    check(s, 'another turn after the background notification', ok(c), desc(c));
  },
  async reattachSame() {
    const s = 'reattach'; const created = await create(s);
    const a = await turn(s, 'Remember the number 4711. Reply with exactly: noted'); check(s, 'first turn', ok(a), desc(a));
    try { await create(s, { native: created.native }); check(s, 'Host re-attach of an idle session (same proxy)', true); }
    catch (e) { check(s, 'Host re-attach of an idle session (same proxy)', false, e.message); }
    await recoverable(s, s, 'after idle re-attach');
    // Host re-attach right after an interrupted turn (the Host disposes and brings the session up again).
    const id = await startTurn(s, 'Write the numbers from 1 to 400, one per line.'); await firstOutput(id); await sleep(500);
    try { await interrupt(s, id); } catch { /* recorded */ }
    await endOf(id, 60000).catch(() => {});
    try { await create(s, { native: created.native }); check(s, 'Host re-attach right after an interrupted turn', true); }
    catch (e) { check(s, 'Host re-attach right after an interrupted turn', false, e.message); }
    await recoverable(s, s, 'after post-interrupt re-attach');
    const m = await turn(s, 'What number did I ask you to remember? Reply with just the number.'); check(s, 'memory after re-attach', ok(m) && /4711/.test(m.text), desc(m));
  },
  async proxyRestartIdle() {
    const s = 'restartIdle'; const created = await create(s);
    const a = await turn(s, 'Remember the color TEAL. Reply with exactly: noted'); check(s, 'first turn', ok(a), desc(a));
    proxy.child.kill('SIGKILL'); await sleep(1500);
    proxy = startProxy(); await initialize();
    try { await create(s, { native: created.native }); check(s, 'attach after a proxy crash while idle', true); }
    catch (e) { check(s, 'attach after a proxy crash while idle', false, e.message); }
    await recoverable(s, s, 'after restart');
    const m = await turn(s, 'What color did I ask you to remember? Reply with just the color.'); check(s, 'memory after restart', ok(m) && /teal/i.test(m.text), desc(m));
  },
  async proxyRestartMidTurn() {
    const s = 'restartMid'; const created = await create(s);
    const id = await startTurn(s, 'Run the shell command `sleep 20` and then reply with DONE.'); await firstTool(id);
    proxy.child.kill('SIGKILL'); await sleep(1500);
    proxy = startProxy(); await initialize();
    let attached = false;
    for (let i = 0; i < 8 && !attached; i += 1) {
      try { await create(s, { native: created.native }); attached = true; } catch (e) { if (i === 7) check(s, 'attach after a proxy crash mid-turn', false, e.message); else await sleep(5000); }
    }
    if (attached) check(s, 'attach after a proxy crash mid-turn', true);
    if (attached) await recoverable(s, s, 'after mid-turn restart');
  },
  async gracefulRestart() {
    const s = 'graceful'; const created = await create(s);
    const a = await turn(s, 'Reply with exactly: one'); check(s, 'first turn', ok(a), desc(a));
    try { await request('shutdown', {}, 30000); } catch { /* exits */ }
    await sleep(2000);
    proxy = startProxy(); await initialize();
    try { await create(s, { native: created.native }); check(s, 'attach after a graceful proxy shutdown (update)', true); }
    catch (e) { check(s, 'attach after a graceful proxy shutdown (update)', false, e.message); }
    await recoverable(s, s, 'after graceful restart');
  },
  async concurrent() {
    await create('c1'); await create('c2', { cwd: join(H, 'ws2') });
    const [x, y] = await Promise.all([turn('c1', 'Reply with exactly: alpha'), turn('c2', 'Reply with exactly: beta')]);
    check('concurrent', 'two sessions run turns at the same time', ok(x) && ok(y), `${desc(x)} | ${desc(y)}`);
    const [x2, y2] = await Promise.all([turn('c1', 'Use a shell command to print the date, then reply DONE.'), turn('c2', 'Use a shell command to print the date, then reply DONE.')]);
    check('concurrent', 'two sessions run tool turns at the same time', ok(x2) && ok(y2), `${desc(x2)} | ${desc(y2)}`);
  },
  async long() {
    const s = 'long'; await create(s);
    let fails = 0;
    for (let i = 1; i <= 12; i += 1) {
      const prompt = i % 3 === 0 ? `Use a shell command to append the line ${i} to log.txt, then reply with exactly: step${i}` : `Reply with exactly: step${i}`;
      const e = await turn(s, prompt);
      if (!ok(e)) { fails += 1; check(s, `turn ${i}`, false, desc(e)); }
    }
    check(s, '12-turn conversation with tools never wedges', fails === 0, `${fails} failed`);
  },
  async richFeatures() {
    const s = 'rich'; await create(s);
    const cases = [
      ['plan / todo list', 'First write a todo list with three steps using your todo or plan tool. Then do them: create a.txt containing A, create b.txt containing B, and list the files. Mark each step done as you go. Finish with DONE.'],
      ['file edit with diff', 'Create notes.md with three lines (one, two, three), then edit it to replace two with TWO. Finish with DONE.'],
      ['subagent', 'Use a subagent (your agent or task tool) to count the files in the current directory and report the number back to me.'],
      ['question to the user', 'Ask me a multiple-choice question with your question tool: which color do I prefer, red or blue? Then tell me my answer.'],
      ['long output', 'Write a 400-word story about a lighthouse keeper. Plain text.'],
      ['several tools in one turn', 'Run three shell commands one after another: print the date, print the current directory, and print the number 42. Then summarise the results in one line.'],
      ['compaction', '/compact'],
      ['after compaction', 'What files did we create earlier in this conversation? Reply in one line.'],
    ];
    for (const [label, prompt] of cases) {
      const e = await turn(s, prompt, AUTO, { onInteraction: answerAny(s) }).catch((err) => ({ method: 'none', error: { message: err.message }, text: '' }));
      check(s, label, e.method === 'turn.completed', desc(e));
      if (e.method !== 'turn.completed') {
        // What the Host does after a failed turn: bring the session up again, then continue.
        try { await create(s, { native: sessions[s].native }); check(s, `${label}: Host re-attach after the failure`, true); }
        catch (err) { check(s, `${label}: Host re-attach after the failure`, false, err.message); }
        await recoverable(s, s, `${label}: recovery`);
      }
    }
  },
  async backgroundSubagent() {
    const s = 'bgAgent'; await create(s);
    const a = await turn(s, 'Start a background subagent (run it in the background, do not wait) whose task is: run `sleep 20` and then report DONE. Immediately reply with STARTED.', AUTO, { onInteraction: answerAny(s) });
    check(s, 'turn that starts a background subagent ends', a.method === 'turn.completed', desc(a));
    const b = await turn(s, 'Reply with exactly: meanwhile'); check(s, 'turn while the subagent runs', ok(b), desc(b));
    await sleep(25000);
    const c = await turn(s, 'Reply with exactly: after'); check(s, 'turn after the subagent finished', ok(c), desc(c));
    try { await create(s, { native: sessions[s].native }); check(s, 'Host re-attach after background work', true); }
    catch (err) { check(s, 'Host re-attach after background work', false, err.message); }
  },
  async questions() {
    const s = 'questions'; await create(s);
    const QUESTION = 'Ask me a multiple-choice question with your question tool: which color do I prefer, red or blue? Then tell me my answer in one line.';
    const a = await turn(s, QUESTION, AUTO, { onInteraction: answerAny(s) });
    check(s, 'answered question completes the turn', ok(a), desc(a));
    // Stop while the question waits.
    const id = await startTurn(s, QUESTION);
    await waitFor((m) => m.method === 'interaction.requested' && m.params.turnId === id, 'question', 180000);
    let ack = 'ok'; try { await interrupt(s, id); } catch (e) { ack = e.message; }
    const e = await endOf(id, 60000).catch((err) => ({ method: 'none', error: { message: err.message } }));
    check(s, 'interrupt while a question waits ends the turn', e.method !== 'none', `ack=${ack} ${desc(e)}`);
    await recoverable(s, s, 'after question interrupt');
  },
  async hostRecovery() {
    // The Host's recovery of a stuck turn: it marks the turn stopped, drops the stream
    // and re-attaches with session.create on the next message, without interrupting.
    const s = 'recover'; await create(s);
    const cases = [
      ['a turn waiting on a question', 'Ask me a multiple-choice question with your question tool: tea or coffee? Then tell me my answer.', AUTO,
        (id) => waitFor((m) => m.method === 'interaction.requested' && m.params.turnId === id, 'question', 180000)],
      ['a turn waiting on an approval', 'Use a shell command to create a file named r.txt containing hi.', ASK,
        (id) => waitFor((m) => m.method === 'interaction.requested' && m.params.turnId === id, 'approval', 180000)],
      ['a turn running a long command', 'Run the shell command `sleep 40` and then reply with DONE.', AUTO,
        (id) => firstTool(id).then(() => sleep(2000))],
    ];
    for (const [label, prompt, cfg, waitStuck] of cases) {
      const id = await startTurn(s, prompt, cfg);
      await waitStuck(id);
      const t0 = Date.now();
      try { await create(s, { native: sessions[s].native }); check(s, `Host re-attach while ${label}`, true, `${Date.now() - t0} ms`); }
      catch (err) { check(s, `Host re-attach while ${label}`, false, err.message); }
      await recoverable(s, s, `after recovering ${label}`);
    }
  },
  async steerStress() {
    const s = 'steerStress'; await create(s);
    const variants = [
      ['during a shell command', 'Run the shell command `sleep 6`, then reply with the word FIRST.', (id) => firstTool(id).then(() => sleep(1500))],
      ['during long text', 'Write the numbers from 1 to 150, one per line, then the word FIRST.', (id) => firstOutput(id).then(() => sleep(800))],
      ['right after the turn starts', 'Run the shell command `sleep 4`, then reply with the word FIRST.', async () => {}],
    ];
    for (const [label, prompt, when] of variants) {
      const id = await startTurn(s, prompt);
      await when(id).catch(() => {});
      let st = 'ok'; try { await request('turn.steer', { ...pick(sessions[s]), turnId: id, input: [{ type: 'text', text: 'Also end your reply with the word SECOND.' }] }); } catch (e) { st = e.message; }
      const e = await endOf(id).catch((err) => ({ method: 'none', error: { message: err.message }, text: '' }));
      const steered = st === 'ok';
      check(s, `steer ${label}: the turn ends`, e.method !== 'none', `steer=${st} ${desc(e)}`);
      if (steered) check(s, `steer ${label}: the steered reply reaches the turn`, /SECOND/.test(e.text), `tail=${JSON.stringify(e.text.slice(-80))}`);
      await recoverable(s, s, `after steer ${label}`);
    }
  },
  async replay() {
    const s = 'basic';
    if (!sessions[s]) { check('replay', 'replay', false, 'basic scenario did not run'); return; }
    try { await create(s, { native: sessions[s].native }); } catch (e) { check('replay', 're-attach before replay', false, e.message); }
    try { const r = await request('session.replay', { ...pick(sessions[s]), cursor: null, limit: 500 }); check('replay', 'session.replay returns history', (r.events?.length ?? 0) > 0, `${r.events?.length} events`); }
    catch (e) { check('replay', 'session.replay returns history', false, e.message); }
  },
};

proxy = startProxy();
try {
  await initialize();
  for (const [name, fn] of Object.entries(scenarios)) {
    if (selected && !selected.has(name)) continue;
    const t0 = Date.now();
    currentScenario = name;
    console.log(`--- ${name}`);
    try { await fn(); } catch (error) { check(name, 'scenario ran to the end', false, error.message); }
    console.log(`    (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  }
} finally {
  results.push({ scenario: 'all', name: 'no Host protocol violations', ok: violations.length === 0 });
  console.log(`${violations.length === 0 ? 'PASS' : 'FAIL'}  [all] no Host protocol violations  (${violations.length})`);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (allErrors.length) console.log(`errors seen (${allErrors.length}):\n  ${[...new Set(allErrors.map(redact))].slice(0, 40).join('\n  ')}`);
  if (failed.length) console.log(`proxy stderr tail:\n${redact(proxy.stderr).slice(-3000)}`);
  try { await request('shutdown', {}, 15000); } catch {}
  await sleep(1500);
  try { proxy.child.kill('SIGKILL'); } catch {}
  try { const left = execSync(`pgrep -f ${JSON.stringify(kimiBin)} || true`).toString().trim(); if (left) console.log(`kimi processes left: ${left.split('\n').length}`); execSync(`pkill -f ${JSON.stringify(kimiBin)} || true`); } catch {}
  console.log(`run dir: ${H}`);
  process.exit(failed.length ? 1 : 0);
}
