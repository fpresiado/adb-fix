// hook-drain-queue.ts: open a transient WS to the broker as the current agent,
// register, briefly listen for any queued messages the broker delivers on
// connect, then close and print the drained messages as JSON on stdout.
//
// Used by hooks/stop.ps1 and hooks/user-prompt-submit.ps1 to surface any
// messages that arrived while the agent's last turn was busy.
//
// Exit codes:
//   0 — success OR broker unreachable (fail-open by design)
//   2 — missing BRIDGE_AGENT_ID

import WebSocket from "ws";

const agentId = process.env.BRIDGE_AGENT_ID;
if (!agentId || agentId.trim().length === 0) {
  console.error("BRIDGE_AGENT_ID env var is required");
  process.exit(2);
}

const wsUrl = process.env.BRIDGE_URL ?? "ws://127.0.0.1:4700";

// How long to listen after registering before closing.
// Keep this small — hooks have a 60s cap and the broker delivers immediately on connect.
const LISTEN_MS = Number(process.env.BRIDGE_HOOK_LISTEN_MS ?? "500");

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

const TRANSPORT_TYPES = new Set([
  "ping",
  "pong",
  "typing",
  "heartbeat",
  "floor_grant",
  "floor_deny",
  "register",
  "deregister",
]);

const collected: BridgeMessage[] = [];

const DEBUG = !!process.env.BRIDGE_HOOK_DEBUG;
function dbg(msg: string): void {
  if (DEBUG) console.error(`[drain] ${msg}`);
}

function finish(): void {
  dbg(`finishing with ${collected.length} messages`);
  process.stdout.write(JSON.stringify(collected));
  process.exit(0);
}

let finished = false;
function finishOnce(): void {
  if (finished) return;
  finished = true;
  finish();
}

let sock: WebSocket;
try {
  sock = new WebSocket(wsUrl);
} catch {
  finishOnce();
  // unreachable but keeps types happy
  throw new Error("unreachable");
}

const overall = setTimeout(() => {
  try {
    sock.close(1000, "drain_done");
  } catch {
    /* ignore */
  }
  finishOnce();
}, LISTEN_MS + 1500);

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

sock.on("open", () => {
  const reg: BridgeMessage = {
    id: crypto.randomUUID(),
    ts: Date.now(),
    from: agentId,
    to: "bridge",
    type: "register",
    thread_id: "system",
    reply_to: null,
    priority: false,
    body: agentId,
    needs_ack: false,
  };
  try {
    sock.send(JSON.stringify(reg));
  } catch {
    /* ignore */
  }
  // Keep the connection alive during the listen window. Broker drops sockets
  // that fail presence checks; without heartbeats the drain WS would be
  // dropped before any messages can land.
  heartbeatTimer = setInterval(() => {
    if (sock.readyState !== WebSocket.OPEN) return;
    const hb: BridgeMessage = {
      id: crypto.randomUUID(),
      ts: Date.now(),
      from: agentId,
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
    } catch {
      /* ignore */
    }
  }, 100);
  setTimeout(() => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    try {
      sock.close(1000, "drain_done");
    } catch {
      /* ignore */
    }
  }, LISTEN_MS);
});

sock.on("open", () => dbg(`open as ${agentId} -> ${wsUrl}`));

sock.on("message", (raw: WebSocket.RawData) => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    return;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { type?: unknown }).type !== "string"
  ) {
    return;
  }
  const msg = parsed as BridgeMessage;
  dbg(`recv type=${msg.type} from=${msg.from} to=${msg.to}`);
  if (TRANSPORT_TYPES.has(msg.type)) return;
  collected.push(msg);
});

sock.on("close", () => {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  clearTimeout(overall);
  finishOnce();
});

sock.on("error", () => {
  // Broker unreachable — fail open.
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  clearTimeout(overall);
  finishOnce();
});
