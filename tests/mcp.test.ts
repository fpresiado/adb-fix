// MCP server tests: spawn bridge-mcp.ts as a subprocess speaking stdio JSON-RPC,
// drive it from an MCP client, and assert payloads round-trip via a real broker.

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createStore, type Store } from "../src/server/store.ts";
import { createBroker, type Broker } from "../src/server/broker.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const LOCAL_TMP_ROOT = join(import.meta.dir, ".tmp");
mkdirSync(LOCAL_TMP_ROOT, { recursive: true });

let portCounter = 24700;
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

beforeEach(() => {
  tmpDir = mkdtempSync(join(LOCAL_TMP_ROOT, "mcp-"));
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
    presenceTickMs: 200,
    floorTimeoutMs: 2000,
    logFile: null,
  });
});

afterEach(async () => {
  await broker.stop();
  store.close();
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* WAL lock may hold briefly on Windows */
  }
});

interface SpawnedMcp {
  client: Client;
  close: () => Promise<void>;
}

async function spawnMcp(agentId: string): Promise<SpawnedMcp> {
  const bridgeRoot = join(import.meta.dir, "..");
  const mcpScript = join(bridgeRoot, "src", "mcp", "bridge-mcp.ts");
  // StdioClientTransport scrubs PATH via getDefaultEnvironment — use absolute path.
  const bunExe = process.execPath; // running test is bun, so this is bun.exe
  const transport = new StdioClientTransport({
    command: bunExe,
    args: ["run", mcpScript],
    env: {
      ...process.env,
      BRIDGE_AGENT_ID: agentId,
      BRIDGE_URL: `ws://127.0.0.1:${wsPort}`,
      BRIDGE_HTTP_URL: `http://127.0.0.1:${httpPort}`,
      PATH: process.env.PATH ?? "",
    } as Record<string, string>,
    stderr: "pipe",
  });
  transport.stderr?.on("data", (d) => {
    process.stderr.write(`[mcp-child] ${d}`);
  });
  const client = new Client({ name: "test-harness", version: "0.0.1" });
  await client.connect(transport);
  // Give the MCP server a beat to finish its WS register handshake with the broker.
  await new Promise((r) => setTimeout(r, 250));
  return {
    client,
    close: async () => {
      await client.close().catch(() => {});
    },
  };
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  const first = result.content[0];
  if (!first || first.type !== "text" || typeof first.text !== "string") {
    throw new Error("expected text content");
  }
  return first.text;
}

describe("bridge-mcp", () => {
  test("lists the five expected tools", async () => {
    const { client, close } = await spawnMcp("mcp_agent_list");
    try {
      const list = await client.listTools();
      const names = list.tools.map((t) => t.name).sort();
      expect(names).toEqual([
        "bridge_agents",
        "bridge_history",
        "bridge_read",
        "bridge_send",
        "bridge_summary",
      ]);
    } finally {
      await close();
    }
  });

  test("bridge_send pushes a message that reaches another agent via WS", async () => {
    const { client, close } = await spawnMcp("mcp_sender");

    // Open a second raw WS client as the receiver, register it directly.
    const receiver = new WebSocket(`ws://127.0.0.1:${wsPort}`);
    await new Promise<void>((resolve, reject) => {
      receiver.addEventListener("open", () => resolve(), { once: true });
      receiver.addEventListener("error", (e) => reject(e), { once: true });
    });
    const received: string[] = [];
    receiver.addEventListener("message", (ev) => {
      try {
        const m = JSON.parse(ev.data as string);
        if (m.type === "question" && m.from === "mcp_sender") {
          received.push(m.body);
        }
      } catch {
        /* ignore */
      }
    });
    // Register receiver
    receiver.send(
      JSON.stringify({
        id: crypto.randomUUID(),
        ts: Date.now(),
        from: "mcp_receiver",
        to: "bridge",
        type: "register",
        thread_id: "system",
        reply_to: null,
        priority: false,
        body: "mcp_receiver",
        needs_ack: false,
      }),
    );
    await new Promise((r) => setTimeout(r, 100));

    try {
      const result = await client.callTool({
        name: "bridge_send",
        arguments: {
          to: "mcp_receiver",
          type: "question",
          body: "are you there?",
        },
      });
      const ack = JSON.parse(textOf(result as never));
      expect(typeof ack.id).toBe("string");
      expect(typeof ack.ts).toBe("number");

      // Wait briefly for the broker to deliver to the receiver.
      const deadline = Date.now() + 1500;
      while (received.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(received).toEqual(["are you there?"]);
    } finally {
      receiver.close();
      await close();
    }
  });

  test("bridge_read drains queued inbound messages received via the broker", async () => {
    const { client, close } = await spawnMcp("mcp_reader");

    // Send a message TO mcp_reader from a different raw WS client.
    const sender = new WebSocket(`ws://127.0.0.1:${wsPort}`);
    await new Promise<void>((resolve, reject) => {
      sender.addEventListener("open", () => resolve(), { once: true });
      sender.addEventListener("error", (e) => reject(e), { once: true });
    });
    sender.send(
      JSON.stringify({
        id: crypto.randomUUID(),
        ts: Date.now(),
        from: "raw_sender",
        to: "bridge",
        type: "register",
        thread_id: "system",
        reply_to: null,
        priority: false,
        body: "raw_sender",
        needs_ack: false,
      }),
    );
    await new Promise((r) => setTimeout(r, 100));
    sender.send(
      JSON.stringify({
        id: crypto.randomUUID(),
        ts: Date.now(),
        from: "raw_sender",
        to: "mcp_reader",
        type: "status",
        thread_id: "t1",
        reply_to: null,
        priority: false,
        body: "ping from raw",
        needs_ack: false,
      }),
    );

    // Wait for the MCP server's WS to enqueue it.
    await new Promise((r) => setTimeout(r, 300));

    try {
      const result = await client.callTool({
        name: "bridge_read",
        arguments: {},
      });
      const parsed = JSON.parse(textOf(result as never)) as Array<{
        from: string;
        body: string;
        type: string;
      }>;
      const fromRaw = parsed.filter((m) => m.from === "raw_sender");
      expect(fromRaw.length).toBeGreaterThanOrEqual(1);
      const found = fromRaw[0]!;
      expect(found.body).toBe("ping from raw");
      expect(found.type).toBe("status");

      // Second drain should not re-yield the same message.
      const result2 = await client.callTool({
        name: "bridge_read",
        arguments: {},
      });
      const parsed2 = JSON.parse(textOf(result2 as never)) as Array<{
        from: string;
      }>;
      expect(parsed2.filter((m) => m.from === "raw_sender")).toEqual([]);
    } finally {
      sender.close();
      await close();
    }
  });

  test("bridge_history returns persisted messages from the broker", async () => {
    const { client, close } = await spawnMcp("mcp_hist");
    // Seed one persisted message via bridge_send.
    await client.callTool({
      name: "bridge_send",
      arguments: { to: "all", type: "status", body: "seed-1" },
    });
    await new Promise((r) => setTimeout(r, 150));

    try {
      const result = await client.callTool({
        name: "bridge_history",
        arguments: { n: 10 },
      });
      const rows = JSON.parse(textOf(result as never)) as Array<{
        from: string;
        body: string;
      }>;
      const seed = rows.find((r) => r.body === "seed-1");
      expect(seed).toBeDefined();
      expect(seed?.from).toBe("mcp_hist");
    } finally {
      await close();
    }
  });

  test("bridge_agents lists the connected agent", async () => {
    const { client, close } = await spawnMcp("mcp_who");
    try {
      const result = await client.callTool({
        name: "bridge_agents",
        arguments: {},
      });
      const agents = JSON.parse(textOf(result as never)) as Array<{
        id: string;
      }>;
      expect(agents.some((a) => a.id === "mcp_who")).toBe(true);
    } finally {
      await close();
    }
  });

  test("bridge_summary returns markdown text", async () => {
    const { client, close } = await spawnMcp("mcp_sum");
    await client.callTool({
      name: "bridge_send",
      arguments: { to: "all", type: "status", body: "summary-seed" },
    });
    await new Promise((r) => setTimeout(r, 150));
    try {
      const result = await client.callTool({
        name: "bridge_summary",
        arguments: { n: 10 },
      });
      const md = textOf(result as never);
      expect(md).toContain("Bridge summary");
    } finally {
      await close();
    }
  });
});
