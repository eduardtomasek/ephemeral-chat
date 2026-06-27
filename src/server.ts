import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";
import { WebSocketServer, type WebSocket } from "ws";

import {
  createConfigSummary,
  loadRuntimeConfig,
  type AppConfig,
} from "./config.js";
import {
  createRoomRuntime,
  isValidClientEnvelope,
  type SocketState,
} from "./room-runtime.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = resolveProjectRoot(__dirname);

type Logger = Pick<typeof console, "error" | "info" | "warn">;

type RunningServer = {
  httpServer: http.Server;
  listen(port: number, host?: string): Promise<void>;
  close(): Promise<void>;
  address(): ReturnType<http.Server["address"]>;
};

type CreateAppServerOptions = {
  config?: AppConfig;
  heartbeatIntervalMs?: number;
  logger?: Logger;
};

export function runHeartbeat(
  clients: Iterable<WebSocket>,
  socketState: WeakMap<WebSocket, SocketState>,
) {
  for (const client of clients) {
    const state = socketState.get(client);
    if (!state || client.readyState !== client.OPEN) {
      continue;
    }

    if (!state.isAlive) {
      client.terminate();
      continue;
    }

    state.isAlive = false;
    client.ping();
  }
}

export function createAppServer({
  config = loadRuntimeConfig(),
  heartbeatIntervalMs = 25000,
  logger = console,
}: CreateAppServerOptions = {}): RunningServer {
  const app = express();
  const rawSockets = new Set<net.Socket>();
  const socketState = new WeakMap<WebSocket, SocketState>();
  const upgradeAttemptsByIp = new Map<string, number[]>();
  const proxyWarnings = new Map<string, { lastLoggedAt: number; suppressed: number }>();
  const websocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: config.maxMessageSizeBytes,
  });
  let openPreJoinSockets = 0;
  const roomRuntime = createRoomRuntime({
    config,
    releasePreJoinSlot,
    websocketServer,
    socketState,
    sendJson,
  });
  const heartbeatTimer = setInterval(() => {
    runHeartbeat(websocketServer.clients, socketState);
  }, heartbeatIntervalMs);

  heartbeatTimer.unref();

  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxy);
  app.set("view engine", "ejs");
  app.set("views", path.join(rootDir, "views"));

  app.use((_, res, next) => {
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    );
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=()",
    );
    next();
  });

  app.use("/assets", express.static(path.join(rootDir, "public")));

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/", (_req, res) => {
    res.render("index", {
      appTitle: config.appTitle,
      maxBacklogMessages: config.maxBacklogMessages,
      maxClientsPerRoom: config.maxClientsPerRoom,
      maxMessageSelfDestructMs: config.maxMessageSelfDestructMs,
      maxRoomSelfDestructMs: config.maxRoomSelfDestructMs,
      statusLabel: "Offline",
    });
  });

  const httpServer = http.createServer(app);

  httpServer.on("connection", (socket) => {
    rawSockets.add(socket);
    socket.on("close", () => {
      rawSockets.delete(socket);
    });
  });

  httpServer.on("upgrade", (request, socket, head) => {
    const admission = validateUpgradeRequest(request);
    if (!admission.accepted) {
      logger.warn(`ws_reject ${admission.logCode}`);
      socket.write(
        `HTTP/1.1 ${admission.status} ${admission.reason}\r\nConnection: close\r\n\r\n`,
      );
      socket.destroy();
      return;
    }

    if (openPreJoinSockets >= config.maxOpenPrejoinSockets) {
      logger.warn("ws_reject prejoin_capacity_reached");
      socket.write(
        "HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n",
      );
      socket.destroy();
      return;
    }

    const clientIp = resolveClientIp(request);
    if (!enforceUpgradeRateLimit(clientIp)) {
      logger.warn("ws_reject upgrade_rate_limited");
      socket.write(
        "HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n",
      );
      socket.destroy();
      return;
    }

    websocketServer.handleUpgrade(request, socket, head, (ws) => {
      const state = roomRuntime.createSocketState();
      trackPreJoinSocket(state);
      socketState.set(ws, state);
      websocketServer.emit("connection", ws, request);
    });
  });

  websocketServer.on("connection", (ws) => {
    ws.on("pong", () => {
      const state = socketState.get(ws);
      if (state) {
        state.isAlive = true;
      }
    });

    ws.on("message", (rawData, isBinary) => {
      const state = socketState.get(ws);
      if (!state || isBinary) {
        ws.close(1003, "Binary frames are not supported.");
        return;
      }

      let payload: unknown;
      try {
        payload = JSON.parse(rawData.toString());
      } catch {
        ws.close(1003, "Invalid JSON.");
        return;
      }

      if (!isValidClientEnvelope(payload)) {
        ws.close(1008, "Invalid transport envelope.");
        return;
      }

      if (payload.type !== "join" && !enforceRateLimit(state)) {
        ws.close(1008, "Rate limit exceeded.");
        return;
      }

      const rejectCode = roomRuntime.handleEnvelope(ws, state, payload);
      if (rejectCode) {
        logger.warn(`ws_reject ${rejectCode}`);
      }
    });

    ws.on("close", () => {
      const state = socketState.get(ws);
      if (!state) {
        return;
      }

      releasePreJoinSlot(state);
      roomRuntime.handleDisconnect(state);
    });
  });

  function enforceRateLimit(state: SocketState) {
    const now = Date.now();
    const windowStart = now - config.rateLimitWindowMs;
    state.rateWindow = state.rateWindow.filter(
      (timestamp) => timestamp > windowStart,
    );
    state.rateWindow.push(now);
    return state.rateWindow.length <= config.rateLimitMaxMessages;
  }

  function trackPreJoinSocket(state: SocketState) {
    state.preJoinTracked = true;
    openPreJoinSockets += 1;
    state.joinDeadlineTimer = setTimeout(() => {
      logger.warn("ws_reject join_timeout");
      releasePreJoinSlot(state);

      for (const client of websocketServer.clients) {
        if (socketState.get(client) === state) {
          client.close(1008, "Join timeout.");
          break;
        }
      }
    }, config.joinDeadlineMs);
    state.joinDeadlineTimer.unref?.();
  }

  function releasePreJoinSlot(state: SocketState) {
    if (state.joinDeadlineTimer !== undefined) {
      clearTimeout(state.joinDeadlineTimer);
      state.joinDeadlineTimer = undefined;
    }

    if (!state.preJoinTracked) {
      return;
    }

    state.preJoinTracked = false;
    openPreJoinSockets = Math.max(0, openPreJoinSockets - 1);
  }

  function resolveClientIp(request: http.IncomingMessage) {
    const remoteAddress = request.socket.remoteAddress ?? "unknown";
    if (!config.trustProxy) {
      return remoteAddress;
    }

    if (!isTrustedProxyPeer(remoteAddress)) {
      logProxyWarning("proxy_peer_untrusted");
      return remoteAddress;
    }

    const forwarded = request.headers["x-forwarded-for"];
    if (typeof forwarded !== "string" || forwarded.trim() === "") {
      logProxyWarning("proxy_ip_missing");
      return remoteAddress;
    }

    const candidate = forwarded
      .split(",")
      .map((value) => value.trim())
      .find((value) => value.length > 0);
    if (!candidate || net.isIP(candidate) === 0) {
      logProxyWarning("proxy_ip_invalid");
      return remoteAddress;
    }

    return candidate;
  }

  function enforceUpgradeRateLimit(clientIp: string) {
    const now = Date.now();
    const windowStart = now - config.upgradeRateLimitWindowMs;
    const recentAttempts = (upgradeAttemptsByIp.get(clientIp) ?? []).filter(
      (timestamp) => timestamp > windowStart,
    );
    recentAttempts.push(now);
    if (recentAttempts.length === 0) {
      upgradeAttemptsByIp.delete(clientIp);
    } else {
      upgradeAttemptsByIp.set(clientIp, recentAttempts);
    }

    return recentAttempts.length <= config.maxUpgradesPerIpPerWindow;
  }

  function logProxyWarning(code: string) {
    const now = Date.now();
    const existing = proxyWarnings.get(code);
    if (!existing || now - existing.lastLoggedAt >= 60_000) {
      const repeated = existing?.suppressed ?? 0;
      logger.warn(
        repeated > 0
          ? `${code} degraded=true repeated=${repeated}`
          : `${code} degraded=true`,
      );
      proxyWarnings.set(code, { lastLoggedAt: now, suppressed: 0 });
      return;
    }

    existing.suppressed += 1;
  }

  return {
    httpServer,
    async listen(port, host = "127.0.0.1") {
      await new Promise<void>((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(port, host, () => {
          httpServer.off("error", reject);
          logger.info(`startup ${JSON.stringify(createConfigSummary(config))}`);
          resolve();
        });
      });
    },
    async close() {
      clearInterval(heartbeatTimer);

      for (const client of websocketServer.clients) {
        client.close();
      }

      websocketServer.close();

      for (const socket of rawSockets) {
        socket.destroy();
      }

      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    },
    address() {
      return httpServer.address();
    },
  };
}

function validateUpgradeRequest(
  request: http.IncomingMessage,
) {
  const host = request.headers.host;
  const origin = request.headers.origin;
  const url = request.url
    ? new URL(request.url, `http://${host ?? "localhost"}`)
    : null;

  if (request.method !== "GET" || !url || url.pathname !== "/ws") {
    return {
      accepted: false,
      status: 404,
      reason: "Not Found",
      logCode: "invalid_path",
    };
  }

  if (!host || !origin || !sameOrigin(origin, host)) {
    return {
      accepted: false,
      status: 403,
      reason: "Forbidden",
      logCode: "forbidden_origin",
    };
  }

  return {
    accepted: true,
    status: 101,
    reason: "Switching Protocols",
    logCode: "accepted",
  };
}

function sameOrigin(origin: string, host: string) {
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function isTrustedProxyPeer(address: string) {
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1"
  );
}

function sendJson(ws: WebSocket, payload: unknown) {
  ws.send(JSON.stringify(payload));
}

function resolveProjectRoot(currentDir: string) {
  const candidates = [
    path.resolve(currentDir, ".."),
    path.resolve(currentDir, "..", ".."),
  ];

  for (const candidate of candidates) {
    if (
      fs.existsSync(path.join(candidate, "views", "index.ejs")) &&
      fs.existsSync(path.join(candidate, "public", "app.js"))
    ) {
      return candidate;
    }
  }

  return candidates[0];
}
