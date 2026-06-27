import { createDefaultRoomSettings, type RoomSettings } from "./room-settings.js";

export type StoredMessage = {
  type: "message";
  id: string;
  roomInstanceId: string;
  seq: number;
  iv: string;
  ciphertext: string;
  clientMessageId: string;
  expiresAt: number | null;
  sentAt: number;
  expiryTimer?: DeleteTimer;
};

export type RoomSocketRef = {
  id: string;
};

export type RoomRuntime = {
  locked: boolean;
  roomExpiresAt: number | null;
};

type DeleteTimer = ReturnType<typeof setTimeout> | number;

type RoomExpiredCallback = (room: {
  roomId: string;
  roomInstanceId: string;
}) => void;

type MessageExpiredCallback = (message: {
  roomId: string;
  roomInstanceId: string;
  messageId: string;
}) => void;

type RoomRecord = {
  roomId: string;
  roomInstanceId: string;
  sockets: Map<string, RoomSocketRef>;
  settings: RoomSettings | null;
  runtime: RoomRuntime;
  backlog: StoredMessage[];
  messagesById: Map<string, StoredMessage>;
  messagesByClientMessageId: Map<string, StoredMessage>;
  createdAt: number;
  lastActivityAt: number;
  nextSeq: number;
  deleteTimer?: DeleteTimer;
  roomExpiryTimer?: DeleteTimer;
};

export type RoomStoreOptions = {
  maxBacklogMessages: number;
  maxClientsPerRoom: number;
  maxRooms: number;
  roomIdleGraceMs: number;
  now?: () => number;
  setTimeoutFn?: (callback: () => void, delay: number) => DeleteTimer;
  clearTimeoutFn?: (timer: DeleteTimer) => void;
  onRoomExpired?: RoomExpiredCallback;
  onMessageExpired?: MessageExpiredCallback;
};

export class RoomStore {
  private readonly rooms = new Map<string, RoomRecord>();
  private readonly now: () => number;
  private readonly setTimeoutFn: (callback: () => void, delay: number) => DeleteTimer;
  private readonly clearTimeoutFn: (timer: DeleteTimer) => void;

  constructor(
    private readonly options: RoomStoreOptions,
  ) {
    this.now = options.now ?? (() => Date.now());
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
  }

  getRoom(roomId: string) {
    return this.rooms.get(roomId);
  }

  getRoomCount() {
    return this.rooms.size;
  }

  joinRoom(roomId: string, socket: RoomSocketRef, settings?: RoomSettings) {
    let room = this.rooms.get(roomId);
    if (!room) {
      if (this.rooms.size >= this.options.maxRooms) {
        throw new Error("Room capacity reached.");
      }

      const effectiveSettings = settings ?? createDefaultRoomSettings({
        defaultAllowBacklog: false,
        maxBacklogMessages: this.options.maxBacklogMessages,
        maxClientsPerRoom: this.options.maxClientsPerRoom,
        maxMessageSelfDestructMs: Number.MAX_SAFE_INTEGER,
        maxRoomSelfDestructMs: Number.MAX_SAFE_INTEGER,
      });

      const createdAt = this.now();
      room = {
        roomId,
        roomInstanceId: globalThis.crypto.randomUUID(),
        sockets: new Map(),
        settings: effectiveSettings,
        runtime: {
          locked: false,
          roomExpiresAt: effectiveSettings.roomSelfDestructMs === null
            ? null
            : createdAt + effectiveSettings.roomSelfDestructMs,
        },
        backlog: [],
        messagesById: new Map(),
        messagesByClientMessageId: new Map(),
        createdAt,
        lastActivityAt: createdAt,
        nextSeq: 1,
      };

      if (effectiveSettings.roomSelfDestructMs !== null) {
        room.roomExpiryTimer = this.setTimeoutFn(() => {
          const current = this.rooms.get(roomId);
          if (!current) {
            return;
          }

          this.options.onRoomExpired?.({
            roomId: current.roomId,
            roomInstanceId: current.roomInstanceId,
          });
          this.rooms.delete(roomId);
        }, effectiveSettings.roomSelfDestructMs);
        this.maybeUnref(room.roomExpiryTimer);
      }

      this.rooms.set(roomId, room);
    }

    if (room.deleteTimer !== undefined) {
      this.clearTimeoutFn(room.deleteTimer);
      room.deleteTimer = undefined;
    }

    if (room.runtime.locked) {
      throw new Error("Room is locked and cannot accept any new connections.");
    }

    const maxPeople = room.settings?.maxPeople ?? this.options.maxClientsPerRoom;
    if (room.sockets.size >= maxPeople) {
      throw new Error("Room is full.");
    }

    room.sockets.set(socket.id, socket);
    room.lastActivityAt = this.now();

    if (room.settings?.lockRoomAfterSecondJoin && room.sockets.size >= 2) {
      room.runtime.locked = true;
    }

    return room;
  }

  leaveRoom(roomId: string, socket: RoomSocketRef) {
    const room = this.rooms.get(roomId);
    if (!room) {
      return;
    }

    room.sockets.delete(socket.id);
    room.lastActivityAt = this.now();

    if (room.sockets.size > 0 || room.deleteTimer !== undefined) {
      return;
    }

    room.deleteTimer = this.setTimeoutFn(() => {
      const current = this.rooms.get(roomId);
      if (!current || current.sockets.size > 0) {
        return;
      }

      this.disposeRoom(current);
      this.rooms.delete(roomId);
    }, this.options.roomIdleGraceMs);
    this.maybeUnref(room.deleteTimer);
  }

  appendMessage(roomId: string, message: StoredMessage) {
    const room = this.rooms.get(roomId);
    if (!room) {
      throw new Error(`Room ${roomId} does not exist.`);
    }

    if (room.settings?.allowBacklog) {
      room.backlog.push(message);
    }

    room.messagesById.set(message.id, message);
    room.messagesByClientMessageId.set(message.clientMessageId, message);
    room.lastActivityAt = this.now();
    room.nextSeq = Math.max(room.nextSeq, message.seq + 1);

    const backlogLimit = room.settings?.maxBacklogMessages ?? this.options.maxBacklogMessages;
    if (room.backlog.length > backlogLimit) {
      room.backlog.splice(0, room.backlog.length - backlogLimit);
    }

    if (message.expiresAt !== null) {
      const delay = Math.max(0, message.expiresAt - this.now());
      message.expiryTimer = this.setTimeoutFn(() => {
        const current = this.rooms.get(roomId);
        if (!current) {
          return;
        }

        const removedMessage = this.removeMessage(roomId, message.id);
        if (!removedMessage) {
          return;
        }

        this.options.onMessageExpired?.({
          roomId,
          roomInstanceId: removedMessage.roomInstanceId,
          messageId: removedMessage.id,
        });
      }, delay);
      this.maybeUnref(message.expiryTimer);
    }

    return room;
  }

  findMessageByClientMessageId(roomId: string, clientMessageId: string) {
    return this.rooms.get(roomId)?.messagesByClientMessageId.get(clientMessageId);
  }

  getMessage(roomId: string, messageId: string) {
    return this.rooms.get(roomId)?.messagesById.get(messageId);
  }

  removeMessage(roomId: string, messageId: string) {
    const room = this.rooms.get(roomId);
    if (!room) {
      return undefined;
    }

    const message = room.messagesById.get(messageId);
    if (!message) {
      return undefined;
    }

    if (message.expiryTimer !== undefined) {
      this.clearTimeoutFn(message.expiryTimer);
    }

    room.messagesById.delete(messageId);
    room.messagesByClientMessageId.delete(message.clientMessageId);
    room.backlog = room.backlog.filter((entry) => entry.id !== messageId);
    return message;
  }

  destroyRoom(roomId: string) {
    const room = this.rooms.get(roomId);
    if (!room) {
      return false;
    }

    this.disposeRoom(room);
    this.rooms.delete(roomId);
    return true;
  }

  setRoomLocked(roomId: string, locked: boolean) {
    const room = this.rooms.get(roomId);
    if (!room) {
      return undefined;
    }

    room.runtime.locked = locked;
    room.lastActivityAt = this.now();
    return room;
  }

  private disposeRoom(room: RoomRecord) {
    if (room.deleteTimer !== undefined) {
      this.clearTimeoutFn(room.deleteTimer);
    }

    if (room.roomExpiryTimer !== undefined) {
      this.clearTimeoutFn(room.roomExpiryTimer);
    }

    for (const message of room.messagesById.values()) {
      if (message.expiryTimer !== undefined) {
        this.clearTimeoutFn(message.expiryTimer);
      }
    }
  }

  private maybeUnref(timer: DeleteTimer | undefined) {
    if (
      typeof timer === "object" &&
      timer !== null &&
      "unref" in timer &&
      typeof timer.unref === "function"
    ) {
      timer.unref();
    }
  }
}

export function createRoomStore(options: RoomStoreOptions) {
  return new RoomStore(options);
}
