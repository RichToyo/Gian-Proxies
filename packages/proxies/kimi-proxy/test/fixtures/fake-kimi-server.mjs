#!/usr/bin/env node
/**
 * Scriptable fake Kimi Code 2.7 local server (`kimi web --json`) for
 * end-to-end tests of the kimi proxy through its real CLI.
 *
 * Shapes follow kimi-code 2.7.2 (kap-server protocol/session.ts,
 * protocol/conversation.ts, ws-agent.ts, wsConnectionV1.ts) and were checked
 * against the real 2.7.2 binary for the credential-free surface:
 * - `--version` prints the bare version (scenario.version, default 2.7.2);
 * - `web --json --port 0` prints one ready line {origin, ws_url, token,
 *   kimi_agent_protocol_version};
 * - session wire {id, workspace_id, cwd, title, activity, pending_interaction};
 * - `/messages` answers a non-envelope 404 and `/children` 40001;
 * - WS subscribe → response, task.list, agent, context, todo, turns; global
 *   unwrapped `session` events go to every connection.
 *
 * Every request is logged to FAKE_LOG (JSONL).
 */

import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';

const scenarioPath = process.env.FAKE_SCENARIO;
const scenario = scenarioPath ? JSON.parse(fs.readFileSync(scenarioPath, 'utf8')) : {};
const logPath = process.env.FAKE_LOG;
const log = (entry) => {
  if (logPath) fs.appendFileSync(logPath, `${JSON.stringify({ pid: process.pid, ...entry })}\n`);
};

if (process.argv.includes('--version')) {
  log({ kind: 'version', kimiCodeHome: process.env.KIMI_CODE_HOME ?? null });
  process.stdout.write(`${scenario.version ?? '2.7.2'}\n`);
  process.exit(0);
}

log({ kind: 'start', argv: process.argv.slice(2), kimiCodeHome: process.env.KIMI_CODE_HOME ?? null,
  noAutoUpdate: process.env.KIMI_CODE_NO_AUTO_UPDATE ?? null });
if (scenario.behavior?.failStartup) {
  process.stderr.write(`${scenario.behavior.failStartup}\n`);
  process.exit(3);
}

const TOKEN = `ephemeral-${crypto.randomBytes(6).toString('hex')}`;
const now = () => new Date().toISOString();
let requestCounter = 1;
const requestId = () => `01FAKE${String(requestCounter++).padStart(20, '0')}`;

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
const ok = (res, data) => send(res, 200, { code: 0, msg: 'success', data, request_id: requestId() });
const fail = (res, code, msg) => send(res, 200, { code, msg, data: null, request_id: requestId() });

// ---- state ----

const sessions = new Map(); // id -> session
const clients = new Set();
const promptScripts = [...(scenario.prompts ?? [])];
let sessionCounter = 0;

function wire(session) {
  return {
    id: session.id, workspace_id: 'wd_fake', cwd: session.cwd, title: session.title,
    created_at: session.createdAt, updated_at: session.updatedAt,
    activity: session.activity, pending_interaction: session.pendingInteraction, archived: false,
    ...(session.metadata ? { metadata: session.metadata } : {}),
  };
}

function makeSession(cwd, extra = {}) {
  sessionCounter += 1;
  const session = {
    id: extra.id ?? `session_fake_${process.pid}_${sessionCounter}`, cwd, title: extra.title ?? '', createdAt: now(), updatedAt: now(),
    activity: 'idle', pendingInteraction: 'none', metadata: extra.metadata, turns: extra.turns ?? [],
    nextTurnNumber: Math.max(-1, ...(extra.turns ?? []).map(turn => turn.turn_number ?? -1)) + 1,
    active: null, queued: [], interactions: new Map(), prompts: new Set(),
  };
  sessions.set(session.id, session);
  if (typeof persist === 'function') persist();
  return session;
}
// Native sessions persist on disk across server restarts (FAKE_STATE).
const statePath = process.env.FAKE_STATE ?? null;
function persist() {
  if (!statePath) return;
  fs.writeFileSync(statePath, JSON.stringify([...sessions.values()].map(session => ({ id: session.id, cwd: session.cwd,
    title: session.title, metadata: session.metadata, turns: session.turns.filter(turn => turn.status === 'ended') }))));
}
const saved = statePath && fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : null;
for (const seed of saved ?? scenario.sessions ?? []) makeSession(seed.cwd ?? '/tmp/fake-ws', seed);

// ---- WebSocket (minimal RFC6455) ----

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
function wsSendText(socket, text) {
  const payload = Buffer.from(text, 'utf8');
  let header;
  if (payload.length < 126) header = Buffer.from([0x81, payload.length]);
  else if (payload.length <= 0xffff) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(payload.length, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(payload.length), 2); }
  socket.write(Buffer.concat([header, payload]));
}

function broadcast(sessionId, frame) {
  for (const client of clients) {
    if (client.subscriptions.has(sessionId)) client.send({ session_id: sessionId, agent_id: 'main', event_created_at: now(), ...frame });
  }
}
function broadcastGlobal(frame) {
  for (const client of clients) client.send({ ...frame, event_created_at: now() });
}
function setActivity(session, activity, pending = 'none') {
  session.activity = activity; session.pendingInteraction = pending; session.updatedAt = now();
  persist();
  broadcastGlobal({ type: 'session', change: 'updated', session: wire(session) });
}

function snapshot(client, session) {
  client.send({ type: 'task.list', session_id: session.id, agent_id: 'main', tasks: [] });
  const base = { session_id: session.id, agent_id: 'main', event_created_at: now() };
  client.send({ ...base, type: 'agent', status: session.active ? 'running' : 'idle', compacting: false });
  client.send({ ...base, type: 'context', context_tokens: 0 });
  client.send({ ...base, type: 'todo', items: [] });
  client.send({ ...base, type: 'turns', turns: session.turns.slice(-10), has_more: session.turns.length > 10 });
}

function attachWs(req, socket) {
  const accept = crypto.createHash('sha1').update(`${req.headers['sec-websocket-key']}${WS_GUID}`).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay(true);
  const client = { subscriptions: new Set(), buffer: Buffer.alloc(0), send: (value) => wsSendText(socket, JSON.stringify(value)) };
  clients.add(client);
  log({ kind: 'ws-open' });
  socket.on('close', () => clients.delete(client));
  socket.on('error', () => clients.delete(client));
  socket.on('data', (chunk) => {
    client.buffer = Buffer.concat([client.buffer, chunk]);
    for (;;) {
      if (client.buffer.length < 2) return;
      const opcode = client.buffer[0] & 0x0f;
      const masked = (client.buffer[1] & 0x80) !== 0;
      let length = client.buffer[1] & 0x7f; let offset = 2;
      if (length === 126) { if (client.buffer.length < 4) return; length = client.buffer.readUInt16BE(2); offset = 4; }
      else if (length === 127) { if (client.buffer.length < 10) return; length = Number(client.buffer.readBigUInt64BE(2)); offset = 10; }
      let mask = null;
      if (masked) { if (client.buffer.length < offset + 4) return; mask = client.buffer.subarray(offset, offset + 4); offset += 4; }
      if (client.buffer.length < offset + length) return;
      const payload = Buffer.from(client.buffer.subarray(offset, offset + length));
      if (mask) for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
      client.buffer = client.buffer.subarray(offset + length);
      if (opcode === 0x8) { socket.end(); clients.delete(client); return; }
      if (opcode === 0x9) { socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload])); continue; }
      if (opcode !== 0x1) continue;
      let frame;
      try { frame = JSON.parse(payload.toString('utf8')); } catch { continue; }
      log({ kind: 'ws-in', frame });
      if (frame.type === 'subscribe') {
        const session = sessions.get(frame.session_id);
        if (!session) { client.send({ type: 'response', request_id: frame.request_id, code: 40401, msg: 'session not found' }); continue; }
        client.subscriptions.add(session.id);
        client.send({ type: 'response', request_id: frame.request_id, code: 0 });
        snapshot(client, session);
      } else if (frame.type === 'unsubscribe') {
        client.subscriptions.delete(frame.session_id);
        client.send({ type: 'response', request_id: frame.request_id, code: 0 });
      }
    }
  });
}

// ---- scripted turns ----

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function turnHeader(turn) {
  const { items: _items, ...header } = turn;
  return header;
}

async function runTurn(session, promptId, script, text) {
  const turnNumber = session.nextTurnNumber++;
  const turn = {
    turn_id: `turn_${session.id}_${turnNumber}`, ordinal: session.turns.length, turn_number: turnNumber, kind: 'agent',
    status: 'running', started_at: now(), steps: [], items: [],
  };
  session.turns.push(turn);
  session.active = { promptId, turn, aborted: false };
  setActivity(session, 'turn');
  broadcast(session.id, { type: 'agent', status: 'running', compacting: false });
  broadcast(session.id, { type: 'turn.started', turn: turnHeader(turn) });
  const opener = { type: 'user_message', item_id: `u_${turnNumber}`, status: 'ended', created_at: now(), prompt_ids: [promptId],
    placement: 'opener', origin: { kind: 'user' }, text, attachments: [], skills: [] };
  turn.items.push(opener);
  broadcast(session.id, { type: 'item.ended', turn_id: turn.turn_id, item: opener });
  if (script.retry) {
    broadcast(session.id, { type: 'turn.updated', turn_id: turn.turn_id, retry: { attempt: 1, next_attempt: 2, max_attempts: 3, delay_ms: 1000,
      error: { name: 'APIError', message: script.retry, status_code: 503 } } });
    broadcast(session.id, { type: 'turn.updated', turn_id: turn.turn_id, step: { index: 1, outcome: 'completed', started_at: now() } });
  }
  if (script.notice) broadcast(session.id, { type: 'notice', ...script.notice });
  if (script.approval) {
    const interactionId = `i_${turnNumber}`;
    const tool = { type: 'tool_call', item_id: `tool_${turnNumber}`, status: 'running', created_at: now(), started_at: now(), name: 'Bash', stage: 'awaiting_approval', interaction_id: interactionId };
    broadcast(session.id, { type: 'item.started', turn_id: turn.turn_id, item: tool });
    const decided = new Promise((resolve) => session.interactions.set(interactionId, resolve));
    setActivity(session, 'turn', 'approval');
    broadcast(session.id, { type: 'interaction', status: 'pending', kind: 'approval', interaction_id: interactionId, tool_call_id: tool.item_id,
      request: { tool_name: 'Bash', action: 'pwd', expires_at: new Date(Date.now() + 600_000).toISOString() } });
    const decision = await decided;
    broadcast(session.id, { type: 'interaction', status: 'ended', kind: 'approval', interaction_id: interactionId, tool_call_id: tool.item_id, outcome: decision });
    setActivity(session, 'turn');
    const ended = { ...tool, status: 'ended', outcome: decision === 'approved' ? 'completed' : 'failed', output: '/tmp', ended_at: now() };
    turn.items.push(ended);
    broadcast(session.id, { type: 'item.ended', turn_id: turn.turn_id, item: ended });
  }
  if (script.reply !== undefined) {
    const item = { type: 'assistant_message', item_id: `a_${turnNumber}`, status: 'running', created_at: now(), text: '' };
    broadcast(session.id, { type: 'item.started', turn_id: turn.turn_id, item });
    broadcast(session.id, { type: 'item.delta', turn_id: turn.turn_id, item_id: item.item_id, field: 'text', delta: script.reply });
    const ended = { ...item, status: 'ended', outcome: 'completed', text: script.reply };
    turn.items.push(ended);
    broadcast(session.id, { type: 'item.ended', turn_id: turn.turn_id, item: ended });
  }
  if (script.hold) {
    while (!session.active.aborted) await wait(10);
  }
  Object.assign(turn, {
    status: 'ended', ended_at: now(),
    outcome: session.active.aborted ? 'interrupted' : script.outcome ?? 'completed',
    ...(session.active.aborted ? { end_reason: 'user_cancelled' } : script.endReason ? { end_reason: script.endReason } : {}),
    ...(script.error && !session.active.aborted ? { error: script.error } : {}),
    ...(script.usage ? { usage: script.usage } : {}),
  });
  broadcast(session.id, { type: 'turn.ended', turn: turnHeader(turn) });
  session.active = null;
  broadcast(session.id, { type: 'agent', status: 'idle', compacting: false });
  setActivity(session, 'idle');
  const next = session.queued.shift();
  if (next) void runTurn(session, next.promptId, next.script, next.text);
}

/** A background-notification turn owned by nobody (no opener). */
async function runForeignTurn(session, delayMs) {
  const turnNumber = session.nextTurnNumber++;
  const turn = { turn_id: `turn_${session.id}_${turnNumber}`, ordinal: session.turns.length, turn_number: turnNumber, kind: 'agent',
    status: 'running', started_at: now(), steps: [], items: [] };
  session.turns.push(turn);
  session.active = { promptId: null, turn, aborted: false };
  setActivity(session, 'turn');
  broadcast(session.id, { type: 'agent', status: 'running', compacting: false });
  broadcast(session.id, { type: 'turn.started', turn: turnHeader(turn) });
  await wait(delayMs);
  Object.assign(turn, { status: 'ended', outcome: 'completed', ended_at: now() });
  broadcast(session.id, { type: 'turn.ended', turn: turnHeader(turn) });
  session.active = null;
  broadcast(session.id, { type: 'agent', status: 'idle', compacting: false });
  setActivity(session, 'idle');
  const next = session.queued.shift();
  if (next) void runTurn(session, next.promptId, next.script, next.text);
}

// ---- REST ----

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw === '' ? {} : JSON.parse(raw);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const path = decodeURIComponent(url.pathname);
  if (path === '/api/v1/healthz') return ok(res, { ok: true });
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { code: 40100, msg: 'unauthorized', data: null });
  const body = req.method === 'POST' ? await readBody(req) : {};
  log({ kind: 'request', method: req.method, path, query: Object.fromEntries(url.searchParams), body });

  if (path === '/api/v1/shutdown') { ok(res, {}); setTimeout(() => process.exit(0), 10); return; }
  if (path === '/api/v1/models') return ok(res, { items: scenario.models ?? [] });
  if (path === '/api/v1/config') return ok(res, { default_model: scenario.default_model ?? '' });
  if (path === '/api/v1/sessions' && req.method === 'POST') {
    const session = makeSession(body.cwd ?? body.metadata?.cwd);
    broadcastGlobal({ type: 'session', change: 'created', session: wire(session) });
    return ok(res, wire(session));
  }
  if (path === '/api/v1/sessions' && req.method === 'GET') {
    return ok(res, { items: [...sessions.values()].map(wire), has_more: false });
  }
  const action = /^\/api\/v1\/sessions\/([^/:]+):([a-z]+)$/.exec(path);
  if (action) {
    const session = sessions.get(action[1]);
    if (!session) return fail(res, 40401, `session ${action[1]} does not exist`);
    if (action[2] === 'delete') { sessions.delete(session.id); return ok(res, {}); }
    if (action[2] !== 'fork') return fail(res, 40001, `unsupported action: ${action[2]}`);
    let turns = session.turns;
    if (body.turn_index !== undefined) {
      if (!session.turns.some(turn => turn.turn_number === body.turn_index)) {
        return fail(res, 40001, `Turn ${body.turn_index} was not found in session "${session.id}"`);
      }
      turns = session.turns.filter(turn => turn.turn_number <= body.turn_index);
    }
    const fork = makeSession(session.cwd, { title: body.title ?? `Fork: ${session.title || session.id}`,
      metadata: body.metadata, turns: structuredClone(turns) });
    return ok(res, wire(fork));
  }
  const match = /^\/api\/v1\/sessions\/([^/:]+)(\/.*)?$/.exec(path);
  if (!match) return send(res, 404, { message: `Route ${req.method}:${path} not found`, statusCode: 404 });
  const session = sessions.get(match[1]);
  const rest = match[2] ?? '';
  if (!session) return fail(res, 40401, `session ${match[1]} does not exist`);
  if (rest === '' && req.method === 'GET') return ok(res, wire(session));
  if (rest === '/profile') { session.title = body.title ?? session.title; return ok(res, wire(session)); }
  if (rest === '/agents/main/turns') return ok(res, { turns: session.turns, has_more: false });
  if (rest === '/file-history/changes') return ok(res, { recorded: false, changes: [] });
  if (rest === '/children') return fail(res, 40001, 'unsupported action: children');
  if (rest === '/prompts' && req.method === 'GET') {
    return ok(res, { active: session.active?.promptId ? { prompt_id: session.active.promptId, status: 'running' } : null,
      queued: session.queued.map(entry => ({ prompt_id: entry.promptId, status: 'queued' })) });
  }
  if (rest === '/prompts' && req.method === 'POST') {
    if (session.prompts.has(body.prompt_id)) return fail(res, 40927, 'prompt_id conflict');
    session.prompts.add(body.prompt_id);
    const text = (body.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('');
    if (session.active && session.active.promptId !== null && session.active.turn) {
      // Running native turn: the prompt waits (a later prompts:steer may promote it).
      session.queued.push({ promptId: body.prompt_id, script: {}, text, steer: true });
      return ok(res, { prompt_id: body.prompt_id, status: 'queued' });
    }
    const script = promptScripts.shift() ?? { reply: 'ok' };
    if (script.postDelayMs) await wait(script.postDelayMs);
    if (script.status === 'failed') {
      const turnNumber = session.nextTurnNumber++;
      session.turns.push({ turn_id: `turn_${session.id}_${turnNumber}`, ordinal: session.turns.length, turn_number: turnNumber,
        kind: 'agent', status: 'ended', outcome: 'failed', end_reason: 'error', error: script.error, started_at: now(), ended_at: now(), steps: [],
        items: [{ type: 'user_message', item_id: `u_${turnNumber}`, status: 'ended', created_at: now(), prompt_ids: [body.prompt_id],
          placement: 'opener', origin: { kind: 'user' }, text, attachments: [], skills: [] }] });
      return ok(res, { prompt_id: body.prompt_id, status: 'failed' });
    }
    if (script.queueBehind) {
      session.queued.push({ promptId: body.prompt_id, script, text });
      void runForeignTurn(session, script.queueBehind);
      return ok(res, { prompt_id: body.prompt_id, status: 'queued' });
    }
    void runTurn(session, body.prompt_id, script, text);
    return ok(res, { prompt_id: body.prompt_id, status: 'running' });
  }
  if (rest === '/prompts:steer') {
    const ids = new Set(body.prompt_ids ?? []);
    const steered = session.queued.filter(entry => ids.has(entry.promptId));
    session.queued = session.queued.filter(entry => !ids.has(entry.promptId));
    if (steered.length === 0 || !session.active) return fail(res, 40402, 'no active turn');
    for (const entry of steered) {
      const item = { type: 'user_message', item_id: `steer_${entry.promptId}`, status: 'ended', created_at: now(), prompt_ids: [entry.promptId],
        placement: 'steer', origin: { kind: 'user' }, text: entry.text, attachments: [], skills: [] };
      session.active.turn.items.push(item);
      broadcast(session.id, { type: 'item.ended', turn_id: session.active.turn.turn_id, item });
    }
    return ok(res, { steered: true, prompt_ids: [...ids] });
  }
  const abort = /^\/prompts\/([^/:]+):abort$/.exec(rest);
  if (abort) {
    const queuedIndex = session.queued.findIndex(entry => entry.promptId === abort[1]);
    if (queuedIndex >= 0) { session.queued.splice(queuedIndex, 1); return ok(res, { aborted: true }); }
    if (session.active?.promptId === abort[1]) { session.active.aborted = true; return ok(res, { aborted: true }); }
    return fail(res, 40402, `prompt ${abort[1]} not found`);
  }
  const interaction = /^\/interactions\/([^/]+)$/.exec(rest);
  if (interaction) {
    const resolve = session.interactions.get(interaction[1]);
    if (!resolve) return fail(res, 40404, 'interaction not found');
    session.interactions.delete(interaction[1]);
    resolve(body.decision);
    return ok(res, { outcome: body.decision });
  }
  return send(res, 404, { message: `Route ${req.method}:${path} not found`, statusCode: 404 });
});

server.on('upgrade', (req, socket) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (url.pathname !== '/api/v1/ws' || req.headers.authorization !== `Bearer ${TOKEN}`) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  attachWs(req, socket);
});

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;
  process.stdout.write(`${JSON.stringify({ origin, ws_url: `ws://127.0.0.1:${port}/api/v1/ws`, token: TOKEN, kimi_agent_protocol_version: '1.0.0' })}\n`);
  if (scenario.behavior?.exitAfterMs) setTimeout(() => process.exit(9), scenario.behavior.exitAfterMs).unref();
});

process.on('SIGTERM', () => process.exit(0));
