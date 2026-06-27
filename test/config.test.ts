import test from 'node:test';
import assert from 'node:assert/strict';

import { createConfigSummary, loadConfig } from '../src/config.js';

test('loads defaults only for unset values and redacts secrets in summary', () => {
  const config = loadConfig({ env: {}, argv: [] });

  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.joinDeadlineMs, 5000);
  assert.equal(config.maxOpenPrejoinSockets, 250);
  assert.equal(config.port, 3000);
  assert.equal(config.singleRoomMode, false);
  assert.equal(config.defaultAllowBacklog, false);
  assert.equal(config.maxMessageSelfDestructMs, 86_400_000);
  assert.equal(config.maxUpgradesPerIpPerWindow, 20);
  assert.equal(config.maxRoomSelfDestructMs, 604_800_000);
  assert.equal(config.upgradeRateLimitWindowMs, 10_000);

  const summary = createConfigSummary(config);
  assert.equal(summary.joinDeadlineMs, 5000);
  assert.equal(summary.maxOpenPrejoinSockets, 250);
  assert.equal(summary.singleRoomKey, undefined);
  assert.equal(summary.allowedRoomId, undefined);
});

test('fails on invalid explicit configuration and derives single-room policy', () => {
  assert.throws(() => {
    loadConfig({
      env: { PORT: 'abc' },
      argv: []
    });
  }, /PORT/);

  assert.throws(() => {
    loadConfig({
      env: { SINGLE_ROOM_MODE: 'true', SINGLE_ROOM_KEY: '' },
      argv: []
    });
  }, /SINGLE_ROOM_KEY/);

  assert.throws(() => {
    loadConfig({
      env: { JOIN_DEADLINE_MS: '30001' },
      argv: []
    });
  }, /JOIN_DEADLINE_MS/);

  assert.throws(() => {
    loadConfig({
      env: { MAX_OPEN_PREJOIN_SOCKETS: '100001' },
      argv: []
    });
  }, /MAX_OPEN_PREJOIN_SOCKETS/);

  assert.throws(() => {
    loadConfig({
      env: { UPGRADE_RATE_LIMIT_WINDOW_MS: '60001' },
      argv: []
    });
  }, /UPGRADE_RATE_LIMIT_WINDOW_MS/);

  assert.throws(() => {
    loadConfig({
      env: { MAX_UPGRADES_PER_IP_PER_WINDOW: '10001' },
      argv: []
    });
  }, /MAX_UPGRADES_PER_IP_PER_WINDOW/);

  const config = loadConfig({
    env: {
      SINGLE_ROOM_MODE: 'true',
      SINGLE_ROOM_KEY: 'shared-secret'
    },
    argv: []
  });

  assert.equal(config.singleRoomMode, true);
  assert.match(config.allowedRoomId ?? '', /^[a-f0-9]{64}$/);

  const summary = createConfigSummary(config);
  assert.equal(summary.singleRoomKey, undefined);
  assert.match(summary.allowedRoomId ?? '', /^[a-f0-9]{8}\.\.\.$/);
});
