import test from "node:test";
import assert from "node:assert/strict";

import { runHeartbeat } from "../src/server.js";

test("heartbeat pings live sockets and terminates stale ones", () => {
  const socketState = new WeakMap<object, { isAlive: boolean }>();
  const liveSocket = {
    OPEN: 1,
    pingCalls: 0,
    readyState: 1,
    terminateCalls: 0,
    ping() {
      this.pingCalls += 1;
    },
    terminate() {
      this.terminateCalls += 1;
    },
  };

  socketState.set(liveSocket, { isAlive: true });

  runHeartbeat([liveSocket] as never, socketState as never);

  assert.equal(liveSocket.pingCalls, 1);
  assert.equal(liveSocket.terminateCalls, 0);
  assert.equal(socketState.get(liveSocket)?.isAlive, false);

  runHeartbeat([liveSocket] as never, socketState as never);

  assert.equal(liveSocket.terminateCalls, 1);
});

test("heartbeat keeps socket alive after pong marks it healthy again", () => {
  const socketState = new WeakMap<object, { isAlive: boolean }>();
  const liveSocket = {
    OPEN: 1,
    pingCalls: 0,
    readyState: 1,
    terminateCalls: 0,
    ping() {
      this.pingCalls += 1;
    },
    terminate() {
      this.terminateCalls += 1;
    },
  };

  socketState.set(liveSocket, { isAlive: true });

  runHeartbeat([liveSocket] as never, socketState as never);
  const state = socketState.get(liveSocket);
  assert(state);
  state.isAlive = true;

  runHeartbeat([liveSocket] as never, socketState as never);

  assert.equal(liveSocket.pingCalls, 2);
  assert.equal(liveSocket.terminateCalls, 0);
});
