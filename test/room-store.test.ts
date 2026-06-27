import test from 'node:test';
import assert from 'node:assert/strict';

import { createRoomStore } from '../src/room-store.js';

function createFakeTimers() {
  let nextId = 1;
  const timers = new Map<number, () => void>();

  return {
    setTimeout(callback: () => void) {
      const id = nextId++;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id: number) {
      timers.delete(id);
    },
    fireAll() {
      for (const [id, callback] of [...timers.entries()]) {
        timers.delete(id);
        callback();
      }
    }
  };
}

test('keeps fifo backlog and deletes idle rooms after grace period unless resumed', () => {
  const fakeTimers = createFakeTimers();
  const store = createRoomStore({
    maxBacklogMessages: 2,
    maxClientsPerRoom: 2,
    maxRooms: 2,
    roomIdleGraceMs: 10,
    now: (() => {
      let tick = 100;
      return () => tick++;
    })(),
    setTimeoutFn: fakeTimers.setTimeout,
    clearTimeoutFn: (timer) => fakeTimers.clearTimeout(timer as number)
  });

  const roomA = store.joinRoom('room-a', { id: 'socket-a' }, {
    maxPeople: 2,
    allowBacklog: true,
    maxBacklogMessages: 2,
    lockRoomAfterSecondJoin: false,
    messageSelfDestructMs: null,
    roomSelfDestructMs: null
  });
  assert.equal(roomA.backlog.length, 0);

  store.appendMessage('room-a', {
    type: 'message',
    id: '1',
    seq: 1,
    iv: 'a',
    ciphertext: 'a',
    clientMessageId: 'a',
    sentAt: 101
  });
  store.appendMessage('room-a', {
    type: 'message',
    id: '2',
    seq: 2,
    iv: 'b',
    ciphertext: 'b',
    clientMessageId: 'b',
    sentAt: 102
  });
  store.appendMessage('room-a', {
    type: 'message',
    id: '3',
    seq: 3,
    iv: 'c',
    ciphertext: 'c',
    clientMessageId: 'c',
    sentAt: 103
  });

  assert.deepEqual(roomA.backlog.map((message) => message.id), ['2', '3']);

  store.leaveRoom('room-a', { id: 'socket-a' });
  assert.equal(store.getRoomCount(), 1);

  store.joinRoom('room-a', { id: 'socket-b' });
  fakeTimers.fireAll();
  assert.equal(store.getRoomCount(), 1);

  store.leaveRoom('room-a', { id: 'socket-b' });
  fakeTimers.fireAll();
  assert.equal(store.getRoomCount(), 0);
});

test('stores room-scoped capacity only for the current room lifecycle', () => {
  const fakeTimers = createFakeTimers();
  const store = createRoomStore({
    maxBacklogMessages: 2,
    maxClientsPerRoom: 5,
    maxRooms: 2,
    roomIdleGraceMs: 10,
    setTimeoutFn: fakeTimers.setTimeout,
    clearTimeoutFn: (timer) => fakeTimers.clearTimeout(timer as number)
  });

  const firstRoom = store.joinRoom('room-a', { id: 'socket-a' }, {
    maxPeople: 2,
    allowBacklog: false,
    maxBacklogMessages: null,
    lockRoomAfterSecondJoin: false,
    messageSelfDestructMs: null,
    roomSelfDestructMs: null
  });
  assert.deepEqual(firstRoom.settings, {
    maxPeople: 2,
    allowBacklog: false,
    maxBacklogMessages: null,
    lockRoomAfterSecondJoin: false,
    messageSelfDestructMs: null,
    roomSelfDestructMs: null
  });
  const firstRoomInstanceId = firstRoom.roomInstanceId;

  store.leaveRoom('room-a', { id: 'socket-a' });
  const resumedRoom = store.joinRoom('room-a', { id: 'socket-b' });
  assert.equal(resumedRoom, firstRoom);
  assert.deepEqual(resumedRoom.settings, {
    maxPeople: 2,
    allowBacklog: false,
    maxBacklogMessages: null,
    lockRoomAfterSecondJoin: false,
    messageSelfDestructMs: null,
    roomSelfDestructMs: null
  });
  assert.equal(resumedRoom.roomInstanceId, firstRoomInstanceId);

  store.leaveRoom('room-a', { id: 'socket-b' });
  fakeTimers.fireAll();

  const recreatedRoom = store.joinRoom('room-a', { id: 'socket-c' });
  assert.notEqual(recreatedRoom, firstRoom);
  assert.deepEqual(recreatedRoom.settings, {
    maxPeople: 5,
    allowBacklog: false,
    maxBacklogMessages: null,
    lockRoomAfterSecondJoin: false,
    messageSelfDestructMs: null,
    roomSelfDestructMs: null
  });
  assert.notEqual(recreatedRoom.roomInstanceId, firstRoomInstanceId);
});
