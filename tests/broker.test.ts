// Broker integration tests: floor handoff, broadcast, question/answer flow,
// presence timeout, /health, and /api/inject auth.

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createStore, type Store } from "../src/server/store.ts";
import { createBroker, type Broker } from "../src/server/broker.ts";
import {
  encodeMessage,
  parseMessage,
  type BridgeMessage,
  type MessageType,
} from "../src/server/protocol.ts";

const LOCAL_TMP_ROOT = join(import.meta.dir, ".tmp");
mkdirSync(LOCAL_TMP_ROOT, { recursive: true });

// Allocate fresh ports per test so parallel tests / re-runs don't collide.
let portCounter = 14700;
function nextPorts(): { ws: number; http: number } {
  const ws = portCounter;
  const http = portCounter + 1;
  portCounter += 10;
  return { ws, http };
}

let tmpDir: string;
let store: Store;
let broker: Broker;
let wsPort: number;
let httpPort: number;

function mkEnv(over: Partial<BridgeMessage>): BridgeMessage {
  return {
    id: crypto.randomUUID(),
    ts: Date.now(),
    from: "a",
    to: "all",
    type: "chat",
    thread_id: "t1",
    reply_to: null,
    priority: false,
    body: "",
    needs_ack: false,
    ...over,
  };
}

function connect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);
    ws.addEventListener("open", () => resolve(ws), { once: true });
    ws.addEventListener("error", (e) => reject(e), { once: true });
  });
}

function send(ws: WebSocket, env: BridgeMessage): void {
  ws.send(encodeMessage(env));
}

/** Collect next N messages received on ws. Resolves when N reached or timeout. */
function recv(ws: WebSocket, n: number, timeoutMs = 1500): Promise<BridgeMessage[]> {
  return new Promise((resolve) => {
    const out: BridgeMessage[] = [];
    const handler = (ev: MessageEvent): void => {
      try {
        const m = parseMessage(ev.data as string);
        out.push(m);
        if (out.length >= n) {
          ws.removeEventListener("message", handler);
          resolve(out);
        }
      } catch {
        /* ignore non-conforming frames */
      }
    };
    ws.addEventListener("message", handler);
    setTimeout(() => {
      ws.removeEventListener("message", handler);
      resolve(out);
    }, timeoutMs);
  });
}

async function register(ws: WebSocket, agentId: string): Promise<void> {
  send(
    ws,
    mkEnv({
      from: agentId,
      to: "bridge",
      type: "register",
      thread_id: "system",
      body: `${agentId}-dir`,
    }),
  );
  // No reply expected for register; give it a tick.
  await new Promise((r) => setTimeout(r, 30));
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(LOCAL_TMP_ROOT, "brk-"));
  const dbPath = join(tmpDir, "bridge.db");
  store = createStore(dbPath);
  const ports = nextPorts();
  wsPort = ports.ws;
  httpPort = ports.http;
  broker = createBroker({
    wsPort,
    httpPort,
    store,
    iskoToken: "test-token",
    presenceTickMs: 100,
    floorTimeoutMs: 1000,
    logFile: null,
  });
});

afterEach(async () => {
  await broker.stop();
  store.close();
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* WAL lock may briefly hold on Windows */
  }
});

describe("broker", () => {
  test("two agents exchange chat via floor handoff with correct ordering", async () => {
    const a = await connect();
    const b = await connect();
    await register(a, "agent_a");
    await register(b, "agent_b");

    // A requests floor → grant
    send(a, mkEnv({ from: "agent_a", to: "bridge", type: "floor_request", thread_id: "system" }));
    const grant1 = await recv(a, 1);
    expect(grant1[0]?.type).toBe("floor_grant");

    // A sends chat to all
    send(
      a,
      mkEnv({ from: "agent_a", to: "all", type: "chat", thread_id: "t1", body: "hello from a" }),
    );

    const bGot1 = await recv(b, 1);
    expect(bGot1[0]?.type).toBe("chat");
    expect(bGot1[0]?.body).toBe("hello from a");
    expect(bGot1[0]?.from).toBe("agent_a");

    // B now requests floor → grant
    send(b, mkEnv({ from: "agent_b", to: "bridge", type: "floor_request", thread_id: "system" }));
    const grant2 = await recv(b, 1);
    expect(grant2[0]?.type).toBe("floor_grant");

    // B sends chat
    send(
      b,
      mkEnv({ from: "agent_b", to: "all", type: "chat", thread_id: "t1", body: "hello from b" }),
    );
    const aGot1 = await recv(a, 1);
    expect(aGot1[0]?.body).toBe("hello from b");

    a.close();
    b.close();
  });

  test("broadcast to all reaches everyone except sender", async () => {
    const a = await connect();
    const b = await connect();
    const c = await connect();
    await register(a, "agent_a");
    await register(b, "agent_b");
    await register(c, "agent_c");

    send(
      a,
      mkEnv({ from: "agent_a", to: "all", type: "status", thread_id: "t1", body: "starting" }),
    );

    const [bGot, cGot] = await Promise.all([recv(b, 1), recv(c, 1)]);
    expect(bGot[0]?.type).toBe("status");
    expect(cGot[0]?.type).toBe("status");

    // Sender should NOT receive its own broadcast.
    const aGot = await recv(a, 1, 300);
    expect(aGot.length).toBe(0);

    a.close();
    b.close();
    c.close();
  });

  test("chat without floor is rejected with an error frame", async () => {
    const a = await connect();
    const b = await connect();
    await register(a, "agent_a");
    await register(b, "agent_b");

    send(
      a,
      mkEnv({ from: "agent_a", to: "all", type: "chat", thread_id: "t1", body: "illegal" }),
    );
    const got = await recv(a, 1);
    expect(got[0]?.type).toBe("error");
    expect(got[0]?.body).toBe("chat_without_floor");

    // B should not have received the rejected chat.
    const bGot = await recv(b, 1, 300);
    expect(bGot.length).toBe(0);

    a.close();
    b.close();
  });

  test("question/answer flow bypasses floor", async () => {
    const a = await connect();
    const b = await connect();
    await register(a, "agent_a");
    await register(b, "agent_b");

    const qId = crypto.randomUUID();
    send(
      a,
      mkEnv({
        id: qId,
        from: "agent_a",
        to: "agent_b",
        type: "question",
        thread_id: "t1",
        body: "did migrations run?",
      }),
    );

    const bGot = await recv(b, 1);
    expect(bGot[0]?.type).toBe("question");
    expect(bGot[0]?.id).toBe(qId);

    send(
      b,
      mkEnv({
        from: "agent_b",
        to: "agent_a",
        type: "answer",
        thread_id: "t1",
        reply_to: qId,
        body: "yes clean",
      }),
    );
    const aGot = await recv(a, 1);
    expect(aGot[0]?.type).toBe("answer");
    expect(aGot[0]?.reply_to).toBe(qId);

    a.close();
    b.close();
  });

  test("heartbeat timeout transitions agent to offline", async () => {
    const a = await connect();
    const b = await connect();
    await register(a, "agent_a");
    await register(b, "agent_b");

    // Stop sending heartbeats from A. Presence tick is 100ms; OFFLINE_AFTER_MISSED=3
    // so after ~3 ticks B should see a deregister broadcast.
    const bGot = await recv(b, 1, 2000);
    expect(bGot.length).toBe(1);
    expect(bGot[0]?.type).toBe("deregister");
    expect(bGot[0]?.from).toBe("agent_a");

    a.close();
    b.close();
  });

  test("/health returns correct shape", async () => {
    const a = await connect();
    await register(a, "agent_a");
    await new Promise((r) => setTimeout(r, 30));

    const res = await fetch(`http://127.0.0.1:${httpPort}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      uptime: number;
      connectedAgents: number;
      version: string;
    };
    expect(body.status).toBe("ok");
    expect(typeof body.uptime).toBe("number");
    expect(body.connectedAgents).toBeGreaterThanOrEqual(1);
    expect(body.version).toBe("0.1.0");

    a.close();
  });

  test("/api/inject without token returns 401; with token the message lands", async () => {
    const b = await connect();
    await register(b, "agent_b");

    const payload = JSON.stringify({ to: "all", type: "chat", body: "isko-broadcast" });

    const unauth = await fetch(`http://127.0.0.1:${httpPort}/api/inject`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    });
    expect(unauth.status).toBe(401);

    const ok = await fetch(`http://127.0.0.1:${httpPort}/api/inject`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-token",
      },
      body: payload,
    });
    expect(ok.status).toBe(200);

    const bGot = await recv(b, 1);
    expect(bGot[0]?.type).toBe("chat");
    expect(bGot[0]?.from).toBe("isko");
    expect(bGot[0]?.priority).toBe(true);
    expect(bGot[0]?.body).toBe("isko-broadcast");

    b.close();
  });
});
