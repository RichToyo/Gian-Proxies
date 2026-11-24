import assert from 'node:assert/strict';
import test from 'node:test';

import { nativeTurnError } from '../src/core/service.js';
import { DshV2Adapter, normalizeError } from '../src/protocol/v2-adapter.js';
import { BridgeClientError } from '../src/runtime/bridge-client.js';

test('native DSH failures keep their own text and map credential codes to RUNTIME_AUTH_REQUIRED', () => {
  const missing = nativeTurnError({
    code: 'MISSING_CREDENTIAL',
    message: 'openai: credential OPENAI_API_KEY is not configured',
  }, '/agent/home');
  assert.equal(missing.domainCode, 'RUNTIME_AUTH_REQUIRED');
  assert.equal(missing.retryable, false);
  assert.match(missing.message, /^openai: credential OPENAI_API_KEY is not configured /);
  assert.match(missing.message, /\/agent\/home\/\.credentials\.yaml/);
  assert.equal(missing.details.nativeCode, 'MISSING_CREDENTIAL');
  assert.equal(nativeTurnError({ code: 'AUTH', message: 'HTTP 401' }).domainCode, 'RUNTIME_AUTH_REQUIRED');

  const rate = nativeTurnError({ code: 'RATE_LIMIT', message: 'slow down', status: 429, requestId: 'req-1' });
  assert.deepEqual([rate.domainCode, rate.message, rate.retryable], ['RUNTIME_ERROR', 'slow down', true]);
  assert.deepEqual([rate.details.status, rate.details.requestId], [429, 'req-1']);
  for (const code of ['QUOTA', 'ACCOUNT_QUOTA', 'CONTENT_REFUSED', 'UNKNOWN']) {
    const failure = nativeTurnError({ code, message: `native ${code}` });
    assert.deepEqual([failure.domainCode, failure.message, failure.retryable], ['RUNTIME_ERROR', `native ${code}`, false]);
  }
  assert.equal(nativeTurnError({ code: 'HTTP_503', message: 'unavailable' }).retryable, true);
  assert.equal(nativeTurnError(null).message, 'DeepSeek Harness turn failed (UNKNOWN).');
});

test('Bridge errors keep their text, gian.proxy domain code and retryability', () => {
  assert.deepEqual(normalizeError(new BridgeClientError(-32000, 'SESSION_BUSY: busy', 'SESSION_BUSY')), {
    code: -32000,
    message: 'SESSION_BUSY: busy',
    data: { domainCode: 'SESSION_BUSY', retryable: false, details: { bridgeCode: -32000 } },
  });
  assert.deepEqual(normalizeError(new BridgeClientError(-32000, 'odd', 'NATIVE_ODDITY', true)).data, {
    domainCode: 'RUNTIME_ERROR',
    retryable: true,
    details: { bridgeCode: -32000, nativeCode: 'NATIVE_ODDITY' },
  });
  assert.equal(normalizeError(new BridgeClientError(-32603, 'plain')).data?.domainCode, 'RUNTIME_ERROR');
});

function bridge(handlers: Record<string, (params: Record<string, unknown>) => Record<string, unknown>>) {
  const listeners = new Set<(n: { method: string; params: Record<string, unknown> }) => void>();
  return {
    listeners,
    push(method: string, params: Record<string, unknown>) { for (const listener of listeners) listener({ method, params }); },
    async request(method: string, params: Record<string, unknown> = {}) {
      const handler = handlers[method];
      if (!handler) throw new Error(`unexpected ${method}`);
      return handler(params);
    },
    onNotification(listener: (n: { method: string; params: Record<string, unknown> }) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const INITIALIZE = { protocol: { name: 'gian.proxy', versions: ['2.1'] }, host: { name: 'test', version: '0' } };

test('a home without a usable Provider initializes and answers an actionable RUNTIME_AUTH_REQUIRED', async () => {
  let configured = false;
  const fake = bridge({
    initialize: () => ({ protocol: { name: 'gian.dsh.bridge', version: '1.0' }, capabilities: {} }),
    'catalog.list': () => {
      if (!configured) {
        throw new BridgeClientError(-32000, 'DeepSeek Harness has no model Provider with a usable credential in /h.', 'RUNTIME_AUTH_REQUIRED');
      }
      return {
        catalogRevision: 'r1',
        providers: [{ id: 'openai', label: 'OpenAI' }],
        models: [{ id: 'gpt-5.4-mini', provider: 'openai' }],
      };
    },
  });
  const adapter = new DshV2Adapter(fake as never, { pluginVersion: '0.0.0', dshHome: '/h' });
  const init = await adapter.dispatch({ id: '1', method: 'initialize', params: INITIALIZE });
  assert.equal(init.ok, true);
  const listed = await adapter.dispatch({ id: '2', method: 'catalog.list', params: {} });
  assert.equal(listed.ok, false);
  assert.equal(listed.error?.data?.domainCode, 'RUNTIME_AUTH_REQUIRED');
  assert.match(listed.error?.message ?? '', /usable credential/);
  configured = true;
  const recovered = await adapter.dispatch({ id: '3', method: 'catalog.list', params: {} });
  assert.equal(recovered.ok, true);
});

test('providers without a selectable model are a setup error, not RUNTIME_UNAVAILABLE', async () => {
  const fake = bridge({
    initialize: () => ({ protocol: { name: 'gian.dsh.bridge', version: '1.0' }, capabilities: {} }),
    'catalog.list': () => ({ catalogRevision: 'r1', providers: [{ id: 'deepseek-official' }], models: [] }),
  });
  const adapter = new DshV2Adapter(fake as never, { pluginVersion: '0.0.0', dshHome: '/h' });
  assert.equal((await adapter.dispatch({ id: '1', method: 'initialize', params: INITIALIZE })).ok, true);
  const listed = await adapter.dispatch({ id: '2', method: 'catalog.list', params: {} });
  assert.equal(listed.error?.data?.domainCode, 'RUNTIME_AUTH_REQUIRED');
  assert.match(listed.error?.message ?? '', /\/h\/\.credentials\.yaml/);
});
