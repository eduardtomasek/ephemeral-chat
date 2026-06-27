const ROOM_PREFIX = 'ephemeralchat-room-v1:';
const ENCRYPTION_SALT = 'ephemeralchat-encryption-v1';
const ENCRYPTION_ITERATIONS = 300000;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export {
  buildRoomWebSocketUrl,
  createFallbackUsername,
  createPendingMessage,
  failPendingMessages,
  formatDocumentTitle,
  formatRoomExpiryCountdown,
  formatRoomSettingsSummary,
  getUnreadBannerText,
  markFailedMessagesUndeliverable,
  normalizeUsername,
  parseOptionalDurationMs,
  parseOptionalMaxPeople,
  reconcileConfirmedMessage,
  shouldIncrementUnread
} from './chat-session.js';

import {
  buildRoomWebSocketUrl,
  createChatSession,
  createFallbackUsername,
  createPendingMessage,
  failPendingMessages,
  formatDocumentTitle,
  formatRoomExpiryCountdown,
  formatRoomSettingsSummary,
  getUnreadBannerText,
  markFailedMessagesUndeliverable,
  normalizeUsername,
  parseOptionalDurationMs,
  parseOptionalMaxPeople,
  reconcileConfirmedMessage,
  shouldIncrementUnread
} from './chat-session.js';

export async function deriveRoomId(sharedKey) {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(`${ROOM_PREFIX}${sharedKey}`));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function deriveEncryptionKey(sharedKey) {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(sharedKey),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey({
    name: 'PBKDF2',
    hash: 'SHA-256',
    salt: textEncoder.encode(ENCRYPTION_SALT),
    iterations: ENCRYPTION_ITERATIONS
  }, baseKey, {
    name: 'AES-GCM',
    length: 256
  }, false, ['encrypt', 'decrypt']);
}

export async function encryptChatMessage(key, payload) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    textEncoder.encode(JSON.stringify(payload))
  );

  return {
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext))
  };
}

export async function decryptChatMessage(key, payload) {
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(payload.iv) },
    key,
    base64ToBytes(payload.ciphertext)
  );

  const parsed = JSON.parse(textDecoder.decode(plaintext));
  if (!isChatPayload(parsed)) {
    throw new Error('Invalid chat payload.');
  }

  return parsed;
}

export function formatMessageTime(timestamp) {
  return new Intl.DateTimeFormat(undefined, {
    hour12: false,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit'
  }).format(timestamp);
}

export function colorForUsername(username) {
  let hash = 0;
  for (const char of username) {
    hash = (hash * 31 + char.charCodeAt(0)) % 360;
  }

  return `hsl(${hash} 75% 65%)`;
}

export function isNearBottom(element, threshold = 48) {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= threshold;
}

function isChatPayload(value) {
  return value
    && typeof value === 'object'
    && typeof value.username === 'string'
    && typeof value.msg === 'string';
}

function bytesToBase64(bytes) {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }

  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

function base64ToBytes(value) {
  if (typeof Buffer !== 'undefined') {
    return Uint8Array.from(Buffer.from(value, 'base64'));
  }

  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function bootstrap() {
  const joinForm = document.querySelector('#join-form');
  if (!(joinForm instanceof HTMLFormElement)) {
    return;
  }

  const state = createChatSession();
  const joinView = document.querySelector('#join-view');
  const chatView = document.querySelector('#chat-view');
  const joinError = document.querySelector('#join-error');
  const chatError = document.querySelector('#chat-error');
  const statusNode = document.querySelector('#connection-status');
  const localUsernameNode = document.querySelector('#local-username');
  const roomSettingsSummaryNode = document.querySelector('#room-settings-summary');
  const sharedKeyInput = document.querySelector('#shared-key');
  const usernameInput = document.querySelector('#username');
  const maxPeopleInput = document.querySelector('#max-people');
  const allowBacklogInput = document.querySelector('#allow-backlog');
  const maxBacklogMessagesInput = document.querySelector('#max-backlog-messages');
  const lockRoomAfterSecondJoinInput = document.querySelector('#lock-room-after-second-join');
  const messageSelfDestructMsInput = document.querySelector('#message-self-destruct-ms');
  const roomSelfDestructMsInput = document.querySelector('#room-self-destruct-ms');
  const composerForm = document.querySelector('#composer-form');
  const composerInput = document.querySelector('#composer-input');
  const killRoomButton = document.querySelector('#kill-room-button');
  const messengerSkinButton = document.querySelector('#room-skin-button');
  const roomLockButton = document.querySelector('#room-lock-button');
  const sendButton = composerForm?.querySelector('button[type="submit"]');
  const timeline = document.querySelector('#timeline');
  const unreadBanner = document.querySelector('#unread-banner');
  const roomExpiryCountdownNode = document.querySelector('#room-expiry-countdown');
  if (!(joinView instanceof HTMLElement)
    || !(chatView instanceof HTMLElement)
    || !(joinError instanceof HTMLElement)
    || !(chatError instanceof HTMLElement)
    || !(localUsernameNode instanceof HTMLElement)
    || !(roomSettingsSummaryNode instanceof HTMLElement)
    || !(sharedKeyInput instanceof HTMLInputElement)
    || !(usernameInput instanceof HTMLInputElement)
    || !(maxPeopleInput instanceof HTMLInputElement)
    || !(allowBacklogInput instanceof HTMLInputElement)
    || !(maxBacklogMessagesInput instanceof HTMLInputElement)
    || !(lockRoomAfterSecondJoinInput instanceof HTMLInputElement)
    || !(messageSelfDestructMsInput instanceof HTMLInputElement)
    || !(roomSelfDestructMsInput instanceof HTMLInputElement)
    || !(composerForm instanceof HTMLFormElement)
    || !(composerInput instanceof HTMLInputElement)
    || !(killRoomButton instanceof HTMLButtonElement)
    || !(messengerSkinButton instanceof HTMLButtonElement)
    || !(roomLockButton instanceof HTMLButtonElement)
    || !(sendButton instanceof HTMLButtonElement)
    || !(timeline instanceof HTMLOListElement)
    || !(unreadBanner instanceof HTMLButtonElement)
    || !(roomExpiryCountdownNode instanceof HTMLElement)) {
    return;
  }

  const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  let messengerSkinEnabled = false;

  const renderMessengerSkin = () => {
    const skinVisible = messengerSkinEnabled && !chatView.hidden;
    messengerSkinButton.dataset.active = messengerSkinEnabled ? 'true' : 'false';
    messengerSkinButton.setAttribute('aria-pressed', messengerSkinEnabled ? 'true' : 'false');
    messengerSkinButton.setAttribute('aria-label', messengerSkinEnabled
      ? 'Disable Facebook-style skin'
      : 'Enable Facebook-style skin');
    messengerSkinButton.title = messengerSkinEnabled
      ? 'Disable Facebook-style skin'
      : 'Enable Facebook-style skin';
    chatView.dataset.skin = skinVisible ? 'messenger' : 'default';

    if (skinVisible) {
      document.body.dataset.roomSkin = 'messenger';
      return;
    }

    delete document.body.dataset.roomSkin;
  };

  const setComposerEnabled = (enabled) => {
    roomLockButton.disabled = !enabled;
    killRoomButton.disabled = !enabled;
    composerInput.disabled = !enabled;
    sendButton.disabled = !enabled;
  };

  const removeMessageById = (messageId) => state.removeMessageById(messageId);

  const setStatus = (text, isError = false) => {
    if (!(statusNode instanceof HTMLElement)) {
      return;
    }

    statusNode.textContent = text;
    statusNode.dataset.state = isError ? 'error' : 'ok';
  };

  const renderRoomSettingsSummary = () => {
    const summary = formatRoomSettingsSummary(state.roomSettings);
    roomSettingsSummaryNode.hidden = !summary;
    roomSettingsSummaryNode.textContent = summary;
  };

  const renderRoomLockState = () => {
    const locked = state.roomRuntime?.locked === true;
    const autoLock = state.roomSettings?.lockRoomAfterSecondJoin === true;
    roomLockButton.dataset.locked = locked ? 'true' : 'false';
    roomLockButton.dataset.autoLock = autoLock ? 'true' : 'false';
    roomLockButton.disabled = autoLock || !state.socket || state.socket.readyState !== WebSocket.OPEN;
    roomLockButton.setAttribute('aria-pressed', locked ? 'true' : 'false');
    roomLockButton.setAttribute('aria-label', autoLock
      ? (locked ? 'Room locked automatically' : 'Room unlocked automatically')
      : (locked ? 'Unlock room' : 'Lock room'));
    roomLockButton.title = autoLock
      ? (locked ? 'Auto-lock: locked' : 'Auto-lock: unlocked')
      : (locked ? 'Locked' : 'Unlocked');
  };

  const renderRoomExpiryCountdown = () => {
    const text = formatRoomExpiryCountdown(state.roomRuntime?.roomExpiresAt ?? null);
    roomExpiryCountdownNode.hidden = !text;
    roomExpiryCountdownNode.textContent = text;
  };

  const restartRoomExpiryTicker = () => {
    if (state.roomExpiryTicker !== null) {
      window.clearInterval(state.roomExpiryTicker);
      state.roomExpiryTicker = null;
    }

    renderRoomExpiryCountdown();
    if (!state.roomRuntime?.roomExpiresAt) {
      return;
    }

    state.roomExpiryTicker = window.setInterval(() => {
      renderRoomExpiryCountdown();
    }, 250);
  };

  const renderUnreadState = () => {
    const text = getUnreadBannerText(state.unreadCount);
    unreadBanner.hidden = !text;
    unreadBanner.textContent = text;
  };

  const clearUnread = () => {
    state.clearUnread();
    renderUnreadState();
  };

  const scrollTimelineToBottom = (behavior = 'auto') => {
    const resolvedBehavior = reducedMotionQuery.matches ? 'auto' : behavior;
    timeline.scrollTo({
      top: timeline.scrollHeight,
      behavior: resolvedBehavior
    });
    clearUnread();
  };

  const scrollTimelineAfterViewportSettles = (behavior = 'smooth') => {
    let settled = false;
    let settleTimer = 0;
    let fallbackTimer = 0;
    const viewport = window.visualViewport;

    const finish = () => {
      if (settled) {
        return;
      }

      settled = true;
      if (viewport) {
        viewport.removeEventListener('resize', scheduleFinish);
      }
      window.removeEventListener('resize', scheduleFinish);
      window.clearTimeout(settleTimer);
      window.clearTimeout(fallbackTimer);
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          scrollTimelineToBottom(behavior);
        });
      });
    };

    function scheduleFinish() {
      window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(finish, 120);
    }

    if (viewport) {
      viewport.addEventListener('resize', scheduleFinish);
    }
    window.addEventListener('resize', scheduleFinish);
    scheduleFinish();
    fallbackTimer = window.setTimeout(finish, 480);
  };

  const destroyLocalSession = () => {
    if (state.roomExpiryTicker !== null) {
      window.clearInterval(state.roomExpiryTicker);
      state.roomExpiryTicker = null;
    }

    if (state.reconnectTimer !== null) {
      window.clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }

    joinForm.reset();
    composerForm.reset();
    localUsernameNode.textContent = '';
    state.key = null;
    state.localUsername = '';
    state.roomId = '';
    state.roomInstanceId = '';
    state.roomSettings = null;
    state.roomRuntime = null;
    state.requestedRoomSettings = null;
    state.finalError = null;
    state.bootstrapComplete = false;
    state.joined = false;
    state.socket = null;
    resetRoomTimeline();
  };

  const resetRoomTimeline = () => {
    state.resetRoomTimeline();
    renderUnreadState();
    restartRoomExpiryTicker();
    renderRoomSettingsSummary();
    renderRoomLockState();
    renderTimeline();
  };

  const returnToJoinView = (message) => {
    destroyLocalSession();
    joinView.hidden = false;
    chatView.hidden = true;
    renderMessengerSkin();
    joinError.hidden = false;
    joinError.textContent = message;
    chatError.hidden = true;
  };

  const renderTimeline = () => {
    const shouldStick = isNearBottom(timeline);
    timeline.replaceChildren();
    state.messages.sort((left, right) => {
      if (typeof left.seq === 'number' && typeof right.seq === 'number') {
        return left.seq - right.seq;
      }

      return left.createdLocallyAt - right.createdLocallyAt;
    });

    for (const message of state.messages) {
      const item = document.createElement('li');
      item.className = message.kind === 'system' ? 'message system-event' : 'message';

      if (message.kind === 'system') {
        const body = document.createElement('p');
        body.textContent = message.msg;
        item.append(body);
        timeline.append(item);
        continue;
      }

      item.classList.add(message.authoredByMe ? 'message-own' : 'message-other');

      if (messengerSkinEnabled) {
        const meta = document.createElement('div');
        meta.className = 'message-meta';

        const author = document.createElement('strong');
        author.className = 'message-author';
        author.textContent = message.username;

        const time = document.createElement('span');
        time.className = 'message-time';
        time.textContent = formatMessageTime(message.sentAt);

        const body = document.createElement('p');
        body.className = 'message-body';
        body.textContent = message.msg;

        meta.append(author, time);
        item.append(meta, body);
      } else {
        const header = document.createElement('div');
        header.className = 'message-header';

        const author = document.createElement('strong');
        author.textContent = message.username;
        author.style.color = colorForUsername(message.username);

        const prompt = document.createElement('span');
        prompt.className = message.authoredByMe ? 'message-prompt message-prompt-own' : 'message-prompt';
        prompt.textContent = '>';

        const time = document.createElement('span');
        time.className = 'message-time';
        time.textContent = formatMessageTime(message.sentAt);

        const body = document.createElement('p');
        body.className = 'message-body';
        body.textContent = message.msg;

        header.append(time, author, prompt, body);
        item.append(header);
      }

      if (message.deliveryState && message.deliveryState !== 'sent') {
        const status = document.createElement('span');
        status.className = 'message-status';
        status.textContent = message.failureReason
          ? `(${message.deliveryState}: ${message.failureReason})`
          : `(${message.deliveryState})`;
        item.append(status);
      }

      if (message.deliveryState === 'failed') {
        const retryButton = document.createElement('button');
        retryButton.type = 'button';
        retryButton.textContent = 'Retry';
        retryButton.addEventListener('click', () => {
          resendMessage(message);
        });
        item.append(retryButton);
      }

      timeline.append(item);
    }

    if (shouldStick) {
      scrollTimelineToBottom('auto');
    }
  };

  const sendEncryptedEnvelope = (message) => {
    if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
      return false;
    }

    state.socket.send(JSON.stringify({
      type: 'message',
      clientMessageId: message.clientMessageId,
      ...message.encrypted
    }));
    return true;
  };

  const resendMessage = (message) => {
    if (!sendEncryptedEnvelope(message)) {
      return;
    }

    message.deliveryState = 'sending';
    message.retryCount += 1;
    renderTimeline();
  };

  const resendFailedMessages = () => {
    for (const message of state.messages) {
      if (message.deliveryState !== 'failed') {
        continue;
      }

      resendMessage(message);
    }
  };

  const scheduleReconnect = () => {
    if (state.reconnectTimer !== null || !state.roomId || !state.key) {
      return;
    }

    state.reconnectTimer = window.setTimeout(() => {
      state.reconnectTimer = null;
      connect(state.requestedRoomSettings);
    }, 1000);
  };

  const handleServerMessage = async (event) => {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }

    if (payload.type === 'room-state') {
      if (state.roomInstanceId && payload.roomInstanceId !== state.roomInstanceId) {
        resetRoomTimeline();
      }
      state.roomInstanceId = payload.roomInstanceId ?? '';
      state.roomSettings = payload.settings ?? null;
      state.roomRuntime = payload.runtime ?? null;
      state.bootstrapComplete = false;
      renderRoomSettingsSummary();
      renderRoomLockState();
      restartRoomExpiryTicker();
      return;
    }

    if (payload.type === 'backlog' && Array.isArray(payload.messages)) {
      if (!state.joined) {
        localUsernameNode.textContent = state.localUsername;
        joinView.hidden = true;
        chatView.hidden = false;
        renderMessengerSkin();
        state.joined = true;
        setComposerEnabled(true);
        composerInput.focus();
      }
      for (const message of payload.messages) {
        await ingestEncryptedMessage(message);
      }
      state.bootstrapComplete = true;
      resendFailedMessages();
      return;
    }

    if (payload.type === 'presence') {
      if (payload.roomInstanceId && payload.roomInstanceId !== state.roomInstanceId) {
        return;
      }
      return;
    }

    if (payload.type === 'message') {
      await ingestEncryptedMessage(payload);
      return;
    }

    if (payload.type === 'error') {
      if (payload.roomInstanceId && payload.roomInstanceId !== state.roomInstanceId) {
        return;
      }

      state.finalError = payload;
      return;
    }

    if (payload.type === 'system-event') {
      if (payload.roomInstanceId && payload.roomInstanceId !== state.roomInstanceId) {
        return;
      }

      state.addSystemEvent(payload);
      renderTimeline();
      return;
    }

    if (payload.type === 'message-removed') {
      if (payload.roomInstanceId && payload.roomInstanceId !== state.roomInstanceId) {
        return;
      }

      if (removeMessageById(payload.messageId)) {
        renderTimeline();
      }
    }
  };

  const ingestEncryptedMessage = async (payload) => {
    if (!state.key
      || state.messageIds.has(payload.id)
      || (payload.roomInstanceId && payload.roomInstanceId !== state.roomInstanceId)) {
      return;
    }

    try {
      const decrypted = await decryptChatMessage(state.key, payload);
      if (reconcileConfirmedMessage(state.messages, payload)) {
        state.messageIds.add(payload.id);
        if (payload.expiresAt) {
          window.setTimeout(() => {
            if (removeMessageById(payload.id)) {
              renderTimeline();
            }
          }, Math.max(0, payload.expiresAt - Date.now()));
        }
        renderTimeline();
        return;
      }

      const authoredByMe = false;
      state.messageIds.add(payload.id);
      state.messages.push({
        id: payload.id,
        kind: 'chat',
        roomInstanceId: payload.roomInstanceId ?? '',
        clientMessageId: payload.clientMessageId,
        authoredByMe,
        createdLocallyAt: payload.sentAt,
        deliveryState: 'sent',
        retryCount: 0,
        encrypted: null,
        expiresAt: payload.expiresAt ?? null,
        seq: payload.seq,
        sentAt: payload.sentAt,
        username: decrypted.username,
        msg: decrypted.msg
      });

      if (shouldIncrementUnread({
        bootstrapComplete: state.bootstrapComplete,
        authoredByMe,
        isNearBottom: isNearBottom(timeline),
        kind: 'chat'
      })) {
        state.unreadCount += 1;
        renderUnreadState();
      }

      if (payload.expiresAt) {
        window.setTimeout(() => {
          if (removeMessageById(payload.id)) {
            renderTimeline();
          }
        }, Math.max(0, payload.expiresAt - Date.now()));
      }

      renderTimeline();
    } catch {
      // ponytail: skip only the broken message; valid messages still render.
    }
  };

  const connect = (roomSettings) => {
    const socket = new WebSocket(buildRoomWebSocketUrl(window.location));
    state.socket = socket;
    setStatus('Connecting');
    setComposerEnabled(false);
    chatError.hidden = true;
    joinError.hidden = true;
    state.joined = false;
    state.bootstrapComplete = false;
    state.roomInstanceId = '';
    state.roomRuntime = null;
    state.finalError = null;
    renderRoomLockState();
    restartRoomExpiryTicker();

    socket.addEventListener('open', () => {
      setStatus('Connected');
      socket.send(JSON.stringify({
        type: 'join',
        roomId: state.roomId,
        roomSettings
      }));
    });

    socket.addEventListener('message', (event) => {
      void handleServerMessage(event);
    });

    socket.addEventListener('close', (event) => {
      state.socket = null;
      setStatus('Disconnected', true);
      setComposerEnabled(false);
      failPendingMessages(state.messages);
      if (state.finalError?.retryability === 'final') {
        markFailedMessagesUndeliverable(state.messages, state.finalError.message);
      }
      renderTimeline();

      if (!state.joined) {
        joinView.hidden = false;
        chatView.hidden = true;
        renderMessengerSkin();
        joinError.hidden = false;
        joinError.textContent = event.reason || 'Unable to join room.';
        return;
      }

      if (state.finalError?.reasonCode === 'room_destroyed' || state.finalError?.reasonCode === 'room_expired') {
        returnToJoinView(state.finalError.message);
        return;
      }

      chatError.hidden = false;
      if (state.finalError?.retryability === 'final') {
        chatError.textContent = state.finalError.message;
        return;
      }

      chatError.textContent = 'Connection closed. Reconnecting...';
      scheduleReconnect();
    });
  };

  joinForm.addEventListener('submit', async (event) => {
    event.preventDefault();

    const sharedKey = sharedKeyInput.value.trim();
    const chosenUsername = normalizeUsername(usernameInput.value) || createFallbackUsername();
    const maxAllowed = Number.parseInt(maxPeopleInput.max || '0', 10);
    const maxBacklogAllowed = Number.parseInt(maxBacklogMessagesInput.max || '0', 10);
    const maxMessageSelfDestructAllowed = Number.parseInt(messageSelfDestructMsInput.max || '0', 10);
    const maxRoomSelfDestructAllowed = Number.parseInt(roomSelfDestructMsInput.max || '0', 10);
    if (!sharedKey) {
      joinError.hidden = false;
      joinError.textContent = 'Shared key is required.';
      return;
    }

    let requestedRoomSettings;
    try {
      requestedRoomSettings = {
        maxPeople: parseOptionalMaxPeople(maxPeopleInput.value, maxAllowed),
        allowBacklog: allowBacklogInput.checked,
        maxBacklogMessages: parseOptionalDurationMs(maxBacklogMessagesInput.value, maxBacklogAllowed, 'Max backlog messages'),
        lockRoomAfterSecondJoin: lockRoomAfterSecondJoinInput.checked,
        messageSelfDestructMs: parseOptionalDurationMs(messageSelfDestructMsInput.value, maxMessageSelfDestructAllowed, 'Message self-destruct'),
        roomSelfDestructMs: parseOptionalDurationMs(roomSelfDestructMsInput.value, maxRoomSelfDestructAllowed, 'Room self-destruct')
      };
    } catch (error) {
      joinError.hidden = false;
      joinError.textContent = error instanceof Error ? error.message : 'Invalid room settings.';
      return;
    }

    joinError.hidden = true;
    state.localUsername = chosenUsername;
    state.roomId = await deriveRoomId(sharedKey);
    state.key = await deriveEncryptionKey(sharedKey);
    state.roomSettings = null;
    state.roomRuntime = null;
    clearUnread();
    restartRoomExpiryTicker();
    state.requestedRoomSettings = requestedRoomSettings;
    sharedKeyInput.value = '';
    connect(requestedRoomSettings);
  });

  composerForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!state.socket || state.socket.readyState !== WebSocket.OPEN || !state.key) {
      return;
    }

    const msg = composerInput.value.trim();
    if (!msg) {
      return;
    }

    const encrypted = await encryptChatMessage(state.key, {
      username: state.localUsername,
      msg
    });

    const pendingMessage = createPendingMessage({
      clientMessageId: crypto.randomUUID(),
      createdLocallyAt: Date.now(),
      encrypted,
      msg,
      username: state.localUsername
    });
    pendingMessage.kind = 'chat';
    pendingMessage.authoredByMe = true;
    state.messages.push(pendingMessage);
    renderTimeline();
    sendEncryptedEnvelope(pendingMessage);
    composerInput.value = '';
    scrollTimelineAfterViewportSettles('smooth');
  });

  killRoomButton.addEventListener('click', () => {
    if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
      return;
    }

    state.socket.send(JSON.stringify({
      type: 'kill-room'
    }));
  });

  messengerSkinButton.addEventListener('click', () => {
    messengerSkinEnabled = !messengerSkinEnabled;
    renderMessengerSkin();
    renderTimeline();
  });

  roomLockButton.addEventListener('click', () => {
    if (!state.socket
      || state.socket.readyState !== WebSocket.OPEN
      || !state.roomRuntime
      || state.roomSettings?.lockRoomAfterSecondJoin) {
      return;
    }

    state.socket.send(JSON.stringify({
      type: 'set-room-lock',
      locked: !state.roomRuntime.locked
    }));
  });

  setStatus('Ready to join');
  unreadBanner.addEventListener('click', () => {
    scrollTimelineToBottom('smooth');
  });
  timeline.addEventListener('scroll', () => {
    if (isNearBottom(timeline)) {
      clearUnread();
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && isNearBottom(timeline)) {
      clearUnread();
    }
  });
  renderUnreadState();
  renderRoomLockState();
  renderMessengerSkin();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
  } else {
    bootstrap();
  }
}
