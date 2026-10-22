import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { normalizeKimiError } from '../src/core/service.js';
import { KimiApiError } from '../src/runtime/rest-client.js';

// Official 2.3.0 server-api reference, Error codes / session concurrency:
// https://github.com/MoonshotAI/kimi-code/blob/%40moonshot-ai/kimi-code%402.3.0/docs/en/reference/server-api.md
// These are documented native errors, not a claim that a Provider turn ran.
for (const [code, domain, message] of [
  [40931, 'SESSION_BUSY', 'Session occupied by another client'],
  [40932, 'CONFLICT', 'Session updated by another client'],
] as const) {
  test(`native concurrency error ${code} preserves its meaning without automatic retry`, () => {
    const error = normalizeKimiError(new KimiApiError({ code, msg: message, httpStatus: 409, requestId: 'native-contract-fixture' }));
    assert.equal(error.domainCode, domain);
    assert.equal(error.retryable, false);
    assert.ok(error.message.includes(String(code)));
    assert.ok(error.message.includes(message));
  });
}
