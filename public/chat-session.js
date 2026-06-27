const USERNAME_LENGTH = 8;

export function normalizeUsername(value) {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  const sliced = trimmed.slice(0, USERNAME_LENGTH);
  return `${sliced}${createNumericSuffix(USERNAME_LENGTH - sliced.length)}`;
}

export function createFallbackUsername() {
  const adjectives = [
    'Neon', 'Black', 'Silent', 'Ghost', 'Cipher', 'Night',
    'Zero', 'Null', 'Void', 'Hex', 'Dark', 'Root',
    'Dead', 'Raw', 'Bare', 'Lost', 'Cold', 'Rogue',
    'Blind', 'Byte', 'Iron', 'Deep', 'Acid', 'Flux',
    'Ash', 'Blur', 'Burn', 'Core', 'Cron', 'Ctrl',
    'Dusk', 'Edge', 'Fast', 'Fuzz', 'Gray', 'Grid',
    'Hard', 'Hash', 'Init', 'Kern', 'Kill', 'Last',
    'Leak', 'Lite', 'Lock', 'Loop', 'Mute', 'Open',
    'Over', 'Ping', 'Port', 'Pure', 'Rift', 'Sand',
    'Scan', 'Seed', 'Slim', 'Slow', 'Snap', 'Soft',
    'Spin', 'Stab', 'Swap', 'Sync', 'Temp', 'Term',
    'Thin', 'Trap', 'Trek', 'Trim', 'True', 'Turbo',
    'Uber', 'Unix', 'Uplink', 'Veil', 'Viral', 'Warm',
    'Wave', 'Wild', 'Wire', 'Worm', 'Xor', 'Zero',
    'Zeta', 'Zinc', 'Zone', 'Zoom', 'Anon', 'Blaze',
    'Brute', 'Cache'
  ];
  const animals = [
    'Fox', 'Raven', 'Wolf', 'Moth', 'Otter', 'Lynx',
    'Crow', 'Viper', 'Hawk', 'Wasp', 'Mink', 'Crane',
    'Pike', 'Kite', 'Ibis', 'Newt', 'Bison', 'Puma',
    'Wren', 'Finch', 'Stoat', 'Gecko', 'Adder', 'Dingo',
    'Egret', 'Gator', 'Heron', 'Jackal', 'Lemur', 'Mamba',
    'Osprey', 'Quail', 'Roach', 'Shrike', 'Tapir', 'Vole',
    'Wombat', 'Yak', 'Bream', 'Caiman', 'Impala', 'Kestrel',
    'Urial', 'Xerus', 'Zorilla', 'Narwhal', 'Piranha', 'Dace',
    'Asp', 'Bat', 'Boa', 'Bug', 'Cod', 'Eel',
    'Elk', 'Emu', 'Gnu', 'Jay', 'Ram', 'Rat',
    'Ray', 'Slug', 'Smew', 'Snipe', 'Sprat', 'Stork',
    'Swift', 'Teal', 'Toad', 'Trout', 'Tunny', 'Vole',
    'Waxwing', 'Weevil', 'Whiting', 'Widgeon', 'Willet', 'Wireworm',
    'Wrasse', 'Wyvern', 'Yaffle', 'Zander', 'Zebu', 'Zibet',
    'Alpaca', 'Axolotl', 'Badger', 'Barbet', 'Bittern', 'Bongo',
    'Booby', 'Bulbul'
  ];
  const adjective = adjectives[Math.floor(Math.random() * adjectives.length)];
  const animal = animals[Math.floor(Math.random() * animals.length)];
  const base = `${adjective}${animal}`.replace(/[^a-z0-9]/gi, '');
  return `${base.slice(0, USERNAME_LENGTH)}${createNumericSuffix(USERNAME_LENGTH - Math.min(base.length, USERNAME_LENGTH))}`;
}

function createNumericSuffix(length) {
  let suffix = '';
  for (let index = 0; index < length; index += 1) {
    suffix += String(Math.floor(Math.random() * 10));
  }
  return suffix;
}

export function parseOptionalMaxPeople(value, maxAllowed) {
  return parseOptionalDurationMs(value, maxAllowed, 'Max people');
}

export function parseOptionalDurationMs(value, maxAllowed, label) {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`${label} must be a whole number.`);
  }

  const parsed = Number.parseInt(trimmed, 10);
  if (parsed < 1 || parsed > maxAllowed) {
    throw new Error(`${label} must be between 1 and ${maxAllowed}.`);
  }

  return parsed;
}

export function buildRoomWebSocketUrl(locationLike, roomId, roomSettings) {
  const protocol = locationLike.protocol === 'https:' ? 'wss:' : 'ws:';
  return new URL(`${protocol}//${locationLike.host}/ws`).toString();
}

export function formatRoomSettingsSummary(roomSettings) {
  if (!roomSettings) {
    return '';
  }

  const parts = [];

  if (roomSettings.allowBacklog) {
    parts.push('Backlog on');
    if (roomSettings.maxBacklogMessages !== null) {
      parts.push(`${roomSettings.maxBacklogMessages} messages`);
    }
  } else {
    parts.push('Backlog off');
  }

  if (roomSettings.lockRoomAfterSecondJoin) {
    parts.push('2-person auto-lock');
  } else if (roomSettings.maxPeople) {
    parts.push(`Max people: ${roomSettings.maxPeople}`);
  }

  if (roomSettings.messageSelfDestructMs !== null) {
    parts.push('Messages self-destruct');
  }

  if (roomSettings.roomSelfDestructMs !== null) {
    parts.push('Room self-destruct');
  }

  return parts.join(' · ');
}

export function shouldIncrementUnread({
  bootstrapComplete,
  authoredByMe,
  isNearBottom,
  kind
}) {
  return bootstrapComplete && !authoredByMe && !isNearBottom && kind === 'chat';
}

export function getUnreadBannerText(unreadCount) {
  if (unreadCount < 1) {
    return '';
  }

  return unreadCount === 1 ? '1 new message' : `${unreadCount} new messages`;
}

export function formatDocumentTitle(appTitle, unreadCount) {
  return unreadCount > 0 ? `(${unreadCount}) ${appTitle}` : appTitle;
}

export function formatRoomExpiryCountdown(roomExpiresAt, now = Date.now()) {
  if (typeof roomExpiresAt !== 'number' || !Number.isFinite(roomExpiresAt)) {
    return '';
  }

  const remainingSeconds = Math.max(0, Math.ceil((roomExpiresAt - now) / 1000));
  return remainingSeconds === 0 ? 'Room expires now' : `Room expires in ${remainingSeconds}s`;
}

export function createPendingMessage({
  clientMessageId,
  createdLocallyAt,
  encrypted,
  msg,
  username
}) {
  return {
    id: null,
    roomInstanceId: '',
    clientMessageId,
    createdLocallyAt,
    deliveryState: 'sending',
    retryCount: 0,
    encrypted,
    msg,
    sentAt: createdLocallyAt,
    seq: null,
    username
  };
}

export function failPendingMessages(messages) {
  for (const message of messages) {
    if (message.deliveryState === 'sending') {
      message.deliveryState = 'failed';
    }
  }
}

export function markFailedMessagesUndeliverable(messages, reason) {
  for (const message of messages) {
    if (message.deliveryState !== 'failed') {
      continue;
    }

    message.deliveryState = 'undeliverable';
    message.failureReason = reason;
  }
}

export function reconcileConfirmedMessage(messages, confirmedMessage) {
  const existing = messages.find((message) => message.clientMessageId === confirmedMessage.clientMessageId);
  if (!existing) {
    return false;
  }

  existing.id = confirmedMessage.id;
  existing.roomInstanceId = confirmedMessage.roomInstanceId ?? '';
  existing.seq = confirmedMessage.seq;
  existing.sentAt = confirmedMessage.sentAt;
  existing.expiresAt = confirmedMessage.expiresAt ?? null;
  existing.deliveryState = 'sent';
  return true;
}

export function createChatSession() {
  return {
    key: null,
    localUsername: '',
    messages: [],
    messageIds: new Set(),
    roomId: '',
    roomInstanceId: '',
    roomSettings: null,
    roomRuntime: null,
    joined: false,
    requestedRoomSettings: null,
    roomExpiryTicker: null,
    reconnectTimer: null,
    bootstrapComplete: false,
    finalError: null,
    unreadCount: 0,
    socket: null,
    clearUnread() {
      this.unreadCount = 0;
    },
    removeMessageById(messageId) {
      const nextMessages = this.messages.filter((message) => message.id !== messageId);
      if (nextMessages.length === this.messages.length) {
        return false;
      }

      this.messages = nextMessages;
      this.messageIds.delete(messageId);
      return true;
    },
    resetRoomTimeline() {
      this.messages = [];
      this.messageIds.clear();
      this.roomRuntime = null;
      this.clearUnread();
    },
    addSystemEvent(payload) {
      const sentAt = payload.sentAt ?? Date.now();
      this.messages.push({
        id: `system:${sentAt}:${payload.text}`,
        kind: 'system',
        roomInstanceId: payload.roomInstanceId ?? '',
        clientMessageId: null,
        authoredByMe: false,
        createdLocallyAt: sentAt,
        deliveryState: 'sent',
        retryCount: 0,
        encrypted: null,
        seq: null,
        sentAt,
        username: 'System',
        msg: payload.text
      });
    }
  };
}
