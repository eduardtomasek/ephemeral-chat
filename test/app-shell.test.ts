import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';

import { createAppServer } from '../src/server.js';

test('serves main shell, health endpoint, and baseline security headers', async () => {
  const server = createAppServer();
  await server.listen(0, '127.0.0.1');

  try {
    const address = server.address();
    assert(address && typeof address === 'object');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const [homeResponse, healthResponse] = await Promise.all([
      fetch(`${baseUrl}/`),
      fetch(`${baseUrl}/health`)
    ]);

    assert.equal(homeResponse.status, 200);
    assert.match(homeResponse.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await homeResponse.text(), /Join/i);
    assert.equal(homeResponse.headers.get('x-frame-options'), 'DENY');
    assert.equal(homeResponse.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(homeResponse.headers.get('referrer-policy'), 'no-referrer');

    assert.equal(healthResponse.status, 200);
    assert.deepEqual(await healthResponse.json(), { ok: true });
  } finally {
    const closed = once(server.httpServer, 'close');
    await server.close();
    await closed;
  }
});
