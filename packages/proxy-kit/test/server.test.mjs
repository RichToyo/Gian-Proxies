import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { runProxyServer } from '../dist/index.js';

const domainMapper = (error) => ({
  code: -32000,
  message: error instanceof Error ? error.message : String(error),
  data: { domainCode: 'INTERNAL', retryable: false, details: {} },
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function startServer({ handle, close = async () => {}, pipelinedMethods, overtakeMethods } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const messages = [];
  let pending = '';
  output.on('data', (chunk) => {
    pending += chunk.toString('utf8');
    let newline;
    while ((newline = pending.indexOf('\n')) >= 0) {
      messages.push(JSON.parse(pending.slice(0, newline)));
      pending = pending.slice(newline + 1);
    }
  });
  let emit;
  let emitImmediate;
  const exitCodes = [];
  const exited = runProxyServer({
    tag: 'test',
    toJsonRpcError: domainMapper,
    processHooks: false,
    exit: (code) => { exitCodes.push(code); },
    input,
    output,
    ...(pipelinedMethods ? { pipelinedMethods } : {}),
    ...(overtakeMethods ? { overtakeMethods } : {}),
    createHandler: async (emitter, immediate) => {
      emit = emitter;
      emitImmediate = immediate;
      return { handle: (request) => handle(request, emitter, immediate), close };
    },
  });
  const send = (value) => {
    input.write(typeof value === 'string' ? `${value}\n` : `${JSON.stringify(value)}\n`);
  };
  const request = (id, method, params) => send({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
  const waitFor = async (predicate, label) => {
    const deadline = Date.now() + 2_000;
    while (!messages.some(predicate)) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  return {
    input,
    send,
    request,
    messages,
    exited,
    exitCodes,
    waitFor,
    emit: (...args) => emit(...args),
    emitImmediate: (...args) => emitImmediate(...args),
  };
}

const isResponse = (id) => (message) => message.id === id && ('result' in message || 'error' in message);
const shape = (message) => (message.method ? `notify:${message.method}` : `${'error' in message ? 'error' : 'result'}:${message.id}`);

test('notifications emitted inside a session handler are written after its response', async () => {
  const server = startServer({
    handle: async (request, emit) => {
      emit('turn.started', { turnId: 't1' });
      emit('content.delta', { text: 'hi' });
      return { accepted: true, method: request.method };
    },
  });
  server.request('1', 'turn.start');
  server.input.end();
  assert.equal(await server.exited, 0);
  assert.deepEqual(server.messages.map(shape), ['result:1', 'notify:turn.started', 'notify:content.delta']);
  assert.deepEqual(server.exitCodes, [0]);
});

test('sidechat.close writes its teardown notifications before the response (Contract §10.5.4)', async () => {
  const server = startServer({
    handle: async (_request, emit) => {
      emit('turn.completed', { turnId: 't1' });
      return { ok: true };
    },
  });
  server.request('1', 'sidechat.close');
  server.input.end();
  await server.exited;
  assert.deepEqual(server.messages.map(shape), ['notify:turn.completed', 'result:1']);
});

test('spontaneous notifications with no session handler active are written immediately', async () => {
  const server = startServer({ handle: async () => ({}) });
  await new Promise((resolve) => setImmediate(resolve));
  server.emit('runtime.error', { reason: 'native exit' });
  assert.deepEqual(server.messages.map(shape), ['notify:runtime.error']);
  server.input.end();
  await server.exited;
});

test('a handler error is mapped through the Proxy mapper and still flushes captured notifications after it', async () => {
  const server = startServer({
    handle: async (_request, emit) => {
      emit('session.updated', { state: 'error' });
      throw new Error('native refused');
    },
  });
  server.request('1', 'session.create');
  server.input.end();
  await server.exited;
  assert.deepEqual(server.messages.map(shape), ['error:1', 'notify:session.updated']);
  assert.deepEqual(server.messages[0].error, {
    code: -32000,
    message: 'native refused',
    data: { domainCode: 'INTERNAL', retryable: false, details: {} },
  });
});

test('session requests are strictly serialized in arrival order', async () => {
  const gate = deferred();
  const started = [];
  const server = startServer({
    handle: async (request) => {
      started.push(request.id);
      if (request.id === '1') await gate.promise;
      return {};
    },
  });
  server.request('1', 'session.create');
  server.request('2', 'session.get');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(started, ['1'], 'the second session request must wait for the first');
  gate.resolve();
  server.input.end();
  await server.exited;
  assert.deepEqual(started, ['1', '2']);
  assert.deepEqual(server.messages.map(shape), ['result:1', 'result:2']);
});

test('a pipelined request overtakes a blocked session request and never captures its notifications', async () => {
  const gate = deferred();
  const server = startServer({
    pipelinedMethods: new Set(['customization.list']),
    handle: async (request, emit) => {
      if (request.method === 'customization.list') return { items: [] };
      emit('turn.started', { turnId: 't1' });
      await gate.promise;
      return { accepted: true };
    },
  });
  server.request('turn', 'turn.start');
  server.request('scan', 'customization.list');
  await server.waitFor(isResponse('scan'), 'the scan response');
  assert.deepEqual(server.messages.map(shape), ['result:scan'],
    'the scan must answer while the session request is in flight, without flushing its capture');
  gate.resolve();
  server.input.end();
  await server.exited;
  assert.deepEqual(server.messages.map(shape), ['result:scan', 'result:turn', 'notify:turn.started']);
});

test('malformed lines are answered with the recovered id and the server stays responsive', async () => {
  const server = startServer({ handle: async () => ({ ok: true }) });
  server.send('{not-json');
  server.send({ jsonrpc: '1.0', id: 'bad-version', method: 'initialize' });
  server.send({ jsonrpc: '2.0', id: 'bad-params', method: 'initialize', params: [] });
  server.send('');
  server.send('   ');
  server.request('ok', 'initialize');
  server.input.end();
  assert.equal(await server.exited, 0);
  assert.deepEqual(server.messages, [
    { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error.' } },
    { jsonrpc: '2.0', id: 'bad-version', error: { code: -32600, message: 'Invalid Request.' } },
    { jsonrpc: '2.0', id: 'bad-params', error: { code: -32602, message: 'Invalid params.' } },
    { jsonrpc: '2.0', id: 'ok', result: { ok: true } },
  ]);
});

test('invalid UTF-8 is a framing violation: PARSE_ERROR with a null id, then exit 1', async () => {
  const handled = [];
  const server = startServer({ handle: async (request) => { handled.push(request.id); return {}; } });
  server.input.write(Buffer.from([0x7b, 0xff, 0x7d, 0x0a]));
  assert.equal(await server.exited, 1);
  assert.deepEqual(handled, []);
  assert.equal(server.messages.length, 1);
  assert.equal(server.messages[0].id, null);
  assert.equal(server.messages[0].error.code, -32700);
  assert.match(server.messages[0].error.message, /UTF-8/);
});

test('an oversized line is rejected while still buffering, before any newline arrives', async () => {
  const server = startServer({ handle: async () => ({}) });
  server.input.write(Buffer.alloc(16 * 1024 * 1024 + 1, 0x61));
  assert.equal(await server.exited, 1);
  assert.equal(server.messages.length, 1);
  assert.equal(server.messages[0].error.code, -32700);
  assert.match(server.messages[0].error.message, /exceeds/);
});

test('shutdown answers, drains in-flight work, closes the handler once, exits 0 and stops reading', async () => {
  const scanGate = deferred();
  const order = [];
  const server = startServer({
    pipelinedMethods: new Set(['customization.list']),
    handle: async (request) => {
      order.push(`handle:${request.id}`);
      if (request.method === 'customization.list') await scanGate.promise;
      return {};
    },
    close: async () => { order.push('close'); },
  });
  server.request('scan', 'customization.list');
  server.request('bye', 'shutdown');
  await server.waitFor(isResponse('bye'), 'the shutdown response');
  server.request('late', 'session.get');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(server.exitCodes, [], 'shutdown must wait for the in-flight scan');
  scanGate.resolve();
  assert.equal(await server.exited, 0);
  assert.deepEqual(order, ['handle:scan', 'handle:bye', 'close']);
  assert.deepEqual(server.messages.map(shape), ['result:bye', 'result:scan']);
  assert.deepEqual(server.exitCodes, [0], 'exit must be called exactly once');
});

test('EOF drains an in-flight pipelined request before exiting', async () => {
  const scanGate = deferred();
  const server = startServer({
    pipelinedMethods: new Set(['customization.list']),
    handle: async () => { await scanGate.promise; return { items: [] }; },
  });
  server.request('scan', 'customization.list');
  server.input.end();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(server.exitCodes, []);
  scanGate.resolve();
  assert.equal(await server.exited, 0);
  assert.deepEqual(server.messages.map(shape), ['result:scan']);
});

test('a failing handler close turns the shutdown into exit 1', async () => {
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => { errors.push(args.join(' ')); };
  try {
    const server = startServer({
      handle: async () => ({}),
      close: async () => { throw new Error('native runtime did not stop'); },
    });
    server.input.end();
    assert.equal(await server.exited, 1);
    assert.deepEqual(server.exitCodes, [1]);
    assert.ok(errors.some((line) => line.includes('[test:shutdown] cleanup failed: native runtime did not stop')));
  } finally {
    console.error = originalError;
  }
});

test('an overtake request answers while a session request is blocked, and both hold notifications until the last is answered', async () => {
  const turnGate = deferred();
  const server = startServer({
    overtakeMethods: new Set(['interaction.respond']),
    handle: async (request, emit) => {
      if (request.method === 'turn.start') {
        emit('turn.started', { turnId: 't1' });
        await turnGate.promise;
        return { accepted: true };
      }
      emit('interaction.resolved', { interactionId: 'i1' });
      return { ok: true };
    },
  });
  server.request('turn', 'turn.start');
  server.request('answer', 'interaction.respond');
  await server.waitFor(isResponse('answer'), 'the overtake response');
  assert.deepEqual(server.messages.map(shape), ['result:answer'],
    'the overtake must answer while turn.start is in flight, and its notification stays held');
  turnGate.resolve();
  server.input.end();
  await server.exited;
  assert.deepEqual(server.messages.map(shape), [
    'result:answer',
    'result:turn',
    'notify:turn.started',
    'notify:interaction.resolved',
  ]);
});

test('without overtakeMethods the same request waits behind the session lane', async () => {
  const turnGate = deferred();
  const started = [];
  const server = startServer({
    handle: async (request) => {
      started.push(request.method);
      if (request.method === 'turn.start') await turnGate.promise;
      return {};
    },
  });
  server.request('turn', 'turn.start');
  server.request('answer', 'interaction.respond');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(started, ['turn.start']);
  turnGate.resolve();
  server.input.end();
  await server.exited;
  assert.deepEqual(server.messages.map(shape), ['result:turn', 'result:answer']);
});

test('emitImmediate writes even while a request is in flight; emit stays held', async () => {
  const gate = deferred();
  const server = startServer({
    handle: async (_request, emit, emitImmediate) => {
      emit('caused.by.request', {});
      emitImmediate('other.session.delta', {});
      await gate.promise;
      return {};
    },
  });
  server.request('1', 'session.create');
  await server.waitFor((message) => message.method === 'other.session.delta', 'the immediate notification');
  assert.deepEqual(server.messages.map(shape), ['notify:other.session.delta']);
  gate.resolve();
  server.input.end();
  await server.exited;
  assert.deepEqual(server.messages.map(shape), ['notify:other.session.delta', 'result:1', 'notify:caused.by.request']);
});

test('laneKey serializes per lane: a blocked session does not hold back another session', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const messages = [];
  let pending = '';
  output.on('data', (chunk) => {
    pending += chunk.toString('utf8');
    let newline;
    while ((newline = pending.indexOf('\n')) >= 0) {
      messages.push(JSON.parse(pending.slice(0, newline)));
      pending = pending.slice(newline + 1);
    }
  });
  const gate = deferred();
  void runProxyServer({
    tag: 'test',
    toJsonRpcError: domainMapper,
    processHooks: false,
    exit: () => {},
    input,
    output,
    laneKey: (request) => String(request.params.sessionId ?? ''),
    createHandler: async () => ({
      handle: async (request) => {
        if (request.id === 'a1') await gate.promise;
        return { id: request.id };
      },
      close: async () => {},
    }),
  });
  const send = (id, sessionId) => input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'turn.start', params: { sessionId } })}\n`);
  send('a1', 'a');
  send('a2', 'a');
  send('b1', 'b');
  const deadline = Date.now() + 2_000;
  while (!messages.some((m) => m.id === 'b1')) {
    if (Date.now() > deadline) throw new Error('timed out waiting for b1');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.deepEqual(messages.map((m) => m.id), ['b1'], 'session b answers while session a is blocked');
  gate.resolve();
  while (messages.length < 3) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(messages.map((m) => m.id), ['b1', 'a1', 'a2']);
  input.end();
});

test('a responding handler writes its Response when it calls respond, before its own later notifications', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = [];
  let pending = '';
  output.on('data', (chunk) => {
    pending += chunk.toString('utf8');
    let newline;
    while ((newline = pending.indexOf('\n')) >= 0) {
      lines.push(JSON.parse(pending.slice(0, newline)));
      pending = pending.slice(newline + 1);
    }
  });
  void runProxyServer({
    tag: 'test',
    toJsonRpcError: domainMapper,
    processHooks: false,
    exit: () => {},
    input,
    output,
    createHandler: async (_emit, emitImmediate) => ({
      dispatch: async (request, respond) => {
        if (request.id === 'silent') return;
        respond({ accepted: true });
        emitImmediate('turn.started', { turnId: 't1' });
      },
      close: async () => {},
    }),
  });
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'r1', method: 'turn.start', params: {} })}\n`);
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'silent', method: 'turn.start', params: {} })}\n`);
  const deadline = Date.now() + 2_000;
  while (lines.length < 3) {
    if (Date.now() > deadline) throw new Error('timed out waiting for output');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(lines[0].id, 'r1');
  assert.deepEqual(lines[0].result, { accepted: true });
  assert.equal(lines[1].method, 'turn.started', 'the notification follows the Response it was emitted after');
  assert.equal(lines[2].id, 'silent');
  assert.ok(lines[2].error, 'a dispatch that never responds is answered with an error');
  input.end();
});
