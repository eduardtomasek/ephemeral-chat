import crypto from "node:crypto";

import { type WebSocket, type WebSocketServer } from "ws";

import type { AppConfig } from "./config.js";
import { createStoredMessage, toClientMessage } from "./room-messages.js";
import { RoomStore } from "./room-store.js";
import {
  parseRoomSettingsFromPayload,
  type RoomSettings,
} from "./room-settings.js";

export type SocketState = {
  id: string;
  isAlive: boolean;
  joinDeadlineTimer?: ReturnType<typeof setTimeout>;
  preJoinTracked: boolean;
  roomId: string;
  joined: boolean;
  rateWindow: number[];
};

export type ClientEnvelope =
  | {
      type: "join";
      roomId: string;
      roomSettings?: RoomSettings | null;
    }
  | {
      type: "message";
      iv: string;
      ciphertext: string;
      clientMessageId: string;
    }
  | {
      type: "set-room-lock";
      locked: boolean;
    }
  | {
      type: "kill-room";
    };

type RuntimeOptions = {
  config: AppConfig;
  releasePreJoinSlot: (state: SocketState) => void;
  websocketServer: WebSocketServer;
  socketState: WeakMap<WebSocket, SocketState>;
  sendJson: (ws: WebSocket, payload: unknown) => void;
  roomStore?: RoomStore;
};

export class RoomRuntime {
  private readonly roomStore: RoomStore;

  constructor(private readonly options: RuntimeOptions) {
    this.roomStore = options.roomStore ?? new RoomStore({
      ...options.config,
      onRoomExpired: (room) => {
        this.broadcastSystemEvent(room.roomId, "Room expired");
        this.broadcastError(room.roomId, room.roomInstanceId, {
          reasonCode: "room_expired",
          retryability: "final",
          message: "Room expired.",
        });
        this.closeRoomConnections(room.roomId, 1008, "Room expired.");
      },
      onMessageExpired: (message) => {
        this.broadcastMessageRemoved(
          message.roomId,
          message.roomInstanceId,
          message.messageId,
        );
      },
    });
  }

  createSocketState(): SocketState {
    return {
      id: crypto.randomUUID(),
      isAlive: true,
      preJoinTracked: false,
      roomId: "",
      joined: false,
      rateWindow: [],
    };
  }

  enforceRateLimit(state: SocketState) {
    const now = Date.now();
    const windowStart = now - this.options.config.rateLimitWindowMs;
    state.rateWindow = state.rateWindow.filter(
      (timestamp) => timestamp > windowStart,
    );
    state.rateWindow.push(now);
    return state.rateWindow.length <= this.options.config.rateLimitMaxMessages;
  }

  handleEnvelope(
    ws: WebSocket,
    state: SocketState,
    payload: ClientEnvelope,
  ) {
    if (payload.type === "join") {
      if (state.joined) {
        ws.close(1008, "Already joined.");
        return "invalid_room";
      }

      if (!this.options.config.singleRoomMode && !isValidJoinRoomId(payload.roomId)) {
        ws.close(1008, "Invalid room.");
        return "invalid_room";
      }

      if (
        this.options.config.singleRoomMode &&
        payload.roomId !== this.options.config.allowedRoomId
      ) {
        ws.close(1008, "Invalid room.");
        return "invalid_room";
      }

      const roomSettingsResult = parseRoomSettingsFromPayload(
        payload.roomSettings,
        this.options.config,
      );
      if (roomSettingsResult.invalid) {
        ws.close(1008, "Invalid room settings.");
        return "invalid_room";
      }

      try {
        this.handleJoin(
          ws,
          state,
          payload.roomId,
          roomSettingsResult.settings ?? undefined,
        );
        return null;
      } catch (error) {
        ws.close(
          1008,
          error instanceof Error ? error.message : "Room join rejected.",
        );
        return "room_full";
      }
    }

    if (!state.joined) {
      ws.close(1008, "Join required.");
      return;
    }

    const room = this.roomStore.getRoom(state.roomId);
    if (!room) {
      ws.close(1011, "Room unavailable.");
      return null;
    }

    if (payload.type === "message") {
      const existingMessage = this.roomStore.findMessageByClientMessageId(
        state.roomId,
        payload.clientMessageId,
      );
      if (existingMessage) {
        this.options.sendJson(ws, toClientMessage(existingMessage, state.id));
        return;
      }

      const message = createStoredMessage(room, payload, Date.now());
      this.roomStore.appendMessage(state.roomId, message);
      this.broadcastMessage(state.roomId, message);
      return;
    }

    if (payload.type === "set-room-lock") {
      if (room.settings?.lockRoomAfterSecondJoin) {
        return;
      }

      if (room.runtime.locked === payload.locked) {
        return;
      }

      this.roomStore.setRoomLocked(state.roomId, payload.locked);
      this.broadcastRoomState(state.roomId);
      this.broadcastSystemEvent(
        state.roomId,
        payload.locked ? "Room locked" : "Room unlocked",
      );
      return;
    }

    this.broadcastError(state.roomId, room.roomInstanceId, {
      reasonCode: "room_destroyed",
      retryability: "final",
      message: "Room was destroyed.",
    });
    this.closeRoomConnections(state.roomId, 1008, "Room was destroyed.");
    this.roomStore.destroyRoom(state.roomId);
    return null;
  }

  handleDisconnect(state: SocketState) {
    this.roomStore.leaveRoom(state.roomId, { id: state.id });
    this.broadcastSystemEvent(state.roomId, "Someone left", state.id);
    this.broadcastPresence(state.roomId);
  }

  private handleJoin(
    ws: WebSocket,
    state: SocketState,
    roomId: string,
    roomSettings?: RoomSettings,
  ) {
    const existingRoom = this.roomStore.getRoom(roomId);
    const wasLocked = existingRoom?.runtime.locked ?? false;
    const room = this.roomStore.joinRoom(roomId, { id: state.id }, roomSettings);
    state.roomId = roomId;
    state.joined = true;
    this.options.releasePreJoinSlot(state);

    this.options.sendJson(ws, {
      type: "room-state",
      roomInstanceId: room.roomInstanceId,
      settings: room.settings,
      runtime: room.runtime,
    });
    this.options.sendJson(ws, {
      type: "backlog",
      messages: room.backlog.map((message) => toClientMessage(message, state.id)),
    });

    if (!wasLocked && room.runtime.locked) {
      this.broadcastRoomState(roomId, state.id);
      this.broadcastPresence(roomId);
      this.broadcastSystemEvent(roomId, "Room locked");
      this.broadcastSystemEvent(roomId, "Someone joined", state.id);
      return;
    }

    this.broadcastSystemEvent(roomId, "Someone joined", state.id);
    this.broadcastPresence(roomId);
  }

  private broadcastMessage(
    roomId: string,
    message: Parameters<typeof toClientMessage>[0],
  ) {
    const room = this.roomStore.getRoom(roomId);
    if (!room) {
      return;
    }

    this.forEachRoomClient(roomId, (client, state) => {
      this.options.sendJson(client, toClientMessage(message, state.id));
    });
  }

  private broadcastPresence(roomId: string) {
    const room = this.roomStore.getRoom(roomId);
    if (!room) {
      return;
    }

    this.forEachRoomClient(roomId, (client) => {
      this.options.sendJson(client, {
        type: "presence",
        roomInstanceId: room.roomInstanceId,
      });
    });
  }

  private broadcastRoomState(roomId: string, excludedSocketId = "") {
    const room = this.roomStore.getRoom(roomId);
    if (!room) {
      return;
    }

    this.forEachRoomClient(roomId, (client) => {
      this.options.sendJson(client, {
        type: "room-state",
        roomInstanceId: room.roomInstanceId,
        settings: room.settings,
        runtime: room.runtime,
      });
    }, excludedSocketId);
  }

  private broadcastSystemEvent(
    roomId: string,
    text: string,
    excludedSocketId = "",
  ) {
    const room = this.roomStore.getRoom(roomId);
    if (!room) {
      return;
    }

    const sentAt = Date.now();
    this.forEachRoomClient(roomId, (client) => {
      this.options.sendJson(client, {
        type: "system-event",
        roomInstanceId: room.roomInstanceId,
        text,
        sentAt,
      });
    }, excludedSocketId);
  }

  private broadcastError(
    roomId: string,
    roomInstanceId: string,
    error: {
      reasonCode: string;
      retryability: "final" | "retryable";
      message: string;
    },
  ) {
    this.forEachRoomClient(roomId, (client) => {
      this.options.sendJson(client, {
        type: "error",
        roomInstanceId,
        ...error,
      });
    });
  }

  private broadcastMessageRemoved(
    roomId: string,
    roomInstanceId: string,
    messageId: string,
  ) {
    this.forEachRoomClient(roomId, (client) => {
      this.options.sendJson(client, {
        type: "message-removed",
        roomInstanceId,
        messageId,
        reason: "self_destruct",
      });
    });
  }

  private closeRoomConnections(roomId: string, code: number, reason: string) {
    this.forEachRoomClient(roomId, (client) => {
      client.close(code, reason);
    });
  }

  private forEachRoomClient(
    roomId: string,
    visit: (client: WebSocket, state: SocketState) => void,
    excludedSocketId = "",
  ) {
    for (const client of this.options.websocketServer.clients) {
      const state = this.options.socketState.get(client);
      if (
        !state ||
        state.id === excludedSocketId ||
        state.roomId !== roomId ||
        client.readyState !== client.OPEN
      ) {
        continue;
      }

      visit(client, state);
    }
  }
}

export function createRoomRuntime(options: RuntimeOptions) {
  return new RoomRuntime(options);
}

export function isValidClientEnvelope(value: unknown): value is ClientEnvelope {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  if (
    candidate.type === "join" &&
    isNonEmptyString(candidate.roomId) &&
    isJoinRoomSettings(candidate.roomSettings)
  ) {
    return true;
  }

  if (
    candidate.type === "message" &&
    isNonEmptyString(candidate.iv) &&
    isNonEmptyString(candidate.ciphertext) &&
    isNonEmptyString(candidate.clientMessageId)
  ) {
    return true;
  }

  if (
    candidate.type === "set-room-lock" &&
    typeof candidate.locked === "boolean"
  ) {
    return true;
  }

  return candidate.type === "kill-room";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isJoinRoomSettings(value: unknown) {
  return value == null || (typeof value === "object" && !Array.isArray(value));
}

function isValidJoinRoomId(roomId: string) {
  return /^[a-f0-9]{64}$/.test(roomId);
}
