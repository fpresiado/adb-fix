// Bridge broker: Bun.serve WebSocket :4700 + HTTP :4701 on 127.0.0.1.
// Routes BridgeMessages, enforces floor control, tracks presence, persists via store.

import { createStore, type Store, type StoredMessage } from "./store.ts";
import {
  BridgeMessageSchema,
  encodeMessage,
  FLOOR_TIMEOUT_MS,
  HEARTBEAT_MS,
  isPersistedType,
  OFFLINE_AFTER_MISSED,
  parseMessage,
  PORT_HTTP,
  PORT_WS,
  type BridgeMessage,
  type MessageType,
} from "./protocol.ts";
import pino from "pino";
import { mkdirSync } from "node:fs";
import { resolve as pathResolve, join as pathJoin } from "node:path";
import type { Server, ServerWebSocket } from "bun";

// Static dashboard root — served at GET /dashboard[/*]. Resolved once at module
// load so a Windows service starting from any CWD still finds the files.
const DASHBOARD_DIR = pathResolve(import.meta.dir, "../dashboard");
const DASHBOARD_MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json",
};

const VERSION = "0.1.0";
const ISKO_ID = "isko";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BrokerConnState {
  agentId: string | null;
  registered: boolean;
  lastHeartbeat: number;
  missedHeartbeats: number;
  currentlyHoldsFloor: boolean;
  // any: bun-types ws data field is loosely typed and we attach our own slot.
  // (No structural reason for `any` — this is a known Bun.serve pattern.)
}

export interface BrokerOptions {
  wsPort?: number;
  httpPort?: number;
  store?: Store;
  iskoToken?: string;
  // Override timers for testing (presence sweep cadence).
  presenceTickMs?: number;
  floorTimeoutMs?: number;
  logFile?: string | null;
}

export interface Broker {
  wsServer: Server;
  httpServer: Server;
  store: Store;
  stop(): Promise<void>;
  /** Number of active websocket connections (registered or not). */
  connectionCount(): number;
}

// ---------------------------------------------------------------------------
// Floor controller (Blueprint 1 §3.3)
// ---------------------------------------------------------------------------

interface FloorState {
  holder: string | null;
  acquiredAt: number;
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

function makeLogger(logFile: string | null): pino.Logger {
  if (logFile === null) {
    return pino({ level: "silent" });
  }
  mkdirSync("./logs", { recursive: true });
  return pino(
    { level: process.env.BRIDGE_LOG_LEVEL ?? "info" },
    pino.destination({ dest: logFile, sync: false }),
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowMs(): number {
  return Date.now();
}

function toStored(msg: BridgeMessage): StoredMessage {
  return {
    id: msg.id,
    ts: msg.ts,
    from_id: msg.from,
    to_id: msg.to,
    type: msg.type as StoredMessage["type"],
    thread_id: msg.thread_id,
    reply_to: msg.reply_to,
    priority: msg.priority,
    body: msg.body,
    needs_ack: msg.needs_ack,
  };
}

function fromStored(row: StoredMessage): BridgeMessage {
  return {
    id: row.id,
    ts: row.ts,
    from: row.from_id,
    to: row.to_id,
    type: row.type as MessageType,
    thread_id: row.thread_id,
    reply_to: row.reply_to,
    priority: row.priority,
    body: row.body,
    needs_ack: row.needs_ack,
  };
}

function buildError(
  to: string,
  body: string,
  threadId: string,
  replyTo: string | null = null,
): BridgeMessage {
  return {
    id: crypto.randomUUID(),
    ts: nowMs(),
    from: "bridge",
    to,
    type: "error",
    thread_id: threadId,
    reply_to: replyTo,
    priority: false,
    body,
    needs_ack: false,
  };
}

// Deterministic markdown reduction of last N messages (v0.1.0).
// TODO(v0.2.0): replace with on-device Gemma 4 E4B narrative summary.
function reduceToMarkdown(messages: BridgeMessage[]): string {
  if (messages.length === 0) return "# Bridge summary\n\n_(no messages yet)_\n";
  const lines: string[] = ["# Bridge summary", ""];
  for (const m of messages) {
    const date = new Date(m.ts).toISOString();
    const tag =
      m.type === "question"
        ? "Q"
        : m.type === "answer"
          ? "A"
          : m.type === "status"
            ? "STATUS"
            : m.type === "error"
              ? "ERROR"
              : m.type === "chat"
                ? "CHAT"
                : m.type.toUpperCase();
    lines.push(`- \`${date}\` **${m.from} -> ${m.to}** [${tag}] ${m.body}`);
  }
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Broker factory
// ---------------------------------------------------------------------------

export function createBroker(opts: BrokerOptions = {}): Broker {
  const wsPort = opts.wsPort ?? PORT_WS;
  const httpPort = opts.httpPort ?? PORT_HTTP;
  const store = opts.store ?? createStore();
  const iskoToken = opts.iskoToken ?? process.env.BRIDGE_ISKO_TOKEN ?? null;
  const presenceTickMs = opts.presenceTickMs ?? HEARTBEAT_MS;
  const floorTimeoutMs = opts.floorTimeoutMs ?? FLOOR_TIMEOUT_MS;
  const logFile =
    opts.logFile === undefined ? "./logs/bridge.log" : opts.logFile;
  const log = makeLogger(logFile);

  const startedAt = nowMs();
  const floor: FloorState = { holder: null, acquiredAt: 0 };

  // agentId -> active socket. Last-write-wins on reconnect.
  // any: ServerWebSocket generic uses our BrokerConnState carried via ws.data.
  type WS = ServerWebSocket<BrokerConnState>;
  const connections = new Map<string, WS>();
  const allSockets = new Set<WS>();

  function broadcastEnvelope(env: BridgeMessage, excludeAgentId?: string): void {
    const wire = encodeMessage(env);
    for (const [aid, sock] of connections) {
      if (aid === excludeAgentId) continue;
      try {
        sock.send(wire);
      } catch (err) {
        log.warn({ err, aid }, "broadcast send failed");
      }
    }
  }

  function sendTo(agentId: string, env: BridgeMessage): boolean {
    const sock = connections.get(agentId);
    if (!sock) return false;
    try {
      sock.send(encodeMessage(env));
      return true;
    } catch (err) {
      log.warn({ err, agentId }, "direct send failed");
      return false;
    }
  }

  function persistIfNeeded(env: BridgeMessage): void {
    if (!isPersistedType(env.type)) return;
    store.appendMessage(toStored(env));
  }

  function releaseFloor(): void {
    if (floor.holder === null) return;
    const prev = floor.holder;
    floor.holder = null;
    floor.acquiredAt = 0;
    const sock = connections.get(prev);
    if (sock && sock.data) sock.data.currentlyHoldsFloor = false;
  }

  function grantFloor(agentId: string, ws: WS): void {
    floor.holder = agentId;
    floor.acquiredAt = nowMs();
    ws.data.currentlyHoldsFloor = true;
    const grant: BridgeMessage = {
      id: crypto.randomUUID(),
      ts: nowMs(),
      from: "bridge",
      to: agentId,
      type: "floor_grant",
      thread_id: "system",
      reply_to: null,
      priority: false,
      body: "",
      needs_ack: false,
    };
    ws.send(encodeMessage(grant));
  }

  function denyFloor(agentId: string, ws: WS, holder: string): void {
    const deny: BridgeMessage = {
      id: crypto.randomUUID(),
      ts: nowMs(),
      from: "bridge",
      to: agentId,
      type: "floor_deny",
      thread_id: "system",
      reply_to: null,
      priority: false,
      body: holder,
      needs_ack: false,
    };
    ws.send(encodeMessage(deny));
  }

  // -------------------------------------------------------------------------
  // Message handler
  // -------------------------------------------------------------------------

  function handleMessage(ws: WS, raw: string | Buffer): void {
    let env: BridgeMessage;
    try {
      env = parseMessage(raw);
    } catch (err) {
      log.warn({ err }, "invalid message");
      const fallbackId = ws.data.agentId ?? "unknown";
      try {
        ws.send(
          encodeMessage(
            buildError(fallbackId, "invalid_message_envelope", "system"),
          ),
        );
      } catch {
        /* socket may be dead */
      }
      return;
    }

    const state = ws.data;

    // First-message-must-be-register gate.
    if (!state.registered) {
      if (env.type !== "register") {
        ws.send(
          encodeMessage(buildError(env.from, "must_register_first", "system")),
        );
        return;
      }
      registerAgent(ws, env);
      return;
    }

    // After registration: from must match.
    if (env.from !== state.agentId) {
      ws.send(
        encodeMessage(
          buildError(state.agentId!, "from_mismatch_after_register", "system"),
        ),
      );
      return;
    }

    // Reject priority abuse — only isko may send priority=true.
    if (env.priority && env.from !== ISKO_ID) {
      ws.send(
        encodeMessage(
          buildError(env.from, "priority_reserved_for_isko", "system"),
        ),
      );
      return;
    }

    state.lastHeartbeat = nowMs();
    state.missedHeartbeats = 0;

    routeByType(ws, env);
  }

  function registerAgent(ws: WS, env: BridgeMessage): void {
    const agentId = env.from;
    if (!/^[A-Za-z0-9_]+$/.test(agentId)) {
      ws.send(encodeMessage(buildError(agentId, "invalid_agent_id", "system")));
      return;
    }

    // Replace any prior socket bound to the same agent (reconnect path).
    const prior = connections.get(agentId);
    if (prior && prior !== ws) {
      try {
        prior.close(1000, "replaced_by_reconnect");
      } catch {
        /* prior may already be closed */
      }
    }
    connections.set(agentId, ws);
    ws.data.agentId = agentId;
    ws.data.registered = true;
    ws.data.lastHeartbeat = nowMs();
    ws.data.missedHeartbeats = 0;

    store.upsertAgent({
      id: agentId,
      project_dir: env.body || agentId,
      pid: null,
      registered_ts: nowMs(),
      last_heartbeat_ts: nowMs(),
      state: "online",
    });
    persistIfNeeded(env);
    log.info({ agentId }, "agent registered");
  }

  function routeByType(ws: WS, env: BridgeMessage): void {
    const t = env.type;

    switch (t) {
      case "heartbeat": {
        store.setAgentState(env.from, "online");
        return;
      }

      case "register": {
        // Already registered — treat as no-op refresh.
        store.setAgentState(env.from, "online");
        return;
      }

      case "deregister": {
        persistIfNeeded(env);
        store.setAgentState(env.from, "offline");
        if (floor.holder === env.from) releaseFloor();
        return;
      }

      case "floor_request": {
        if (floor.holder === null || floor.holder === env.from) {
          grantFloor(env.from, ws);
        } else {
          denyFloor(env.from, ws, floor.holder);
        }
        return;
      }

      case "chat": {
        // Isko priority bypasses floor entirely.
        if (env.priority && env.from === ISKO_ID) {
          persistIfNeeded(env);
          deliver(env, ws);
          // Isko priority frees the floor (Blueprint 1 §3.3).
          releaseFloor();
          return;
        }
        // Non-priority chat requires floor.
        if (floor.holder !== env.from) {
          ws.send(
            encodeMessage(
              buildError(env.from, "chat_without_floor", env.thread_id),
            ),
          );
          return;
        }
        persistIfNeeded(env);
        deliver(env, ws);
        // Receiving the chat releases the floor (one chat per grant).
        releaseFloor();
        return;
      }

      case "question":
      case "answer":
      case "status":
      case "error":
      case "typing":
      case "ping":
      case "pong":
      case "ack":
      case "summary":
      case "summary_request":
      case "floor_grant":
      case "floor_deny": {
        // question/answer/status/error/typing bypass floor entirely.
        persistIfNeeded(env);
        deliver(env, ws);
        return;
      }
    }
  }

  function deliver(env: BridgeMessage, sender: WS): void {
    if (env.to === "all") {
      broadcastEnvelope(env, env.from);
    } else {
      const ok = sendTo(env.to, env);
      if (!ok) {
        // Target offline — log; persistence (if any) is already done.
        log.info({ to: env.to, from: env.from }, "target offline at delivery");
      }
      // Also echo to sender so they see their own send in history (skipped for ping/pong/ack noise).
      void sender;
    }
  }

  // -------------------------------------------------------------------------
  // Presence sweep
  // -------------------------------------------------------------------------

  const presenceTimer = setInterval(() => {
    const now = nowMs();
    // Floor auto-release on timeout.
    if (floor.holder !== null && now - floor.acquiredAt > floorTimeoutMs) {
      log.info({ holder: floor.holder }, "floor auto-release on timeout");
      releaseFloor();
    }
    for (const [aid, sock] of [...connections.entries()]) {
      const data = sock.data;
      if (!data.registered) continue;
      const sinceHb = now - data.lastHeartbeat;
      if (sinceHb > presenceTickMs) {
        data.missedHeartbeats += 1;
      }
      if (data.missedHeartbeats === OFFLINE_AFTER_MISSED) {
        store.setAgentState(aid, "offline");
        const dereg: BridgeMessage = {
          id: crypto.randomUUID(),
          ts: now,
          from: aid,
          to: "all",
          type: "deregister",
          thread_id: "system",
          reply_to: null,
          priority: false,
          body: "presence_timeout",
          needs_ack: false,
        };
        // Broadcast offline transition; do NOT close socket — they may reconnect.
        broadcastEnvelope(dereg, aid);
        log.info({ aid }, "agent marked offline");
      }
      if (data.missedHeartbeats >= OFFLINE_AFTER_MISSED * 2) {
        log.info({ aid }, "dropping dead socket");
        try {
          sock.close(1001, "presence_dead");
        } catch {
          /* already closed */
        }
        connections.delete(aid);
      }
    }
  }, presenceTickMs);

  // -------------------------------------------------------------------------
  // WebSocket server
  // -------------------------------------------------------------------------

  const wsServer = Bun.serve<BrokerConnState>({
    port: wsPort,
    hostname: "127.0.0.1",
    fetch(req, server) {
      const initState: BrokerConnState = {
        agentId: null,
        registered: false,
        lastHeartbeat: nowMs(),
        missedHeartbeats: 0,
        currentlyHoldsFloor: false,
      };
      if (server.upgrade(req, { data: initState })) return undefined;
      return new Response("expected websocket upgrade", { status: 426 });
    },
    websocket: {
      idleTimeout: 60,
      open(ws) {
        allSockets.add(ws);
      },
      message(ws, data) {
        handleMessage(ws, data as string | Buffer);
      },
      close(ws) {
        allSockets.delete(ws);
        const aid = ws.data.agentId;
        if (aid !== null) {
          if (connections.get(aid) === ws) connections.delete(aid);
          if (floor.holder === aid) releaseFloor();
          store.setAgentState(aid, "offline");
          log.info({ aid }, "socket closed");
        }
      },
    },
  });

  // -------------------------------------------------------------------------
  // HTTP server
  // -------------------------------------------------------------------------

  const httpServer = Bun.serve({
    port: httpPort,
    hostname: "127.0.0.1",
    fetch(req): Response | Promise<Response> {
      const url = new URL(req.url);
      const path = url.pathname;

      if (req.method === "GET" && path === "/health") {
        return Response.json({
          status: "ok",
          uptime: Math.floor((nowMs() - startedAt) / 1000),
          connectedAgents: connections.size,
          version: VERSION,
        });
      }

      if (req.method === "GET" && path === "/api/agents") {
        const agents = store.getAgents().map((a) => ({
          id: a.id,
          project_dir: a.project_dir,
          state: a.state,
          last_heartbeat_ts: a.last_heartbeat_ts,
        }));
        return Response.json(agents);
      }

      if (req.method === "GET" && path === "/api/summary") {
        const nRaw = url.searchParams.get("n");
        const n = Math.max(1, Math.min(500, Number(nRaw) || 50));
        // Pull most recent N persisted messages.
        const rows = store
          .getMessagesSince(0, 100000)
          .slice(-n)
          .map(fromStored);
        const markdown = reduceToMarkdown(rows);
        return Response.json({ markdown });
      }

      if (req.method === "GET" && path === "/api/messages") {
        const since = Number(url.searchParams.get("since") ?? "0") || 0;
        const limitRaw = Number(url.searchParams.get("limit") ?? "20") || 20;
        const limit = Math.max(1, Math.min(1000, limitRaw));
        const rows = store.getMessagesSince(since, limit).map(fromStored);
        return Response.json(rows);
      }

      if (req.method === "POST" && path === "/api/inject") {
        if (!iskoToken) {
          return new Response("inject_disabled_no_token_configured", {
            status: 503,
          });
        }
        const auth = req.headers.get("authorization") ?? "";
        const expected = `Bearer ${iskoToken}`;
        if (auth !== expected) {
          return new Response("unauthorized", { status: 401 });
        }
        return req.json().then((body: unknown): Response => {
          // any: external POST payload — validated below by Zod.
          const parsed = BridgeMessageSchema.partial({
            id: true,
            ts: true,
            from: true,
            priority: true,
            reply_to: true,
            needs_ack: true,
            thread_id: true,
          }).safeParse(body);
          if (!parsed.success) {
            return new Response("bad_request", { status: 400 });
          }
          const p = parsed.data;
          const env: BridgeMessage = {
            id: p.id ?? crypto.randomUUID(),
            ts: p.ts ?? nowMs(),
            from: ISKO_ID,
            to: p.to ?? "all",
            type: p.type ?? "chat",
            thread_id: p.thread_id ?? "isko-inject",
            reply_to: p.reply_to ?? null,
            priority: true,
            body: p.body ?? "",
            needs_ack: p.needs_ack ?? false,
          };
          persistIfNeeded(env);
          if (env.to === "all") {
            broadcastEnvelope(env);
          } else {
            sendTo(env.to, env);
          }
          // Inject also resets floor — Isko has supervisor priority.
          releaseFloor();
          return Response.json({ ok: true, id: env.id });
        });
      }

      // -------------------- Dashboard static files --------------------
      // GET /dashboard            -> index.html
      // GET /dashboard/<file>     -> ./src/dashboard/<file>
      if (req.method === "GET" && path.startsWith("/dashboard")) {
        const rel =
          path === "/dashboard" || path === "/dashboard/"
            ? "index.html"
            : path.slice("/dashboard/".length);
        // Reject traversal: any "..", absolute paths, or backslashes.
        if (
          rel.includes("..") ||
          rel.startsWith("/") ||
          rel.includes("\\") ||
          rel.includes("\0")
        ) {
          return new Response("bad request", { status: 400 });
        }
        const filePath = pathJoin(DASHBOARD_DIR, rel);
        const file = Bun.file(filePath);
        return file.exists().then((exists): Response => {
          if (!exists) return new Response("not found", { status: 404 });
          const ext = (rel.match(/\.[^.]+$/) || [""])[0].toLowerCase();
          const mime = DASHBOARD_MIME[ext] ?? "application/octet-stream";
          return new Response(file, { headers: { "Content-Type": mime } });
        });
      }

      // -------------------- Force-release floor (Isko only) --------------------
      if (req.method === "DELETE" && path === "/api/floor") {
        if (!iskoToken) {
          return new Response("inject_disabled_no_token_configured", {
            status: 503,
          });
        }
        const auth = req.headers.get("authorization") ?? "";
        if (auth !== `Bearer ${iskoToken}`) {
          return new Response("unauthorized", { status: 401 });
        }
        const prev = floor.holder;
        releaseFloor();
        log.info({ prev }, "floor force-released via /api/floor");
        return Response.json({ ok: true, previousHolder: prev });
      }

      return new Response("not found", { status: 404 });
    },
  });

  log.info({ wsPort, httpPort }, "bridge broker started");

  return {
    wsServer,
    httpServer,
    store,
    connectionCount: () => connections.size,
    async stop(): Promise<void> {
      clearInterval(presenceTimer);
      for (const sock of allSockets) {
        try {
          sock.close(1001, "broker_shutdown");
        } catch {
          /* ignore */
        }
      }
      wsServer.stop(true);
      httpServer.stop(true);
      // Only close store if we created it.
      if (!opts.store) store.close();
    },
  };
}

// ---------------------------------------------------------------------------
// CLI entry — `bun run src/server/broker.ts`
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const broker = createBroker();
  const shutdown = async (): Promise<void> => {
    await broker.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
