import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";

import WebSocket from "ws";

import { createAppServer } from "../src/server.js";
import {
  buildRoomWebSocketUrl,
  createFallbackUsername,
  formatRoomExpiryCountdown,
  formatRoomSettingsSummary,
  normalizeUsername,
  parseOptionalMaxPeople,
  parseOptionalDurationMs,
} from "../public/app.js";

type SocketHarness = {
  socket: WebSocket;
  nextMessage: <T>() => Promise<T>;
};

function connectUnexpected(url: string, origin: string, onOpen?: (socket: WebSocket) => void) {
  return new Promise<number>((resolve, reject) => {
    const socket = new WebSocket(url, {
      headers: { Origin: origin },
    });

    socket.once("unexpected-response", (_request, response) => {
      resolve(response.statusCode ?? 0);
    });
    socket.once("open", () => {
      onOpen?.(socket);
    });
    socket.once("close", (code) => {
      resolve(code);
    });
    socket.once("error", reject);
  });
}

function openSocket(url: string, origin: string) {
  return new Promise<SocketHarness>((resolve, reject) => {
    const socket = new WebSocket(url, {
      headers: { Origin: origin },
    });
    const queue: unknown[] = [];
    const waiters: Array<(value: unknown) => void> = [];

    socket.on("message", (data) => {
      const parsed = JSON.parse(String(data));
      const waiter = waiters.shift();
      if (waiter) {
        waiter(parsed);
        return;
      }

      queue.push(parsed);
    });

    socket.once("open", () =>
      resolve({
        socket,
        nextMessage() {
          const next = queue.shift();
          if (next !== undefined) {
            return Promise.resolve(next as T);
          }

          return new Promise((messageResolve) => {
            waiters.push(messageResolve as (value: unknown) => void);
          });
        },
      }),
    );
    socket.once("error", reject);
  });
}

async function waitForType<T extends { type: string }>(harness: SocketHarness, type: T["type"]) {
  while (true) {
    const payload = await harness.nextMessage<T>();
    if (payload.type === type) {
      return payload;
    }
  }
}

function sendJoin(socket: WebSocket, roomId: string, roomSettings?: Record<string, unknown>) {
  socket.send(JSON.stringify({
    type: "join",
    roomId,
    ...(roomSettings ? { roomSettings } : {}),
  }));
}

test("serves expanded room settings UI and parses numeric room policy inputs", async () => {
  const server = createAppServer();
  await server.listen(0, "127.0.0.1");

  try {
    const address = server.address();
    assert(address && typeof address === "object");
    const response = await fetch(`http://127.0.0.1:${address.port}/`);
    const html = await response.text();

    assert.match(html, /Room settings/i);
    assert.match(html, /Applies only if you are the first person to join this room\./i);
    assert.match(html, /name="maxPeople"/i);
    assert.match(html, /maxlength="8"/i);
    assert.match(html, /name="allowBacklog"/i);
    assert.match(html, /name="maxBacklogMessages"/i);
    assert.match(html, /name="lockRoomAfterSecondJoin"/i);
    assert.match(html, /name="messageSelfDestructMs"/i);
    assert.match(html, /name="roomSelfDestructMs"/i);
    assert.match(html, /Once the second person joins, nobody can rejoin this room lifecycle if they disconnect\./i);
    assert.match(html, /type="number"/i);
    assert.match(html, /max="32"/i);

    assert.equal(parseOptionalMaxPeople("", 32), null);
    assert.equal(parseOptionalMaxPeople("2", 32), 2);
    assert.equal(parseOptionalMaxPeople("01", 32), 1);
    assert.throws(() => parseOptionalMaxPeople("0", 32), /between 1 and 32/i);
    assert.throws(() => parseOptionalMaxPeople("2.5", 32), /whole number/i);
    assert.throws(() => parseOptionalMaxPeople("33", 32), /between 1 and 32/i);
    assert.equal(normalizeUsername(""), "");
    assert.equal(normalizeUsername("abcdefgh"), "abcdefgh");
    assert.match(normalizeUsername("abc"), /^abc\d{5}$/);
    assert.equal(normalizeUsername("abcdefghijk"), "abcdefgh");
    assert.match(createFallbackUsername(), /^[A-Za-z0-9]{8}$/);
    assert.equal(parseOptionalDurationMs("", 10_000, "Room self-destruct"), null);
    assert.equal(parseOptionalDurationMs("5000", 10_000, "Room self-destruct"), 5000);
    assert.throws(() => parseOptionalDurationMs("0", 10_000, "Room self-destruct"), /between 1 and 10000/i);
    assert.throws(() => parseOptionalDurationMs("10001", 10_000, "Room self-destruct"), /between 1 and 10000/i);
    assert.equal(
      buildRoomWebSocketUrl(new URL("https://chat.example/app"), "abc123", null),
      "wss://chat.example/ws",
    );
    assert.equal(
      buildRoomWebSocketUrl(new URL("http://chat.example/app"), "abc123", {
        allowBacklog: true,
        lockRoomAfterSecondJoin: true,
        maxBacklogMessages: 5,
        maxPeople: 2,
        messageSelfDestructMs: 1000,
        roomSelfDestructMs: 2000,
      }),
      "ws://chat.example/ws",
    );
    assert.equal(formatRoomSettingsSummary(null), "");
    assert.equal(
      formatRoomSettingsSummary({
        maxPeople: 2,
        allowBacklog: true,
        maxBacklogMessages: 5,
        lockRoomAfterSecondJoin: true,
        messageSelfDestructMs: 1000,
        roomSelfDestructMs: 2000,
      }),
      "Backlog on · 5 messages · 2-person auto-lock · Messages self-destruct · Room self-destruct",
    );
    assert.equal(formatRoomExpiryCountdown(Date.now() + 1_500, Date.now()), "Room expires in 2s");
  } finally {
    const closed = once(server.httpServer, "close");
    await server.close();
    await closed;
  }
});

test("rejects invalid room settings at the boundary and refuses joins to full rooms", async () => {
  const server = createAppServer();
  await server.listen(0, "127.0.0.1");

  try {
    const address = server.address();
    assert(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;
    const baseWsUrl = `${origin.replace("http", "ws")}/ws`;
    const roomId = "b".repeat(64);

    assert.equal(await connectUnexpected(baseWsUrl, origin, (socket) => {
      sendJoin(socket, roomId, { maxPeople: 0 });
    }), 1008);
    assert.equal(await connectUnexpected(baseWsUrl, origin, (socket) => {
      sendJoin(socket, roomId, { maxPeople: 33 });
    }), 1008);
    assert.equal(await connectUnexpected(baseWsUrl, origin, (socket) => {
      sendJoin(socket, roomId, { maxPeople: 2.5 });
    }), 1008);
    assert.equal(await connectUnexpected(baseWsUrl, origin, (socket) => {
      sendJoin(socket, roomId, { allowBacklog: true, maxBacklogMessages: 0 });
    }), 1008);
    assert.equal(await connectUnexpected(baseWsUrl, origin, (socket) => {
      sendJoin(socket, roomId, { messageSelfDestructMs: 86400001 });
    }), 1008);
    assert.equal(await connectUnexpected(baseWsUrl, origin, (socket) => {
      sendJoin(socket, roomId, { roomSelfDestructMs: 604800001 });
    }), 1008);

    const first = await openSocket(baseWsUrl, origin);
    sendJoin(first.socket, roomId, { maxPeople: 2 });
    await first.nextMessage();

    const second = await openSocket(baseWsUrl, origin);
    sendJoin(second.socket, roomId, { maxPeople: 5 });
    await second.nextMessage();

    const third = new WebSocket(baseWsUrl, {
      headers: { Origin: origin },
    });
    third.once("open", () => {
      sendJoin(third, roomId);
    });
    const closeEvent = once(third, "close");
    const [code, reason] = await closeEvent;

    assert.equal(code, 1008);
    assert.equal(String(reason), "Room is full.");

    first.socket.close();
    second.socket.close();
  } finally {
    const closed = once(server.httpServer, "close");
    await server.close();
    await closed;
  }
});

test("returns explicit room settings in backlog bootstrap and keeps first room policy authoritative", async () => {
  const server = createAppServer();
  await server.listen(0, "127.0.0.1");

  try {
    const address = server.address();
    assert(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;
    const baseWsUrl = `${origin.replace("http", "ws")}/ws`;
    const roomId = "a".repeat(64);

    const first = await openSocket(baseWsUrl, origin);
    sendJoin(first.socket, roomId, {
      maxPeople: 5,
      allowBacklog: true,
      maxBacklogMessages: 5,
      lockRoomAfterSecondJoin: true,
      messageSelfDestructMs: 1000,
      roomSelfDestructMs: 2000,
    });
    const firstRoomState = await first.nextMessage<{
      type: string;
      roomInstanceId: string;
      settings: {
        maxPeople: number;
        allowBacklog: boolean;
        maxBacklogMessages: number | null;
        lockRoomAfterSecondJoin: boolean;
        messageSelfDestructMs: number | null;
        roomSelfDestructMs: number | null;
      };
      runtime: { locked: boolean; roomExpiresAt: number };
    }>();
    assert.equal(firstRoomState.type, "room-state");
    assert.equal(typeof firstRoomState.roomInstanceId, "string");
    assert.deepEqual(firstRoomState.settings, {
      maxPeople: 2,
      allowBacklog: true,
      maxBacklogMessages: 5,
      lockRoomAfterSecondJoin: true,
      messageSelfDestructMs: 1000,
      roomSelfDestructMs: 2000,
    });
    assert.equal(firstRoomState.runtime.locked, false);
    assert.equal(typeof firstRoomState.runtime.roomExpiresAt, "number");
    assert.deepEqual(await first.nextMessage(), {
      type: "backlog",
      messages: [],
    });

    const second = await openSocket(baseWsUrl, origin);
    sendJoin(second.socket, roomId, {
      allowBacklog: false,
      maxBacklogMessages: 99,
    });
    const secondRoomState = await second.nextMessage<typeof firstRoomState>();
    assert.equal(secondRoomState.type, "room-state");
    assert.equal(secondRoomState.roomInstanceId, firstRoomState.roomInstanceId);
    assert.deepEqual(secondRoomState.settings, firstRoomState.settings);
    assert.equal(secondRoomState.runtime.locked, true);
    assert.equal(secondRoomState.runtime.roomExpiresAt, firstRoomState.runtime.roomExpiresAt);
    assert.deepEqual(await second.nextMessage(), {
      type: "backlog",
      messages: [],
    });

    first.socket.close();
    second.socket.close();
  } finally {
    const closed = once(server.httpServer, "close");
    await server.close();
    await closed;
  }
});

test("sends room-state before backlog and tags live room events with the current roomInstanceId", async () => {
  const server = createAppServer();
  await server.listen(0, "127.0.0.1");

  try {
    const address = server.address();
    assert(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;
    const wsUrl = `${origin.replace("http", "ws")}/ws`;
    const roomId = "c".repeat(64);

    const first = await openSocket(wsUrl, origin);
    sendJoin(first.socket, roomId);
    const roomState = await first.nextMessage<{
      type: string;
      roomInstanceId: string;
      settings: { maxPeople: number };
      runtime: { locked: boolean; roomExpiresAt: null };
    }>();
    assert.equal(roomState.type, "room-state");
    assert.equal(typeof roomState.roomInstanceId, "string");
    assert.deepEqual(await first.nextMessage(), {
      type: "backlog",
      messages: [],
    });

    const second = await openSocket(wsUrl, origin);
    sendJoin(second.socket, roomId);
    await second.nextMessage();
    await second.nextMessage();

    const livePresence = await waitForType<{
      type: string;
      roomInstanceId: string;
    }>(first, "presence");
    assert.equal(livePresence.roomInstanceId, roomState.roomInstanceId);

    second.socket.send(JSON.stringify({
      type: "message",
      iv: "aGVsbG8=",
      ciphertext: "d29ybGQ=",
      clientMessageId: "message-1",
    }));

    const liveMessage = await waitForType<{
      type: string;
      roomInstanceId: string;
      clientMessageId: string;
    }>(first, "message");
    assert.equal(liveMessage.roomInstanceId, roomState.roomInstanceId);
    assert.equal(liveMessage.clientMessageId, "message-1");

    first.socket.close();
    second.socket.close();
  } finally {
    const closed = once(server.httpServer, "close");
    await server.close();
    await closed;
  }
});

test("broadcasts anonymous join and leave system events only to the other room participants", async () => {
  const server = createAppServer();
  await server.listen(0, "127.0.0.1");

  try {
    const address = server.address();
    assert(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;
    const wsUrl = `${origin.replace("http", "ws")}/ws`;
    const roomId = "d".repeat(64);

    const first = await openSocket(wsUrl, origin);
    sendJoin(first.socket, roomId);
    const firstRoomState = await first.nextMessage<{
      type: string;
      roomInstanceId: string;
    }>();
    assert.equal(firstRoomState.type, "room-state");
    await first.nextMessage();

    const second = await openSocket(wsUrl, origin);
    sendJoin(second.socket, roomId);
    await second.nextMessage();
    await second.nextMessage();

    const joinEvent = await waitForType<{
      type: string;
      roomInstanceId: string;
      text: string;
    }>(first, "system-event");
    assert.equal(joinEvent.roomInstanceId, firstRoomState.roomInstanceId);
    assert.equal(joinEvent.text, "Someone joined");

    second.socket.close();

    const leaveEvent = await waitForType<typeof joinEvent>(first, "system-event");
    assert.equal(leaveEvent.roomInstanceId, firstRoomState.roomInstanceId);
    assert.equal(leaveEvent.text, "Someone left");

    first.socket.close();
  } finally {
    const closed = once(server.httpServer, "close");
    await server.close();
    await closed;
  }
});

test("strict two-person auto-lock broadcasts locked room-state before presence and rejects later joins as locked", async () => {
  const server = createAppServer();
  await server.listen(0, "127.0.0.1");

  try {
    const address = server.address();
    assert(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;
    const baseWsUrl = `${origin.replace("http", "ws")}/ws`;
    const roomId = "e".repeat(64);

    const first = await openSocket(baseWsUrl, origin);
    sendJoin(first.socket, roomId, { lockRoomAfterSecondJoin: true });
    await first.nextMessage();
    await first.nextMessage();

    const second = await openSocket(baseWsUrl, origin);
    sendJoin(second.socket, roomId, { lockRoomAfterSecondJoin: true });
    const secondRoomState = await second.nextMessage<{
      type: string;
      roomInstanceId: string;
      runtime: { locked: boolean; roomExpiresAt: number | null };
      settings: { maxPeople: number; lockRoomAfterSecondJoin: boolean };
    }>();
    assert.equal(secondRoomState.type, "room-state");
    assert.equal(secondRoomState.settings.maxPeople, 2);
    assert.equal(secondRoomState.settings.lockRoomAfterSecondJoin, true);
    assert.equal(secondRoomState.runtime.locked, true);
    await second.nextMessage();

    const firstLockedRoomState = await waitForType<{
      type: string;
      roomInstanceId: string;
      runtime: { locked: boolean; roomExpiresAt: number | null };
    }>(first, "room-state");
    assert.equal(firstLockedRoomState.roomInstanceId, secondRoomState.roomInstanceId);
    assert.equal(firstLockedRoomState.runtime.locked, true);

    const lockedPresence = await waitForType<{
      type: string;
      roomInstanceId: string;
    }>(first, "presence");
    assert.equal(lockedPresence.roomInstanceId, secondRoomState.roomInstanceId);

    const lockedEvent = await waitForType<{
      type: string;
      roomInstanceId: string;
      text: string;
    }>(first, "system-event");
    assert.equal(lockedEvent.roomInstanceId, secondRoomState.roomInstanceId);
    assert.equal(lockedEvent.text, "Room locked");

    const third = new WebSocket(baseWsUrl, {
      headers: { Origin: origin },
    });
    third.once("open", () => {
      sendJoin(third, roomId, { lockRoomAfterSecondJoin: true });
    });
    const [code, reason] = await once(third, "close");
    assert.equal(code, 1008);
    assert.equal(String(reason), "Room is locked and cannot accept any new connections.");

    first.socket.close();
    second.socket.close();
  } finally {
    const closed = once(server.httpServer, "close");
    await server.close();
    await closed;
  }
});

test("room expiry emits system-event then structured error then closes, and later joins get a fresh lifecycle", async () => {
  const server = createAppServer();
  await server.listen(0, "127.0.0.1");

  try {
    const address = server.address();
    assert(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;
    const wsUrl = `${origin.replace("http", "ws")}/ws`;
    const roomId = "f".repeat(64);

    const first = await openSocket(wsUrl, origin);
    sendJoin(first.socket, roomId, { roomSelfDestructMs: 30 });
    const firstRoomState = await first.nextMessage<{
      type: string;
      roomInstanceId: string;
      runtime: { locked: boolean; roomExpiresAt: number | null };
    }>();
    assert.equal(firstRoomState.type, "room-state");
    assert.equal(typeof firstRoomState.runtime.roomExpiresAt, "number");
    await first.nextMessage();

    const expiredEvent = await waitForType<{
      type: string;
      roomInstanceId: string;
      text: string;
    }>(first, "system-event");
    assert.equal(expiredEvent.roomInstanceId, firstRoomState.roomInstanceId);
    assert.equal(expiredEvent.text, "Room expired");

    const errorEvent = await waitForType<{
      type: string;
      roomInstanceId: string;
      reasonCode: string;
      retryability: string;
      message: string;
    }>(first, "error");
    assert.equal(errorEvent.roomInstanceId, firstRoomState.roomInstanceId);
    assert.equal(errorEvent.reasonCode, "room_expired");
    assert.equal(errorEvent.retryability, "final");
    assert.equal(errorEvent.message, "Room expired.");

    const [closeCode, closeReason] = await once(first.socket, "close");
    assert.equal(closeCode, 1008);
    assert.equal(String(closeReason), "Room expired.");

    const second = await openSocket(wsUrl, origin);
    sendJoin(second.socket, roomId, { roomSelfDestructMs: 30 });
    const secondRoomState = await second.nextMessage<typeof firstRoomState>();
    assert.equal(secondRoomState.type, "room-state");
    assert.notEqual(secondRoomState.roomInstanceId, firstRoomState.roomInstanceId);
    await second.nextMessage();
    second.socket.close();
  } finally {
    const closed = once(server.httpServer, "close");
    await server.close();
    await closed;
  }
});
