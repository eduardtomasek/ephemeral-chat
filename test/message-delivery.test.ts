import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createPendingMessage,
  failPendingMessages,
  markFailedMessagesUndeliverable,
  reconcileConfirmedMessage
} from '../public/app.js';

test('reconciles a server-confirmed echo into the existing local pending message', () => {
  const messages = [
    createPendingMessage({
      clientMessageId: 'client-1',
      createdLocallyAt: 10,
      encrypted: {
        iv: 'a',
        ciphertext: 'b'
      },
      msg: 'hello',
      username: 'Alice'
    })
  ];

  const changed = reconcileConfirmedMessage(messages, {
    clientMessageId: 'client-1',
    id: 'server-1',
    roomInstanceId: 'room-1',
    sentAt: 42,
    seq: 7
  });

  assert.equal(changed, true);
  assert.deepEqual(messages, [{
    id: 'server-1',
    roomInstanceId: 'room-1',
    clientMessageId: 'client-1',
    createdLocallyAt: 10,
    deliveryState: 'sent',
    retryCount: 0,
    encrypted: {
      iv: 'a',
      ciphertext: 'b'
    },
    expiresAt: null,
    msg: 'hello',
    sentAt: 42,
    seq: 7,
    username: 'Alice'
  }]);
});

test('marks only in-flight local messages as failed after disconnect', () => {
  const messages = [
    createPendingMessage({
      clientMessageId: 'sending-1',
      createdLocallyAt: 10,
      encrypted: {
        iv: 'a',
        ciphertext: 'b'
      },
      msg: 'hello',
      username: 'Alice'
    }),
    {
      clientMessageId: 'sent-1',
      createdLocallyAt: 5,
      deliveryState: 'sent',
      encrypted: {
        iv: 'a',
        ciphertext: 'b'
      },
      id: 'server-1',
      msg: 'done',
      retryCount: 0,
      roomInstanceId: 'room-1',
      sentAt: 20,
      seq: 1,
      username: 'Alice'
    }
  ];

  failPendingMessages(messages);

  assert.equal(messages[0].deliveryState, 'failed');
  assert.equal(messages[1].deliveryState, 'sent');
});

test('promotes failed messages to undeliverable when the server reports a final refusal', () => {
  const messages = [
    {
      ...createPendingMessage({
        clientMessageId: 'failed-1',
        createdLocallyAt: 10,
        encrypted: {
          iv: 'a',
          ciphertext: 'b'
        },
        msg: 'hello',
        username: 'Alice'
      }),
      deliveryState: 'failed'
    },
    {
      ...createPendingMessage({
        clientMessageId: 'sending-1',
        createdLocallyAt: 11,
        encrypted: {
          iv: 'c',
          ciphertext: 'd'
        },
        msg: 'still sending',
        username: 'Alice'
      }),
      deliveryState: 'sending'
    }
  ];

  markFailedMessagesUndeliverable(messages, 'Room expired.');

  assert.equal(messages[0].deliveryState, 'undeliverable');
  assert.equal(messages[0].failureReason, 'Room expired.');
  assert.equal(messages[1].deliveryState, 'sending');
});
