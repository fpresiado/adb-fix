// Bridge MCP server: stdio JSON-RPC bridge between Claude Code/Desktop and the broker.
// Exposes 5 tools: bridge_send, bridge_read, bridge_history, bridge_agents, bridge_summary.
//
// CRITICAL: stdout is reserved for stdio JSON-RPC framing. NEVER use console.log
// in this file. All debug/info/warn/error output MUST go to console.error so that
// the MCP transport remains uncorrupted. See Blueprint 2 §2 "stdio MCP rules".
//
// Turn-boundary semantics (Blueprint 2 §1 "What Works & What Does Not"): inbound
// messages are queued locally and drained when the agent calls bridge_read during
// its turn — there is no way to interrupt a turn in-flight from outside.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import WebSocket from "ws";

// ---------------------------------------------------------------------------
// Configuration — agent identity & broker URL come from environment
// ---------------------------------------------------------------------------

const agentId = process.env.BRIDGE_AGENT_ID;
if (!agentId || agentId.trim().length === 0) {
  // Fail fast — there is no sensible default for agent identity.
  console.error(
    "[bridge-mcp] FATAL: BRIDGE_AGENT_ID env var is required (set in .mcp.json env block)",
  );
  process.exit(1);
}

const brokerWsUrl = process.env.BRIDGE_URL ?? "ws://127.0.0.1:4700";
// Derive HTTP base URL from WS URL by swapping scheme + port.
// Convention: WS on 4700, HTTP on 4701. If BRIDGE_HTTP_URL is set explicitly, prefer it.
const brokerHttpUrl =
  process.env.BRIDGE_HTTP_URL ?? deriveHttpUrl(brokerWsUrl);

function deriveHttpUrl(wsUrl: string): string {
  try {
    const u = new URL(wsUrl);
    const host = u.hostname;
    // Default mapping: 4700 -> 4701. Otherwise increment by 1.
    const wsPort = Number(u.port) || 4700;
    const httpPort = wsPort === 4700 ? 4701 : wsPort + 1;
    return `http://${host}:${httpPort}`;
  } catch {
    return "http://127.0.0.1:4701";
  }
}

const HEARTBEAT_MS = 10000;
const RECONNECT_BACKOFF_MS = 3000;
const DEFAULT_READ_LIMIT = 20;

// ---------------------------------------------------------------------------
// Types — minimal envelope shape mirroring src/server/protocol.ts. Kept local
// so this file can be packaged with the MCP server without dragging the broker.
// ---------------------------------------------------------------------------

interface BridgeMessage {
  id: string;
  ts: number;
  from: string;
  to: string;
  type: string;
  thread_id: string;
  reply_to: string | null;
  priority: boolean;
  body: string;
  needs_ack: boolean;
}

// Transport-level frames the agent should NEVER see — they're plumbing, not content.
const TRANSPORT_TYPES: ReadonlySet<string> = new Set([
  "ping",
  "pong",
  "typing",
  "heartbeat",
  "floor_grant",
  "floor_deny",
]);

// ---------------------------------------------------------------------------
// WebSocket lifecycle — connect, register, heartbeat, auto-reconnect
// ---------------------------------------------------------------------------

let ws: WebSocket | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let shuttingDown = false;

// In-memory inbound queue. Drained by bridge_read. Bounded to avoid runaway
// memory if the agent never calls bridge_read.
const MAX_QUEUE = 10000;
const messageQueue: BridgeMessage[] = [];

function enqueue(msg: BridgeMessage): void {
  if (messageQueue.length >= MAX_QUEUE) {
    // Drop oldest — keep tail (most recent) to preserve recency.
    messageQueue.shift();
  }
  messageQueue.push(msg);
}

function sendRegister(sock: WebSocket): void {
  const reg: BridgeMessage = {
    id: crypto.randomUUID(),
    ts: Date.now(),
    from: agentId as string,
    to: "bridge",
    type: "register",
    thread_id: "system",
    reply_to: null,
    priority: false,
    body: agentId as string,
    needs_ack: false,
  };
  try {
    sock.send(JSON.stringify(reg));
  } catch (err) {
    console.error("[bridge-mcp] register send failed:", err);
  }
}

function sendHeartbeat(sock: WebSocket): void {
  const hb: BridgeMessage = {
    id: crypto.randomUUID(),
    ts: Date.now(),
    from: agentId as string,
    to: "bridge",
    type: "heartbeat",
    thread_id: "system",
    reply_to: null,
    priority: false,
    body: "",
    needs_ack: false,
  };
  try {
    sock.send(JSON.stringify(hb));
  } catch (err) {
    console.error("[bridge-mcp] heartbeat send failed:", err);
  }
}

function scheduleReconnect(): void {
  if (shuttingDown) return;
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectBroker();
  }, RECONNECT_BACKOFF_MS);
}

function connectBroker(): void {
  if (shuttingDown) return;
  console.error(`[bridge-mcp] connecting to ${brokerWsUrl} as ${agentId}`);
  let sock: WebSocket;
  try {
    sock = new WebSocket(brokerWsUrl);
  } catch (err) {
    console.error("[bridge-mcp] connect threw:", err);
    scheduleReconnect();
    return;
  }
  ws = sock;

  sock.on("open", () => {
    console.error("[bridge-mcp] ws open — sending register");
    sendRegister(sock);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      if (sock.readyState === WebSocket.OPEN) sendHeartbeat(sock);
    }, HEARTBEAT_MS);
  });

  sock.on("message", (raw: WebSocket.RawData) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString("utf8"));
    } catch {
      console.error("[bridge-mcp] dropped non-JSON frame");
      return;
    }
    // Minimal shape check — the broker is authoritative on validation.
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as { type?: unknown }).type !== "string"
    ) {
      return;
    }
    const msg = parsed as BridgeMessage;
    if (TRANSPORT_TYPES.has(msg.type)) return;
    enqueue(msg);
  });

  sock.on("close", (code, reason) => {
    console.error(
      `[bridge-mcp] ws closed code=${code} reason=${reason?.toString() ?? ""}`,
    );
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    ws = null;
    scheduleReconnect();
  });

  sock.on("error", (err) => {
    console.error("[bridge-mcp] ws error:", err.message);
    // close handler will trigger reconnect; do nothing here.
  });
}

// ---------------------------------------------------------------------------
// Tool: bridge_send — push a message to the broker
// ---------------------------------------------------------------------------

function buildEnvelope(input: {
  to: string;
  type: string;
  body: string;
  reply_to?: string;
}): BridgeMessage {
  return {
    id: crypto.randomUUID(),
    ts: Date.now(),
    from: agentId as string,
    to: input.to,
    type: input.type,
    thread_id: input.reply_to ? input.reply_to : "default",
    reply_to: input.reply_to ?? null,
    priority: false,
    body: input.body,
    needs_ack: false,
  };
}

function trySend(env: BridgeMessage): { ok: true } | { ok: false; reason: string } {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return { ok: false, reason: "broker_not_connected" };
  }
  try {
    ws.send(JSON.stringify(env));
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `send_failed: ${(err as Error).message}` };
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers for bridge_history / bridge_agents / bridge_summary
// ---------------------------------------------------------------------------

async function fetchJson(path: string): Promise<unknown> {
  const url = `${brokerHttpUrl}${path}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`broker_http_${resp.status}: ${url}`);
  }
  return resp.json();
}

// ---------------------------------------------------------------------------
// MCP server setup
// ---------------------------------------------------------------------------

const server = new McpServer({ name: "bridge-mcp", version: "1.0.0" });

// bridge_send -----------------------------------------------------------------
server.tool(
  "bridge_send",
  "Send a message to another agent (or 'all') via the Bridge broker.",
  {
    to: z.string().min(1).describe("Target agent id, or 'all' for broadcast."),
    type: z
      .string()
      .min(1)
      .describe("Message type: chat, question, answer, status, error, summary, ack."),
    body: z.string().describe("Message content."),
    reply_to: z
      .string()
      .optional()
      .describe("Optional id of the message this one replies to."),
  },
  async ({ to, type, body, reply_to }) => {
    const env = buildEnvelope({ to, type, body, reply_to });
    const result = trySend(env);
    if (!result.ok) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok: false, error: result.reason }),
          },
        ],
      };
    }
    return {
      content: [
        { type: "text", text: JSON.stringify({ id: env.id, ts: env.ts }) },
      ],
    };
  },
);

// bridge_read -----------------------------------------------------------------
server.tool(
  "bridge_read",
  "Drain queued inbound messages (skips ping/pong/typing/heartbeat).",
  {
    since: z
      .number()
      .optional()
      .describe(
        "Optional timestamp (ms) — only return messages with ts >= since. If omitted, drains the queue head.",
      ),
    limit: z
      .number()
      .int()
      .positive()
      .max(500)
      .optional()
      .describe("Max messages to return. Default 20."),
  },
  async ({ since, limit }) => {
    const cap = limit ?? DEFAULT_READ_LIMIT;
    const out: BridgeMessage[] = [];
    // Walk from head; for `since`, skip messages older than `since` but do NOT
    // drop them — leave them in queue (they may matter to a later call without `since`).
    if (since === undefined) {
      while (out.length < cap && messageQueue.length > 0) {
        const m = messageQueue.shift();
        if (m) out.push(m);
      }
    } else {
      // Drain in-place: keep messages older than since, return matching ones up to cap.
      let i = 0;
      while (i < messageQueue.length && out.length < cap) {
        const m = messageQueue[i];
        if (m && m.ts >= since) {
          out.push(m);
          messageQueue.splice(i, 1);
        } else {
          i += 1;
        }
      }
    }
    return {
      content: [{ type: "text", text: JSON.stringify(out) }],
    };
  },
);

// bridge_history --------------------------------------------------------------
server.tool(
  "bridge_history",
  "Fetch recent messages from the broker's SQLite history.",
  {
    n: z
      .number()
      .int()
      .positive()
      .max(1000)
      .optional()
      .describe("How many recent messages to fetch. Default 20."),
    thread_id: z
      .string()
      .optional()
      .describe("Optional thread id filter (client-side)."),
  },
  async ({ n, thread_id }) => {
    const limit = n ?? 20;
    try {
      const rows = (await fetchJson(
        `/api/messages?since=0&limit=${limit}`,
      )) as BridgeMessage[];
      // The broker returns oldest-first since `since=0`. Trim to last `limit` rows
      // and optionally filter by thread.
      const tail = rows.slice(-limit);
      const filtered = thread_id
        ? tail.filter((r) => r.thread_id === thread_id)
        : tail;
      return {
        content: [{ type: "text", text: JSON.stringify(filtered) }],
      };
    } catch (err) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok: false, error: (err as Error).message }),
          },
        ],
      };
    }
  },
);

// bridge_agents ---------------------------------------------------------------
server.tool(
  "bridge_agents",
  "List all agents the broker has seen and their current state.",
  {},
  async () => {
    try {
      const agents = await fetchJson("/api/agents");
      return {
        content: [{ type: "text", text: JSON.stringify(agents) }],
      };
    } catch (err) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok: false, error: (err as Error).message }),
          },
        ],
      };
    }
  },
);

// bridge_summary --------------------------------------------------------------
server.tool(
  "bridge_summary",
  "Get a Markdown summary of the last N messages.",
  {
    n: z
      .number()
      .int()
      .positive()
      .max(500)
      .optional()
      .describe("How many recent messages to summarise. Default 50."),
  },
  async ({ n }) => {
    const count = n ?? 50;
    try {
      const body = (await fetchJson(`/api/summary?n=${count}`)) as {
        markdown: string;
      };
      return {
        content: [{ type: "text", text: body.markdown }],
      };
    } catch (err) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok: false, error: (err as Error).message }),
          },
        ],
      };
    }
  },
);

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

function shutdown(): void {
  shuttingDown = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (ws) {
    try {
      ws.close(1000, "mcp_shutdown");
    } catch {
      /* ignore */
    }
    ws = null;
  }
}

process.on("SIGINT", () => {
  shutdown();
  process.exit(0);
});
process.on("SIGTERM", () => {
  shutdown();
  process.exit(0);
});

// ---------------------------------------------------------------------------
// Boot: connect to broker, then attach stdio transport
// ---------------------------------------------------------------------------

// Exported for tests — allows driving the MCP server in-process without forking.
export const __testing = {
  enqueue,
  drainQueueRef: messageQueue,
  buildEnvelope,
  deriveHttpUrl,
};

if (import.meta.main) {
  connectBroker();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
