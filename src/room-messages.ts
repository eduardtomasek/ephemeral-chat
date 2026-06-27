import crypto from "node:crypto";

import type { StoredMessage } from "./room-store.js";

type MessageEnvelope = {
  clientMessageId: string;
  iv: string;
  ciphertext: string;
};

type MessageRoom = {
  roomInstanceId: string;
  nextSeq: number;
  settings: {
    messageSelfDestructMs: number | null;
  } | null;
};

export function createStoredMessage(
  room: MessageRoom,
  payload: MessageEnvelope,
  now = Date.now(),
): StoredMessage {
  const sentAt = now;

  return {
    type: "message",
    id: crypto.randomUUID(),
    roomInstanceId: room.roomInstanceId,
    seq: room.nextSeq,
    iv: payload.iv,
    ciphertext: payload.ciphertext,
    clientMessageId: payload.clientMessageId,
    expiresAt: room.settings?.messageSelfDestructMs == null
      ? null
      : sentAt + room.settings.messageSelfDestructMs,
    sentAt,
  };
}

export function toClientMessage(message: StoredMessage, socketId: string) {
  return {
    type: "message",
    id: message.id,
    roomInstanceId: message.roomInstanceId,
    seq: message.seq,
    iv: message.iv,
    ciphertext: message.ciphertext,
    clientMessageId: message.clientMessageId,
    expiresAt: message.expiresAt,
    sentAt: message.sentAt,
  };
}
