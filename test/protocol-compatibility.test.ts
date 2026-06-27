import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';

import WebSocket from 'ws';

import { loadConfig } from '../src/config.js';
import { createAppServer } from '../src/server.js';
import {
  decryptChatMessage,
  deriveEncryptionKey,
  deriveRoomId,
  encryptChatMessage
} from '../public/app.js';

type SocketHarness = {
  clearQueue: () => void;
  hasQueuedMessages: () => boolean;
  socket: WebSocket;
  nextMessage: <T>() => Promise<T>;
};

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
      clearQueue() {
        queue.length = 0;
      },
      hasQueuedMessages() {
        return queue.length > 0;
      },
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

async function waitForType<T extends { type: string }>(harness: SocketHarness, type: T['type']) {
  while (true) {
    const payload = await harness.nextMessage<T>();
    if (payload.type === type) {
      return payload;
    }
  }
}

async function expectNoMessage(harness: SocketHarness, timeoutMs = 50) {
  if (harness.hasQueuedMessages()) {
    throw new Error('Unexpected queued message.');
  }

  await new Promise<void>((resolve, reject) => {
    const onMessage = (data: WebSocket.RawData) => {
      cleanup();
      reject(new Error(`Unexpected message: ${String(data)}`));
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      harness.socket.off('message', onMessage);
    };

    harness.socket.on('message', onMessage);
  });
}

function sendJoin(socket: WebSocket, roomId: string, roomSettings?: Record<string, unknown>) {
  socket.send(JSON.stringify({
    type: 'join',
    roomId,
    ...(roomSettings ? { roomSettings } : {})
  }));
}

async function closeSocket(socket: WebSocket) {
  if (
    socket.readyState === WebSocket.CLOSING ||
    socket.readyState === WebSocket.CLOSED
  ) {
    return;
  }

  const closed = once(socket, 'close');
  socket.close();
  await closed;
}

test('accepts browser-style encrypted messages and replays them to room participants', async () => {
  const config = loadConfig({
    env: {
      ROOM_IDLE_GRACE_MS: '50'
    },
    argv: []
  });
  const server = createAppServer({ config });
  await server.listen(0, '127.0.0.1');

  const address = server.address();
  assert(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;

  try {
    const roomId = await deriveRoomId('correct horse battery staple');
    const key = await deriveEncryptionKey('correct horse battery staple');
    const wsUrl = `${origin.replace('http', 'ws')}/ws`;

    const alice = await openSocket(wsUrl, origin);
    sendJoin(alice.socket, roomId);
    const aliceRoomState = await waitForType<{
      type: string;
      roomInstanceId: string;
      settings: { maxPeople: number };
      runtime: { locked: boolean; roomExpiresAt: null };
    }>(alice, 'room-state');
    assert.equal(typeof aliceRoomState.roomInstanceId, 'string');
    assert.deepEqual(await waitForType(alice, 'backlog'), { type: 'backlog', messages: [] });

    const bob = await openSocket(wsUrl, origin);
    sendJoin(bob.socket, roomId);
    const bobRoomState = await waitForType<typeof aliceRoomState>(bob, 'room-state');
    assert.equal(bobRoomState.roomInstanceId, aliceRoomState.roomInstanceId);
    assert.deepEqual(await waitForType(bob, 'backlog'), { type: 'backlog', messages: [] });

    const encrypted = await encryptChatMessage(key, {
      username: 'Alice',
      msg: 'Hello from the browser crypto contract'
    });

    alice.socket.send(JSON.stringify({
      type: 'message',
      clientMessageId: 'client-1',
      ...encrypted
    }));

    const aliceEcho = await waitForType<{
      type: string;
      id: string;
      seq: number;
      sentAt: number;
      iv: string;
      ciphertext: string;
      roomInstanceId: string;
    }>(alice, 'message');
    const bobEcho = await waitForType<typeof aliceEcho>(bob, 'message');

    assert.equal(aliceEcho.type, 'message');
    assert.equal(aliceEcho.seq, 1);
    assert.equal(aliceEcho.roomInstanceId, aliceRoomState.roomInstanceId);
    assert.equal(bobEcho.id, aliceEcho.id);

    const decrypted = await decryptChatMessage(key, bobEcho);
    assert.deepEqual(decrypted, {
      username: 'Alice',
      msg: 'Hello from the browser crypto contract'
    });

    await closeSocket(alice.socket);
    await closeSocket(bob.socket);
  } finally {
    const closed = once(server.httpServer, 'close');
    await server.close();
    await closed;
  }
});

test('deduplicates resend attempts by clientMessageId within one room lifecycle', async () => {
  const server = createAppServer();
  await server.listen(0, '127.0.0.1');

  const address = server.address();
  assert(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;

  try {
    const roomId = await deriveRoomId('idempotent-room');
    const key = await deriveEncryptionKey('idempotent-room');
    const wsUrl = `${origin.replace('http', 'ws')}/ws`;

    const alice = await openSocket(wsUrl, origin);
    sendJoin(alice.socket, roomId);
    await waitForType(alice, 'room-state');
    await waitForType(alice, 'backlog');

    const bob = await openSocket(wsUrl, origin);
    sendJoin(bob.socket, roomId);
    await waitForType(bob, 'room-state');
    await waitForType(bob, 'backlog');

    const encrypted = await encryptChatMessage(key, {
      username: 'Alice',
      msg: 'Send only once'
    });

    const outgoing = JSON.stringify({
      type: 'message',
      clientMessageId: 'client-1',
      ...encrypted
    });

    alice.socket.send(outgoing);

    const firstAliceEcho = await waitForType<{
      type: string;
      id: string;
      seq: number;
      clientMessageId: string;
    }>(alice, 'message');
    const firstBobEcho = await waitForType<typeof firstAliceEcho>(bob, 'message');

    alice.socket.send(outgoing);

    const secondAliceEcho = await waitForType<typeof firstAliceEcho>(alice, 'message');
    assert.equal(secondAliceEcho.id, firstAliceEcho.id);
    assert.equal(secondAliceEcho.seq, firstAliceEcho.seq);
    assert.equal(firstBobEcho.id, firstAliceEcho.id);
    await expectNoMessage(bob);

    await closeSocket(alice.socket);
    await closeSocket(bob.socket);
  } finally {
    const closed = once(server.httpServer, 'close');
    await server.close();
    await closed;
  }
});

test('self-destructed messages emit removal events and disappear from later backlog replay', async () => {
  const server = createAppServer();
  await server.listen(0, '127.0.0.1');

  const address = server.address();
  assert(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;

  try {
    const roomId = await deriveRoomId('self-destruct-room');
    const key = await deriveEncryptionKey('self-destruct-room');
    const wsUrl = `${origin.replace('http', 'ws')}/ws`;

    const alice = await openSocket(wsUrl, origin);
    sendJoin(alice.socket, roomId, { allowBacklog: true, messageSelfDestructMs: 30 });
    await waitForType(alice, 'room-state');
    await waitForType(alice, 'backlog');

    const encrypted = await encryptChatMessage(key, {
      username: 'Alice',
      msg: 'Vanishing message'
    });

    alice.socket.send(JSON.stringify({
      type: 'message',
      clientMessageId: 'self-destruct-1',
      ...encrypted
    }));

    const message = await waitForType<{
      type: string;
      id: string;
      expiresAt: number | null;
    }>(alice, 'message');
    assert.equal(typeof message.expiresAt, 'number');

    const removed = await waitForType<{
      type: string;
      roomInstanceId: string;
      messageId: string;
      reason: string;
    }>(alice, 'message-removed');
    assert.equal(removed.messageId, message.id);
    assert.equal(removed.reason, 'self_destruct');

    const bob = await openSocket(wsUrl, origin);
    sendJoin(bob.socket, roomId, { allowBacklog: true, messageSelfDestructMs: 30 });
    await waitForType(bob, 'room-state');
    const backlog = await waitForType<{ type: string; messages: unknown[] }>(bob, 'backlog');
    assert.deepEqual(backlog.messages, []);

    await closeSocket(alice.socket);
    await closeSocket(bob.socket);
  } finally {
    const closed = once(server.httpServer, 'close');
    await server.close();
    await closed;
  }
});

test('kill-room destroys the active room, closes participants, and allows a fresh lifecycle on rejoin', async () => {
  const server = createAppServer();
  await server.listen(0, '127.0.0.1');

  const address = server.address();
  assert(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;

  try {
    const roomId = await deriveRoomId('kill-room');
    const wsUrl = `${origin.replace('http', 'ws')}/ws`;

    const alice = await openSocket(wsUrl, origin);
    sendJoin(alice.socket, roomId, { allowBacklog: true });
    const aliceRoomState = await waitForType<{
      type: string;
      roomInstanceId: string;
    }>(alice, 'room-state');
    await waitForType(alice, 'backlog');

    const bob = await openSocket(wsUrl, origin);
    sendJoin(bob.socket, roomId, { allowBacklog: true });
    await waitForType(bob, 'room-state');
    await waitForType(bob, 'backlog');

    const aliceClosed = once(alice.socket, 'close');
    const bobClosed = once(bob.socket, 'close');

    alice.socket.send(JSON.stringify({
      type: 'kill-room'
    }));

    const aliceError = await waitForType<{
      type: string;
      reasonCode: string;
      retryability: string;
      message: string;
    }>(alice, 'error');
    const bobError = await waitForType<typeof aliceError>(bob, 'error');
    assert.equal(aliceError.reasonCode, 'room_destroyed');
    assert.equal(aliceError.retryability, 'final');
    assert.equal(aliceError.message, 'Room was destroyed.');
    assert.deepEqual(bobError, aliceError);

    const [aliceCode, aliceReason] = await aliceClosed;
    const [bobCode, bobReason] = await bobClosed;
    assert.equal(aliceCode, 1008);
    assert.equal(String(aliceReason), 'Room was destroyed.');
    assert.equal(bobCode, 1008);
    assert.equal(String(bobReason), 'Room was destroyed.');

    const charlie = await openSocket(wsUrl, origin);
    sendJoin(charlie.socket, roomId, { allowBacklog: true });
    const charlieRoomState = await waitForType<typeof aliceRoomState>(charlie, 'room-state');
    assert.notEqual(charlieRoomState.roomInstanceId, aliceRoomState.roomInstanceId);
    assert.deepEqual(await waitForType(charlie, 'backlog'), { type: 'backlog', messages: [] });

    await closeSocket(charlie.socket);
  } finally {
    const closed = once(server.httpServer, 'close');
    await server.close();
    await closed;
  }
});

test('manual room lock toggles room-state, rejects new joins while locked, and allows them again after unlock', async () => {
  const server = createAppServer();
  await server.listen(0, '127.0.0.1');

  const address = server.address();
  assert(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;

  try {
    const roomId = await deriveRoomId('toggle-lock-room');
    const wsUrl = `${origin.replace('http', 'ws')}/ws`;

    const alice = await openSocket(wsUrl, origin);
    sendJoin(alice.socket, roomId, { maxPeople: 3 });
    await waitForType(alice, 'room-state');
    await waitForType(alice, 'backlog');

    const bob = await openSocket(wsUrl, origin);
    sendJoin(bob.socket, roomId, { maxPeople: 3 });
    await waitForType(bob, 'room-state');
    await waitForType(bob, 'backlog');

    alice.socket.send(JSON.stringify({
      type: 'set-room-lock',
      locked: true
    }));

    const aliceLockedState = await waitForType<{
      type: string;
      roomInstanceId: string;
      runtime: { locked: boolean; roomExpiresAt: number | null };
    }>(alice, 'room-state');
    const bobLockedState = await waitForType<typeof aliceLockedState>(bob, 'room-state');
    assert.equal(aliceLockedState.runtime.locked, true);
    assert.equal(bobLockedState.runtime.locked, true);

    const lockEvent = await waitForType<{
      type: string;
      roomInstanceId: string;
      text: string;
    }>(bob, 'system-event');
    assert.equal(lockEvent.text, 'Room locked');

    const blocked = new WebSocket(wsUrl, {
      headers: { Origin: origin }
    });
    blocked.once('open', () => {
      sendJoin(blocked, roomId, { maxPeople: 3 });
    });
    const [blockedCode, blockedReason] = await once(blocked, 'close');
    assert.equal(blockedCode, 1008);
    assert.equal(String(blockedReason), 'Room is locked and cannot accept any new connections.');

    alice.socket.send(JSON.stringify({
      type: 'set-room-lock',
      locked: false
    }));

    const aliceUnlockedState = await waitForType<typeof aliceLockedState>(alice, 'room-state');
    const bobUnlockedState = await waitForType<typeof aliceLockedState>(bob, 'room-state');
    assert.equal(aliceUnlockedState.runtime.locked, false);
    assert.equal(bobUnlockedState.runtime.locked, false);

    const unlockEvent = await waitForType<{
      type: string;
      roomInstanceId: string;
      text: string;
    }>(bob, 'system-event');
    assert.equal(unlockEvent.text, 'Room unlocked');

    const charlie = await openSocket(wsUrl, origin);
    sendJoin(charlie.socket, roomId, { maxPeople: 3 });
    const charlieRoomState = await waitForType<typeof aliceLockedState>(charlie, 'room-state');
    assert.equal(charlieRoomState.runtime.locked, false);
    await waitForType(charlie, 'backlog');

    await closeSocket(alice.socket);
    await closeSocket(bob.socket);
    await closeSocket(charlie.socket);
  } finally {
    const closed = once(server.httpServer, 'close');
    await server.close();
    await closed;
  }
});

test('2-person auto-lock ignores manual room lock toggles from the client', async () => {
  const server = createAppServer();
  await server.listen(0, '127.0.0.1');

  const address = server.address();
  assert(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;

  try {
    const roomId = await deriveRoomId('ignored-auto-lock-toggle');
    const wsUrl = `${origin.replace('http', 'ws')}/ws`;

    const alice = await openSocket(wsUrl, origin);
    sendJoin(alice.socket, roomId, { lockRoomAfterSecondJoin: true });
    const aliceInitialState = await waitForType<{
      type: string;
      runtime: { locked: boolean };
    }>(alice, 'room-state');
    assert.equal(aliceInitialState.runtime.locked, false);
    await waitForType(alice, 'backlog');
    const aliceInitialPresence = await waitForType<{
      type: string;
      roomInstanceId: string;
    }>(alice, 'presence');
    assert.equal(aliceInitialPresence.roomInstanceId, aliceInitialState.roomInstanceId);
    alice.clearQueue();

    alice.socket.send(JSON.stringify({
      type: 'set-room-lock',
      locked: true
    }));
    await expectNoMessage(alice);

    const bob = await openSocket(wsUrl, origin);
    sendJoin(bob.socket, roomId, { lockRoomAfterSecondJoin: true });
    const bobRoomState = await waitForType<{
      type: string;
      roomInstanceId: string;
      runtime: { locked: boolean };
    }>(bob, 'room-state');
    assert.equal(bobRoomState.runtime.locked, true);
    await waitForType(bob, 'backlog');

    const aliceLockedState = await waitForType<typeof bobRoomState>(alice, 'room-state');
    assert.equal(aliceLockedState.runtime.locked, true);
    const aliceLockedPresence = await waitForType<{
      type: string;
      roomInstanceId: string;
    }>(alice, 'presence');
    assert.equal(aliceLockedPresence.roomInstanceId, bobRoomState.roomInstanceId);
    alice.clearQueue();
    bob.clearQueue();

    alice.socket.send(JSON.stringify({
      type: 'set-room-lock',
      locked: false
    }));
    await expectNoMessage(alice);

    const blocked = new WebSocket(wsUrl, {
      headers: { Origin: origin }
    });
    blocked.once('open', () => {
      sendJoin(blocked, roomId, { lockRoomAfterSecondJoin: true });
    });
    const [blockedCode, blockedReason] = await once(blocked, 'close');
    assert.equal(blockedCode, 1008);
    assert.equal(String(blockedReason), 'Room is locked and cannot accept any new connections.');

    await closeSocket(alice.socket);
    await closeSocket(bob.socket);
  } finally {
    const closed = once(server.httpServer, 'close');
    await server.close();
    await closed;
  }
});
