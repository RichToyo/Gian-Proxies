import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  createJsonRpcWriter,
  parseWireRequest,
  recoverRequestId,
  WireRequestError,
  wireErrorObject,
} from '../dist/index.js';

const domainMapper = (error) => ({
  code: -32000,
  message: error instanceof Error ? error.message : String(error),
  data: { domainCode: 'INTERNAL', retryable: false, details: {} },
});

test('parseWireRequest separates parse, invalid request and invalid params errors', () => {
  const expectCode = (line, code) => {
    assert.throws(
      () => parseWireRequest(line),
      (error) => error instanceof WireRequestError && error.code === code,
    );
  };
  expectCode('{not-json', -32700);
  expectCode('[]', -32600);
  expectCode('null', -32600);
  expectCode(JSON.stringify({ jsonrpc: '1.0', id: '1', method: 'initialize' }), -32600);
  expectCode(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }), -32600);
  expectCode(JSON.stringify({ jsonrpc: '2.0', id: '', method: 'initialize' }), -32600);
  expectCode(JSON.stringify({ jsonrpc: '2.0', id: '1', method: '' }), -32600);
  expectCode(JSON.stringify({ jsonrpc: '2.0', id: '1', method: 'initialize', params: [] }), -32602);
  expectCode(JSON.stringify({ jsonrpc: '2.0', id: '1', method: 'initialize', params: null }), -32602);
});

test('parseWireRequest returns the request with params defaulted to an empty object', () => {
  assert.deepEqual(
    parseWireRequest(JSON.stringify({ jsonrpc: '2.0', id: 'a', method: 'session.get' })),
    { id: 'a', method: 'session.get', params: {} },
  );
  assert.deepEqual(
    parseWireRequest(JSON.stringify({ jsonrpc: '2.0', id: 'b', method: 'turn.start', params: { x: 1 } })),
    { id: 'b', method: 'turn.start', params: { x: 1 } },
  );
});

test('recoverRequestId correlates a rejected line only when its id is a non-empty string', () => {
  assert.equal(recoverRequestId(JSON.stringify({ jsonrpc: '1.0', id: 'r1' })), 'r1');
  assert.equal(recoverRequestId(JSON.stringify({ id: 7 })), null);
  assert.equal(recoverRequestId(JSON.stringify({ id: '' })), null);
  assert.equal(recoverRequestId('null'), null);
  assert.equal(recoverRequestId('{not-json'), null);
});

test('request-shape errors map to standard objects without domain data; other errors use the Proxy mapper', () => {
  assert.deepEqual(
    wireErrorObject(new WireRequestError(-32602, 'Invalid params.'), domainMapper),
    { code: -32602, message: 'Invalid params.' },
  );
  assert.deepEqual(wireErrorObject(new Error('busy'), domainMapper), {
    code: -32000,
    message: 'busy',
    data: { domainCode: 'INTERNAL', retryable: false, details: {} },
  });
});

test('the writer emits one JSON-RPC 2.0 object per line', () => {
  const output = new PassThrough();
  const chunks = [];
  output.on('data', (chunk) => chunks.push(chunk.toString('utf8')));
  const writer = createJsonRpcWriter(output, domainMapper);
  writer.result('1', { ok: true });
  writer.error(null, new WireRequestError(-32700, 'Parse error.'));
  writer.notification('session.updated', { sessionId: 's' });
  const lines = chunks.join('').split('\n');
  assert.equal(lines.pop(), '');
  assert.deepEqual(lines.map((line) => JSON.parse(line)), [
    { jsonrpc: '2.0', id: '1', result: { ok: true } },
    { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error.' } },
    { jsonrpc: '2.0', method: 'session.updated', params: { sessionId: 's' } },
  ]);
});
