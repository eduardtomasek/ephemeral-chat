import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatDocumentTitle,
  getUnreadBannerText,
  shouldIncrementUnread,
} from '../public/app.js';

test('counts unread only for live messages from other participants while away from the bottom', () => {
  assert.equal(shouldIncrementUnread({
    bootstrapComplete: true,
    authoredByMe: false,
    isNearBottom: false,
    kind: 'chat',
  }), true);

  assert.equal(shouldIncrementUnread({
    bootstrapComplete: false,
    authoredByMe: false,
    isNearBottom: false,
    kind: 'chat',
  }), false);

  assert.equal(shouldIncrementUnread({
    bootstrapComplete: true,
    authoredByMe: true,
    isNearBottom: false,
    kind: 'chat',
  }), false);

  assert.equal(shouldIncrementUnread({
    bootstrapComplete: true,
    authoredByMe: false,
    isNearBottom: true,
    kind: 'chat',
  }), false);

  assert.equal(shouldIncrementUnread({
    bootstrapComplete: true,
    authoredByMe: false,
    isNearBottom: false,
    kind: 'system',
  }), false);
});

test('formats unread banner text and document title from the unread count', () => {
  assert.equal(getUnreadBannerText(0), '');
  assert.equal(getUnreadBannerText(1), '1 new message');
  assert.equal(getUnreadBannerText(7), '7 new messages');
  assert.equal(formatDocumentTitle('Ephemeral Chat', 0), 'Ephemeral Chat');
  assert.equal(formatDocumentTitle('Ephemeral Chat', 3), '(3) Ephemeral Chat');
});
