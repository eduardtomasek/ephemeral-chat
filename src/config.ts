import crypto from 'node:crypto';

import dotenv from 'dotenv';

const ROOM_PREFIX = 'ephemeralchat-room-v1:';

export type AppConfig = {
  appTitle: string;
  defaultAllowBacklog: boolean;
  host: string;
  joinDeadlineMs: number;
  maxBacklogMessages: number;
  maxClientsPerRoom: number;
  maxMessageSelfDestructMs: number;
  maxMessageSizeBytes: number;
  maxOpenPrejoinSockets: number;
  maxRooms: number;
  maxRoomSelfDestructMs: number;
  maxUpgradesPerIpPerWindow: number;
  port: number;
  rateLimitMaxMessages: number;
  rateLimitWindowMs: number;
  roomIdleGraceMs: number;
  singleRoomKey?: string;
  singleRoomMode: boolean;
  trustProxy: boolean;
  upgradeRateLimitWindowMs: number;
  allowedRoomId?: string;
};

type LoadConfigInput = {
  argv?: string[];
  env?: Record<string, string | undefined>;
};

type RawConfigValue = string | undefined;

const defaults = {
  APP_TITLE: 'Ephemeral Chat',
  DEFAULT_ALLOW_BACKLOG: 'false',
  HOST: '0.0.0.0',
  JOIN_DEADLINE_MS: '5000',
  MAX_BACKLOG_MESSAGES: '100',
  MAX_CLIENTS_PER_ROOM: '32',
  MAX_MESSAGE_SELF_DESTRUCT_MS: '86400000',
  MAX_MESSAGE_SIZE_BYTES: '16384',
  MAX_OPEN_PREJOIN_SOCKETS: '250',
  MAX_ROOMS: '10000',
  MAX_ROOM_SELF_DESTRUCT_MS: '604800000',
  MAX_UPGRADES_PER_IP_PER_WINDOW: '20',
  PORT: '3000',
  RATE_LIMIT_MAX_MESSAGES: '10',
  RATE_LIMIT_WINDOW_MS: '10000',
  ROOM_IDLE_GRACE_MS: '60000',
  SINGLE_ROOM_MODE: 'false',
  TRUST_PROXY: 'false',
  UPGRADE_RATE_LIMIT_WINDOW_MS: '10000'
};

export function loadRuntimeConfig() {
  dotenv.config({ quiet: true });
  return loadConfig({
    argv: process.argv.slice(2),
    env: process.env
  });
}

export function loadConfig({ argv = [], env = {} }: LoadConfigInput) {
  const cli = parseCliArgs(argv);
  const getValue = (name: keyof typeof defaults | 'SINGLE_ROOM_KEY' | 'WS_PORT'): RawConfigValue => {
    const cliValue = cli[name];
    if (cliValue !== undefined) {
      return cliValue;
    }

    const envValue = env[name];
    if (envValue !== undefined) {
      return envValue;
    }

    return name in defaults ? defaults[name as keyof typeof defaults] : undefined;
  };

  const wsPort = getValue('WS_PORT');
  if (wsPort !== undefined && wsPort !== '') {
    throw new Error('WS_PORT is not supported in the single-origin server. Use PORT instead.');
  }

  const singleRoomMode = parseBoolean('SINGLE_ROOM_MODE', getValue('SINGLE_ROOM_MODE'));
  const singleRoomKey = emptyToUndefined(getValue('SINGLE_ROOM_KEY'));

  if (singleRoomMode && !singleRoomKey) {
    throw new Error('SINGLE_ROOM_KEY is required when SINGLE_ROOM_MODE=true.');
  }

  const allowedRoomId = singleRoomKey ? deriveRoomIdFromSharedKey(singleRoomKey) : undefined;

  return {
    appTitle: getString('APP_TITLE', getValue('APP_TITLE')),
    defaultAllowBacklog: parseBoolean('DEFAULT_ALLOW_BACKLOG', getValue('DEFAULT_ALLOW_BACKLOG')),
    host: getString('HOST', getValue('HOST')),
    joinDeadlineMs: parseBoundedPositiveInt('JOIN_DEADLINE_MS', getValue('JOIN_DEADLINE_MS'), 30_000),
    maxBacklogMessages: parsePositiveInt('MAX_BACKLOG_MESSAGES', getValue('MAX_BACKLOG_MESSAGES')),
    maxClientsPerRoom: parsePositiveInt('MAX_CLIENTS_PER_ROOM', getValue('MAX_CLIENTS_PER_ROOM')),
    maxMessageSelfDestructMs: parsePositiveInt('MAX_MESSAGE_SELF_DESTRUCT_MS', getValue('MAX_MESSAGE_SELF_DESTRUCT_MS')),
    maxMessageSizeBytes: parsePositiveInt('MAX_MESSAGE_SIZE_BYTES', getValue('MAX_MESSAGE_SIZE_BYTES')),
    maxOpenPrejoinSockets: parseBoundedPositiveInt('MAX_OPEN_PREJOIN_SOCKETS', getValue('MAX_OPEN_PREJOIN_SOCKETS'), 100_000),
    maxRooms: parsePositiveInt('MAX_ROOMS', getValue('MAX_ROOMS')),
    maxRoomSelfDestructMs: parsePositiveInt('MAX_ROOM_SELF_DESTRUCT_MS', getValue('MAX_ROOM_SELF_DESTRUCT_MS')),
    maxUpgradesPerIpPerWindow: parseBoundedPositiveInt(
      'MAX_UPGRADES_PER_IP_PER_WINDOW',
      getValue('MAX_UPGRADES_PER_IP_PER_WINDOW'),
      10_000
    ),
    port: parsePort(getValue('PORT')),
    rateLimitMaxMessages: parsePositiveInt('RATE_LIMIT_MAX_MESSAGES', getValue('RATE_LIMIT_MAX_MESSAGES')),
    rateLimitWindowMs: parsePositiveInt('RATE_LIMIT_WINDOW_MS', getValue('RATE_LIMIT_WINDOW_MS')),
    roomIdleGraceMs: parsePositiveInt('ROOM_IDLE_GRACE_MS', getValue('ROOM_IDLE_GRACE_MS')),
    singleRoomKey,
    singleRoomMode,
    trustProxy: parseBoolean('TRUST_PROXY', getValue('TRUST_PROXY')),
    upgradeRateLimitWindowMs: parseBoundedPositiveInt(
      'UPGRADE_RATE_LIMIT_WINDOW_MS',
      getValue('UPGRADE_RATE_LIMIT_WINDOW_MS'),
      60_000
    ),
    allowedRoomId
  } satisfies AppConfig;
}

export function createConfigSummary(config: AppConfig) {
  return {
    appTitle: config.appTitle,
    defaultAllowBacklog: config.defaultAllowBacklog,
    host: config.host,
    joinDeadlineMs: config.joinDeadlineMs,
    maxOpenPrejoinSockets: config.maxOpenPrejoinSockets,
    port: config.port,
    trustProxy: config.trustProxy,
    upgradeRateLimitWindowMs: config.upgradeRateLimitWindowMs,
    maxUpgradesPerIpPerWindow: config.maxUpgradesPerIpPerWindow,
    roomIdleGraceMs: config.roomIdleGraceMs,
    maxBacklogMessages: config.maxBacklogMessages,
    maxClientsPerRoom: config.maxClientsPerRoom,
    maxMessageSelfDestructMs: config.maxMessageSelfDestructMs,
    maxRooms: config.maxRooms,
    maxRoomSelfDestructMs: config.maxRoomSelfDestructMs,
    maxMessageSizeBytes: config.maxMessageSizeBytes,
    rateLimitWindowMs: config.rateLimitWindowMs,
    rateLimitMaxMessages: config.rateLimitMaxMessages,
    singleRoomMode: config.singleRoomMode,
    singleRoomKey: undefined,
    allowedRoomId: config.allowedRoomId ? `${config.allowedRoomId.slice(0, 8)}...` : undefined
  };
}

export function deriveRoomIdFromSharedKey(sharedKey: string) {
  return crypto.createHash('sha256').update(`${ROOM_PREFIX}${sharedKey}`, 'utf8').digest('hex');
}

export function isValidRoomId(roomId: string) {
  return /^[a-f0-9]{64}$/.test(roomId);
}

function parseCliArgs(argv: string[]) {
  const values: Record<string, string> = {};

  for (const arg of argv) {
    if (!arg.startsWith('--')) {
      continue;
    }

    const [rawKey, ...rest] = arg.slice(2).split('=');
    const value = rest.join('=');
    if (!rawKey) {
      continue;
    }

    values[rawKey.replace(/-/g, '_').toUpperCase()] = value;
  }

  return values;
}

function parsePositiveInt(name: string, rawValue: RawConfigValue) {
  const value = getString(name, rawValue);
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be a positive integer.`);
  }

  const parsed = Number.parseInt(value, 10);
  if (parsed <= 0) {
    throw new Error(`${name} must be greater than zero.`);
  }

  return parsed;
}

function parseBoundedPositiveInt(name: string, rawValue: RawConfigValue, max: number) {
  const parsed = parsePositiveInt(name, rawValue);
  if (parsed > max) {
    throw new Error(`${name} must be <= ${max}.`);
  }

  return parsed;
}

function parsePort(rawValue: RawConfigValue) {
  const port = parsePositiveInt('PORT', rawValue);
  if (port > 65535) {
    throw new Error('PORT must be <= 65535.');
  }

  return port;
}

function parseBoolean(name: string, rawValue: RawConfigValue) {
  const value = getString(name, rawValue);
  if (value === 'true') {
    return true;
  }

  if (value === 'false') {
    return false;
  }

  throw new Error(`${name} must be "true" or "false".`);
}

function getString(name: string, rawValue: RawConfigValue) {
  if (rawValue === undefined) {
    throw new Error(`${name} is required.`);
  }

  return rawValue;
}

function emptyToUndefined(value: string | undefined) {
  return value === '' ? undefined : value;
}
