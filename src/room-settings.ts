import type { AppConfig } from "./config.js";

export type RoomSettings = {
  maxPeople: number;
  allowBacklog: boolean;
  maxBacklogMessages: number | null;
  lockRoomAfterSecondJoin: boolean;
  messageSelfDestructMs: number | null;
  roomSelfDestructMs: number | null;
};

type RoomSettingsConfig = Pick<
  AppConfig,
  | "defaultAllowBacklog"
  | "maxBacklogMessages"
  | "maxClientsPerRoom"
  | "maxMessageSelfDestructMs"
  | "maxRoomSelfDestructMs"
>;

const INVALID = Symbol("invalid");

export function createDefaultRoomSettings(
  config: RoomSettingsConfig,
): RoomSettings {
  return normalizeRoomSettings(
    {
      maxPeople: config.maxClientsPerRoom,
      allowBacklog: config.defaultAllowBacklog,
      maxBacklogMessages: config.defaultAllowBacklog
        ? config.maxBacklogMessages
        : null,
      lockRoomAfterSecondJoin: false,
      messageSelfDestructMs: null,
      roomSelfDestructMs: null,
    },
    config,
  );
}

export function normalizeRoomSettings(
  settings: RoomSettings,
  config: RoomSettingsConfig,
): RoomSettings {
  const normalized = { ...settings };

  if (!normalized.allowBacklog) {
    normalized.maxBacklogMessages = null;
  } else if (normalized.maxBacklogMessages === null) {
    normalized.maxBacklogMessages = config.maxBacklogMessages;
  }

  if (normalized.lockRoomAfterSecondJoin) {
    normalized.maxPeople = 2;
  }

  return normalized;
}

export function parseRoomSettingsFromUrl(
  url: URL | null,
  config: RoomSettingsConfig,
): {
  settings: RoomSettings | null;
  invalid: boolean;
} {
  const settings = createDefaultRoomSettings(config);

  const maxPeople = readOptionalInt(
    url,
    "maxPeople",
    1,
    config.maxClientsPerRoom,
  );
  if (maxPeople === INVALID) {
    return { settings: null, invalid: true };
  }
  if (maxPeople !== undefined) {
    settings.maxPeople = maxPeople;
  }

  const allowBacklog = readOptionalBoolean(url, "allowBacklog");
  if (allowBacklog === INVALID) {
    return { settings: null, invalid: true };
  }
  if (allowBacklog !== undefined) {
    settings.allowBacklog = allowBacklog;
  }

  const maxBacklogMessages = readOptionalInt(
    url,
    "maxBacklogMessages",
    1,
    config.maxBacklogMessages,
  );
  if (maxBacklogMessages === INVALID) {
    return { settings: null, invalid: true };
  }
  if (maxBacklogMessages !== undefined) {
    settings.maxBacklogMessages = maxBacklogMessages;
  }

  const lockRoomAfterSecondJoin = readOptionalBoolean(
    url,
    "lockRoomAfterSecondJoin",
  );
  if (lockRoomAfterSecondJoin === INVALID) {
    return { settings: null, invalid: true };
  }
  if (lockRoomAfterSecondJoin !== undefined) {
    settings.lockRoomAfterSecondJoin = lockRoomAfterSecondJoin;
  }

  const messageSelfDestructMs = readOptionalInt(
    url,
    "messageSelfDestructMs",
    1,
    config.maxMessageSelfDestructMs,
  );
  if (messageSelfDestructMs === INVALID) {
    return { settings: null, invalid: true };
  }
  if (messageSelfDestructMs !== undefined) {
    settings.messageSelfDestructMs = messageSelfDestructMs;
  }

  const roomSelfDestructMs = readOptionalInt(
    url,
    "roomSelfDestructMs",
    1,
    config.maxRoomSelfDestructMs,
  );
  if (roomSelfDestructMs === INVALID) {
    return { settings: null, invalid: true };
  }
  if (roomSelfDestructMs !== undefined) {
    settings.roomSelfDestructMs = roomSelfDestructMs;
  }

  return {
    settings: normalizeRoomSettings(settings, config),
    invalid: false,
  };
}

export function parseRoomSettingsFromPayload(
  value: unknown,
  config: RoomSettingsConfig,
): {
  settings: RoomSettings | null;
  invalid: boolean;
} {
  if (value == null) {
    return { settings: null, invalid: false };
  }

  if (typeof value !== "object") {
    return { settings: null, invalid: true };
  }

  const candidate = value as Record<string, unknown>;
  const settings = createDefaultRoomSettings(config);

  const maxPeople = readOptionalPayloadInt(
    candidate.maxPeople,
    1,
    config.maxClientsPerRoom,
  );
  if (maxPeople === INVALID) {
    return { settings: null, invalid: true };
  }
  if (maxPeople !== undefined) {
    settings.maxPeople = maxPeople;
  }

  const allowBacklog = readOptionalPayloadBoolean(candidate.allowBacklog);
  if (allowBacklog === INVALID) {
    return { settings: null, invalid: true };
  }
  if (allowBacklog !== undefined) {
    settings.allowBacklog = allowBacklog;
  }

  const maxBacklogMessages = readOptionalPayloadInt(
    candidate.maxBacklogMessages,
    1,
    config.maxBacklogMessages,
  );
  if (maxBacklogMessages === INVALID) {
    return { settings: null, invalid: true };
  }
  if (maxBacklogMessages !== undefined) {
    settings.maxBacklogMessages = maxBacklogMessages;
  }

  const lockRoomAfterSecondJoin = readOptionalPayloadBoolean(
    candidate.lockRoomAfterSecondJoin,
  );
  if (lockRoomAfterSecondJoin === INVALID) {
    return { settings: null, invalid: true };
  }
  if (lockRoomAfterSecondJoin !== undefined) {
    settings.lockRoomAfterSecondJoin = lockRoomAfterSecondJoin;
  }

  const messageSelfDestructMs = readOptionalPayloadInt(
    candidate.messageSelfDestructMs,
    1,
    config.maxMessageSelfDestructMs,
  );
  if (messageSelfDestructMs === INVALID) {
    return { settings: null, invalid: true };
  }
  if (messageSelfDestructMs !== undefined) {
    settings.messageSelfDestructMs = messageSelfDestructMs;
  }

  const roomSelfDestructMs = readOptionalPayloadInt(
    candidate.roomSelfDestructMs,
    1,
    config.maxRoomSelfDestructMs,
  );
  if (roomSelfDestructMs === INVALID) {
    return { settings: null, invalid: true };
  }
  if (roomSelfDestructMs !== undefined) {
    settings.roomSelfDestructMs = roomSelfDestructMs;
  }

  return {
    settings: normalizeRoomSettings(settings, config),
    invalid: false,
  };
}

function readOptionalInt(
  url: URL | null,
  name: string,
  min: number,
  max: number,
) {
  const raw = url?.searchParams.get(name)?.trim() ?? "";
  if (!raw) {
    return undefined;
  }

  if (!/^\d+$/.test(raw)) {
    return INVALID;
  }

  const parsed = Number.parseInt(raw, 10);
  if (parsed < min || parsed > max) {
    return INVALID;
  }

  return parsed;
}

function readOptionalBoolean(url: URL | null, name: string) {
  const raw = url?.searchParams.get(name)?.trim() ?? "";
  if (!raw) {
    return undefined;
  }

  if (raw !== "true" && raw !== "false") {
    return INVALID;
  }

  return raw === "true";
}

function readOptionalPayloadInt(
  value: unknown,
  min: number,
  max: number,
): number | typeof INVALID | undefined {
  if (value == null) {
    return undefined;
  }

  if (!Number.isInteger(value)) {
    return INVALID;
  }

  const parsed = value as number;
  if (parsed < min || parsed > max) {
    return INVALID;
  }

  return parsed;
}

function readOptionalPayloadBoolean(value: unknown): boolean | typeof INVALID | undefined {
  if (value == null) {
    return undefined;
  }

  if (typeof value !== "boolean") {
    return INVALID;
  }

  return value;
}
