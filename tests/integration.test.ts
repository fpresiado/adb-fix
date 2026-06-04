// Phase 6 integration tests: spawn broker as a child process, drive 3 real WS
// clients (aegis_agent, adbpd_agent, isko) end-to-end through the public API.
// Covers: register + presence list, question/answer with reply_to linkage,
// SQLite persistence, /api/summary markdown, floor-control mutual exclusion.

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  encodeMessage,
  parseMessage,
  type BridgeMessage,
} from "../src/server/protocol.ts";

const LOCAL_TMP_ROOT = join(import.meta.dir, ".tmp");
mkdirSync(LOCAL_TMP_ROOT, { recursive: true });

// Use a port range well above the unit-test allocator range (14700+) so we
// never collide if both files run in the same process.
const WS_PORT = 34700;
const HTTP_PORT = 34701;
const ISKO_TOKEN = "integration-test-token";

let tmpDir: string;
let broker: Subprocess;

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
  return new Promise((resolveConn, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${WS_PORT}`);
    ws.addEventListener("open", () => resolveConn(ws), { once: true });
    ws.addEventListener("error", (e) => reject(e), { once: true });
  });
}

function send(ws: WebSocket, env: BridgeMessage): void {
  ws.send(encodeMessage(env));
}

/** Collect next N parsed messages on `ws`. Resolves on N or timeout. */
function recv(
  ws: WebSocket,
  n: number,
  timeoutMs = 1500,
): Promise<BridgeMessage[]> {
  return new Promise((resolveRecv) => {
    const out: BridgeMessage[] = [];
    const handler = (ev: MessageEvent): void => {
      try {
        const m = parseMessage(ev.data as string);
        out.push(m);
        if (out.length >= n) {
          ws.removeEventListener("message", handler);
          resolveRecv(out);
        }
      } catch {
        /* ignore non-conforming frames */
      }
    };
    ws.addEventListener("message", handler);
    setTimeout(() => {
      ws.removeEventListener("message", handler);
      resolveRecv(out);
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
  await new Promise((r) => setTimeout(r, 50));
}

async function waitForHealth(timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${HTTP_PORT}/health`);
      if (res.ok) {
        await res.body?.cancel();
        return;
      }
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    `broker /health never came up: ${String(lastErr ?? "unknown")}`,
  );
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(LOCAL_TMP_ROOT, "int-"));
  const dbPath = join(tmpDir, "bridge.db");
  const brokerPath = resolve(import.meta.dir, "../src/server/broker.ts");
  const storePath = resolve(import.meta.dir, "../src/server/store.ts");
  // Write a launcher file the child process can run. `bun run` does not accept
  // `-e` (only top-level `bun -e` does), and a launcher file preserves
  // useful stack traces if anything inside the child throws.
  const launcher = join(tmpDir, "launch.ts");
  writeFileSync(
    launcher,
    `import { createBroker } from ${JSON.stringify(brokerPath)};
import { createStore } from ${JSON.stringify(storePath)};
const store = createStore(${JSON.stringify(dbPath)});
const broker = createBroker({
  wsPort: ${WS_PORT},
  httpPort: ${HTTP_PORT},
  store,
  iskoToken: ${JSON.stringify(ISKO_TOKEN)},
  presenceTickMs: 250,
  floorTimeoutMs: 5000,
  logFile: null,
});
const shutdown = async () => { await broker.stop(); store.close(); process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
// Keep alive.
setInterval(() => {}, 1 << 30);
`,
  );
  // process.execPath points at the running bun binary even when PATH lacks "bun".
  broker = spawn({
    cmd: [process.execPath, "run", launcher],
    cwd: resolve(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, BRIDGE_LOG_LEVEL: "warn" },
  });
  await waitForHealth();
});

afterAll(async () => {
  try {
    broker.kill();
    await broker.exited;
  } catch {
    /* ignore */
  }
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* WAL lock may briefly hold on Windows */
  }
});

describe("integration (Phase 6)", () => {
  test("3-agent question/answer flow persists + surfaces in /api/summary + /api/agents", async () => {
    const aegis = await connect();
    const adbpd = await connect();
    const isko = await connect();
    await register(aegis, "aegis_agent");
    await register(adbpd, "adbpd_agent");
    await register(isko, "isko");

    // aegis_agent asks adbpd_agent a question
    const qId = crypto.randomUUID();
    const qBody = "is adb port 5037 healthy?";
    send(
      aegis,
      mkEnv({
        id: qId,
        from: "aegis_agent",
        to: "adbpd_agent",
        type: "question",
        thread_id: "t-integration",
        body: qBody,
      }),
    );

    const adbpdGot = await recv(adbpd, 1);
    expect(adbpdGot[0]?.type).toBe("question");
    expect(adbpdGot[0]?.id).toBe(qId);
    expect(adbpdGot[0]?.body).toBe(qBody);

    // adbpd_agent answers, linking via reply_to
    const aBody = "yes — 5037 listening, 0 zombies";
    send(
      adbpd,
      mkEnv({
        from: "adbpd_agent",
        to: "aegis_agent",
        type: "answer",
        thread_id: "t-integration",
        reply_to: qId,
        body: aBody,
      }),
    );

    const aegisGot = await recv(aegis, 1);
    expect(aegisGot[0]?.type).toBe("answer");
    expect(aegisGot[0]?.reply_to).toBe(qId);
    expect(aegisGot[0]?.body).toBe(aBody);

    // SQLite should contain both messages (visible via /api/messages).
    const msgsRes = await fetch(
      `http://127.0.0.1:${HTTP_PORT}/api/messages?since=0&limit=1000`,
    );
    expect(msgsRes.status).toBe(200);
    const msgs = (await msgsRes.json()) as BridgeMessage[];
    const qRow = msgs.find((m) => m.id === qId);
    const aRow = msgs.find((m) => m.reply_to === qId);
    expect(qRow).toBeDefined();
    expect(aRow).toBeDefined();
    expect(qRow?.body).toBe(qBody);
    expect(aRow?.body).toBe(aBody);

    // /api/summary markdown should include both bodies.
    const sumRes = await fetch(
      `http://127.0.0.1:${HTTP_PORT}/api/summary?n=500`,
    );
    expect(sumRes.status).toBe(200);
    const { markdown } = (await sumRes.json()) as { markdown: string };
    expect(markdown).toContain(qBody);
    expect(markdown).toContain(aBody);

    // /api/agents lists all three.
    const agentsRes = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/agents`);
    expect(agentsRes.status).toBe(200);
    const agents = (await agentsRes.json()) as Array<{ id: string }>;
    const ids = agents.map((a) => a.id);
    expect(ids).toContain("aegis_agent");
    expect(ids).toContain("adbpd_agent");
    expect(ids).toContain("isko");

    aegis.close();
    adbpd.close();
    isko.close();
    // Let the broker observe the closes before the next test.
    await new Promise((r) => setTimeout(r, 100));
  });

  test("floor control: only one agent holds floor; second is denied; release lets second acquire", async () => {
    const aegis = await connect();
    const adbpd = await connect();
    await register(aegis, "aegis_agent");
    await register(adbpd, "adbpd_agent");

    // Both request floor near-simultaneously. The broker serializes by message
    // arrival; whichever request lands first wins.
    send(
      aegis,
      mkEnv({
        from: "aegis_agent",
        to: "bridge",
        type: "floor_request",
        thread_id: "system",
      }),
    );
    send(
      adbpd,
      mkEnv({
        from: "adbpd_agent",
        to: "bridge",
        type: "floor_request",
        thread_id: "system",
      }),
    );

    const [aegisFrame, adbpdFrame] = await Promise.all([
      recv(aegis, 1),
      recv(adbpd, 1),
    ]);
    const aegisType = aegisFrame[0]?.type;
    const adbpdType = adbpdFrame[0]?.type;

    // Exactly one grant + one deny.
    const grants = [aegisType, adbpdType].filter((t) => t === "floor_grant");
    const denies = [aegisType, adbpdType].filter((t) => t === "floor_deny");
    expect(grants.length).toBe(1);
    expect(denies.length).toBe(1);

    const firstHolder = aegisType === "floor_grant" ? aegis : adbpd;
    const firstId =
      aegisType === "floor_grant" ? "aegis_agent" : "adbpd_agent";
    const secondHolder = aegisType === "floor_grant" ? adbpd : aegis;
    const secondId =
      aegisType === "floor_grant" ? "adbpd_agent" : "aegis_agent";

    // First holder sends a chat — this releases the floor per broker semantics.
    send(
      firstHolder,
      mkEnv({
        from: firstId,
        to: "all",
        type: "chat",
        thread_id: "t-floor",
        body: `chat-from-${firstId}`,
      }),
    );
    // The other side receives the broadcast.
    const otherGot = await recv(secondHolder, 1);
    expect(otherGot[0]?.type).toBe("chat");

    // Second agent now requests floor — should be granted.
    send(
      secondHolder,
      mkEnv({
        from: secondId,
        to: "bridge",
        type: "floor_request",
        thread_id: "system",
      }),
    );
    const grant2 = await recv(secondHolder, 1);
    expect(grant2[0]?.type).toBe("floor_grant");

    aegis.close();
    adbpd.close();
  });
});
