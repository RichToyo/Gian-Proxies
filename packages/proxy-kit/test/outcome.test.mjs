import assert from 'node:assert/strict';
import test from 'node:test';

import { isJsonRpcErrorObject, resolveDispatchOutcome } from '../dist/index.js';

test('resolveDispatchOutcome emits the request notifications in order and returns the result', () => {
  const emitted = [];
  const result = resolveDispatchOutcome({
    ok: true,
    result: { accepted: true },
    notifications: [
      { method: 'turn.started', params: { n: 1 } },
      { method: 'content.delta', params: { n: 2 } },
    ],
  }, (method, params) => emitted.push([method, params.n]));
  assert.deepEqual(result, { accepted: true });
  assert.deepEqual(emitted, [['turn.started', 1], ['content.delta', 2]]);
});

test('resolveDispatchOutcome still emits on failure, then throws the outcome error', () => {
  const emitted = [];
  const error = { code: -32000, message: 'busy', data: { domainCode: 'SESSION_BUSY', retryable: true } };
  assert.throws(
    () => resolveDispatchOutcome(
      { ok: false, error, notifications: [{ method: 'session.updated', params: {} }] },
      (method) => emitted.push(method),
    ),
    (thrown) => thrown === error,
  );
  assert.deepEqual(emitted, ['session.updated']);
});

test('isJsonRpcErrorObject accepts only integer codes with string messages', () => {
  assert.equal(isJsonRpcErrorObject({ code: -32603, message: 'x' }), true);
  assert.equal(isJsonRpcErrorObject({ code: -32603, message: 'x', data: {} }), true);
  assert.equal(isJsonRpcErrorObject({ code: '1', message: 'x' }), false);
  assert.equal(isJsonRpcErrorObject({ code: 1.5, message: 'x' }), false);
  assert.equal(isJsonRpcErrorObject(new Error('x')), false);
  assert.equal(isJsonRpcErrorObject(null), false);
});
