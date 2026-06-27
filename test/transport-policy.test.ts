import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';

import WebSocket from 'ws';

import { deriveRoomIdFromSharedKey, loadConfig } from '../src/config.js';
import { createAppServer } from '../src/server.js';

type SocketHarness = {
  socket: WebSocket;
  nextMessage: <T>() => Promise<T>;
};

function connectUnexpected(url: string, origin: string, onOpen?: (socket: WebSocket) => void) {
  return new Promise<number>((resolve, reject) => {
    const socket = new WebSocket(url, {
      headers: { Origin: origin }
    });

    socket.once('unexpected-response', (_request, response) => {
      resolve(response.statusCode ?? 0);
    });
    socket.once('open', () => {
      onOpen?.(socket);
    });
    socket.once('close', (code) => {
      resolve(code);
    });
    socket.once('error', reject);
  });
}

function openSocket(url: string, origin: string) {
  return new Promise<SocketHarness>((resolve, reject) => {
    const socket = new WebSocket(url, {
      headers: { Origin: origin }
    });
    const queue: unknown[] = [];
    const waiters: Array<(value: unknown) => void> = [];

    socket.on('message', (data) => {
      const parsed = JSON.parse(String(data));
      const waiter = waiters.shift();
      if (waiter) {
        waiter(parsed);
        return;
      }

      queue.push(parsed);
    });

    socket.once('open', () => resolve({
      socket,
      nextMessage() {
        const next = queue.shift();
        if (next !== undefined) {
          return Promise.resolve(next as T);
        }

        return new Promise((messageResolve) => {
          waiters.push(messageResolve as (value: unknown) => void);
        });
      }
    }));
    socket.once('error', reject);
  });
}

function waitForClose(harness: SocketHarness) {
  return once(harness.socket, 'close').then(([code]) => code as number);
}

function waitForCloseDetails(harness: SocketHarness) {
  return once(harness.socket, 'close').then(([code, reason]) => ({
    code: code as number,
    reason: String(reason)
  }));
}

function sendJoin(socket: WebSocket, roomId: string, roomSettings?: Record<string, unknown>) {
  socket.send(JSON.stringify({
    type: 'join',
    roomId,
    ...(roomSettings ? { roomSettings } : {})
  }));
}

test('rejects invalid origin, invalid room ids, and forbidden single-room joins before admission', async () => {
  const config = loadConfig({
    env: {
      SINGLE_ROOM_MODE: 'true',
      SINGLE_ROOM_KEY: 'only-this-room'
    },
    argv: []
  });
  const server = createAppServer({ config });
  await server.listen(0, '127.0.0.1');

  const address = server.address();
  assert(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const allowedRoom = deriveRoomIdFromSharedKey('only-this-room');

  try {
    assert.equal(
      await connectUnexpected(`${origin.replace('http', 'ws')}/ws`, 'http://evil.example'),
      403
    );
    assert.equal(
      await connectUnexpected(`${origin.replace('http', 'ws')}/ws`, origin, (socket) => {
        sendJoin(socket, 'not-a-room-id');
      }),
      1008
    );
    assert.equal(
      await connectUnexpected(`${origin.replace('http', 'ws')}/ws`, origin, (socket) => {
        sendJoin(socket, deriveRoomIdFromSharedKey('wrong-room'));
      }),
      1008
    );
  } finally {
    const closed = once(server.httpServer, 'close');
    await server.close();
    await closed;
  }
});

test('hard-closes invalid JSON and rate-limit violations while keeping valid traffic working', async () => {
  const config = loadConfig({
    env: {
      RATE_LIMIT_MAX_MESSAGES: '1',
      RATE_LIMIT_WINDOW_MS: '1000'
    },
    argv: []
  });
  const server = createAppServer({ config });
  await server.listen(0, '127.0.0.1');

  const address = server.address();
  assert(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const roomId = deriveRoomIdFromSharedKey('policy-room');
  const wsUrl = `${origin.replace('http', 'ws')}/ws`;

  try {
    const invalidJsonSocket = await openSocket(wsUrl, origin);
    sendJoin(invalidJsonSocket.socket, roomId);
    await invalidJsonSocket.nextMessage();
    invalidJsonSocket.socket.send('{');
    assert.equal(await waitForClose(invalidJsonSocket), 1003);

    const rateLimitedSocket = await openSocket(wsUrl, origin);
    sendJoin(rateLimitedSocket.socket, roomId);
    await rateLimitedSocket.nextMessage();
    rateLimitedSocket.socket.send(JSON.stringify({
      type: 'message',
      iv: 'aGVsbG8=',
      ciphertext: 'd29ybGQ=',
      clientMessageId: 'one'
    }));
    await rateLimitedSocket.nextMessage();
    rateLimitedSocket.socket.send(JSON.stringify({
      type: 'message',
      iv: 'aGVsbG8=',
      ciphertext: 'd29ybGQ=',
      clientMessageId: 'two'
    }));
    assert.equal(await waitForClose(rateLimitedSocket), 1008);
  } finally {
    const closed = once(server.httpServer, 'close');
    await server.close();
    await closed;
  }
});

test('times out idle pre-join sockets and cancels the timeout after a valid join', async () => {
  const config = loadConfig({
    env: {
      JOIN_DEADLINE_MS: '40'
    },
    argv: []
  });
  const server = createAppServer({ config });
  await server.listen(0, '127.0.0.1');

  const address = server.address();
  assert(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const roomId = deriveRoomIdFromSharedKey('join-timeout-room');
  const wsUrl = `${origin.replace('http', 'ws')}/ws`;

  try {
    const idleSocket = await openSocket(wsUrl, origin);
    const idleClose = await waitForCloseDetails(idleSocket);
    assert.equal(idleClose.code, 1008);
    assert.equal(idleClose.reason, 'Join timeout.');

    const joinedSocket = await openSocket(wsUrl, origin);
    sendJoin(joinedSocket.socket, roomId);
    await joinedSocket.nextMessage();
    await joinedSocket.nextMessage();
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(joinedSocket.socket.readyState, WebSocket.OPEN);
    joinedSocket.socket.close();
    await waitForClose(joinedSocket);
  } finally {
    const closed = once(server.httpServer, 'close');
    await server.close();
    await closed;
  }
});

test('rejects pre-upgrade bursts and pre-join capacity exhaustion before the websocket handshake completes', async () => {
  const rateLimitedConfig = loadConfig({
    env: {
      MAX_UPGRADES_PER_IP_PER_WINDOW: '1',
      UPGRADE_RATE_LIMIT_WINDOW_MS: '10000'
    },
    argv: []
  });
  const rateLimitedServer = createAppServer({ config: rateLimitedConfig });
  await rateLimitedServer.listen(0, '127.0.0.1');

  const rateLimitedAddress = rateLimitedServer.address();
  assert(rateLimitedAddress && typeof rateLimitedAddress === 'object');
  const rateLimitedOrigin = `http://127.0.0.1:${rateLimitedAddress.port}`;
  const rateLimitedWsUrl = `${rateLimitedOrigin.replace('http', 'ws')}/ws`;

  try {
    const first = await openSocket(rateLimitedWsUrl, rateLimitedOrigin);
    first.socket.close();
    await waitForClose(first);

    assert.equal(
      await connectUnexpected(rateLimitedWsUrl, rateLimitedOrigin),
      429
    );
  } finally {
    const closed = once(rateLimitedServer.httpServer, 'close');
    await rateLimitedServer.close();
    await closed;
  }

  const capacityConfig = loadConfig({
    env: {
      MAX_OPEN_PREJOIN_SOCKETS: '1',
      JOIN_DEADLINE_MS: '500'
    },
    argv: []
  });
  const capacityServer = createAppServer({ config: capacityConfig });
  await capacityServer.listen(0, '127.0.0.1');

  const capacityAddress = capacityServer.address();
  assert(capacityAddress && typeof capacityAddress === 'object');
  const capacityOrigin = `http://127.0.0.1:${capacityAddress.port}`;
  const capacityWsUrl = `${capacityOrigin.replace('http', 'ws')}/ws`;

  try {
    const first = await openSocket(capacityWsUrl, capacityOrigin);
    assert.equal(
      await connectUnexpected(capacityWsUrl, capacityOrigin),
      503
    );
    first.socket.close();
    await waitForClose(first);
  } finally {
    const closed = once(capacityServer.httpServer, 'close');
    await capacityServer.close();
    await closed;
  }
});
