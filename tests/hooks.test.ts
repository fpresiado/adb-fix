// Hooks tests: invoke each PowerShell hook script with a broker reachable
// and unreachable, and assert stdout contents + exit codes.

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createStore, type Store } from "../src/server/store.ts";
import { createBroker, type Broker } from "../src/server/broker.ts";
import {
  encodeMessage,
  type BridgeMessage,
} from "../src/server/protocol.ts";

const LOCAL_TMP_ROOT = join(import.meta.dir, ".tmp");
mkdirSync(LOCAL_TMP_ROOT, { recursive: true });

const BRIDGE_ROOT = join(import.meta.dir, "..");
const HOOKS_DIR = join(BRIDGE_ROOT, "hooks");
const PWSH = process.env.BRIDGE_PWSH ?? "powershell.exe";

let portCounter = 34700;
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
  tmpDir = mkdtempSync(join(LOCAL_TMP_ROOT, "hooks-"));
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
    /* WAL lock */
  }
});

async function runHook(
  scriptName: string,
  envOverrides: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const scriptPath = join(HOOKS_DIR, scriptName);
  // Use Bun.spawn instead of node:child_process.spawnSync — bun-from-bun via
  // Node's child_process hangs on fetch on Windows. Bun.spawn handles it cleanly.
  const proc = Bun.spawn({
    cmd: [
      PWSH,
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
    ],
    env: {
      ...process.env,
      BRIDGE_BUN: process.execPath,
      BRIDGE_HOOK_DEBUG: process.env.BRIDGE_HOOK_DEBUG ?? "",
      BRIDGE_URL: `ws://127.0.0.1:${wsPort}`,
      BRIDGE_HTTP_URL: `http://127.0.0.1:${httpPort}`,
      ...envOverrides,
    } as Record<string, string>,
    stdout: "pipe",
    stderr: "pipe",
  });
  // Hard wall-clock guard so a wedged hook can't hang the test runner.
  const timer = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
  }, 20000);
  const code = await proc.exited;
  clearTimeout(timer);
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  if (process.env.BRIDGE_HOOK_TEST_DEBUG) {
    process.stderr.write(`[hook ${scriptName}] exit=${code}\n`);
    process.stderr.write(`[hook ${scriptName}] stdout=<<<${stdout}>>>\n`);
    process.stderr.write(`[hook ${scriptName}] stderr=<<<${stderr}>>>\n`);
  }
  return { code, stdout, stderr };
}

function seedPersistedMessage(): void {
  const env: BridgeMessage = {
    id: crypto.randomUUID(),
    ts: Date.now(),
    from: "isko",
    to: "all",
    type: "status",
    thread_id: "t1",
    reply_to: null,
    priority: false,
    body: "seeded-by-test",
    needs_ack: false,
  };
  store.appendMessage({
    id: env.id,
    ts: env.ts,
    from_id: env.from,
    to_id: env.to,
    type: env.type as never,
    thread_id: env.thread_id,
    reply_to: env.reply_to,
    priority: env.priority,
    body: env.body,
    needs_ack: env.needs_ack,
  });
  // Touch encodeMessage so the import isn't dead code if test layout shifts.
  void encodeMessage;
}

// ---------------------------------------------------------------------------
// session-start.ps1
// ---------------------------------------------------------------------------

describe("hooks/session-start.ps1", () => {
  test("emits <bridge-history> with broker reachable + seeded message", async () => {
    seedPersistedMessage();
    const r = await runHook("session-start.ps1", {
      BRIDGE_AGENT_ID: "test_agent",
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("<bridge-history>");
    expect(r.stdout).toContain("</bridge-history>");
    expect(r.stdout).toContain("Bridge summary");
  });

  test("silent no-op (exit 0) when broker is unreachable", async () => {
    // Take down the broker so the HTTP endpoint is gone.
    await broker.stop();
    store.close();

    const r = await runHook("session-start.ps1", {
      BRIDGE_AGENT_ID: "test_agent",
      // Point HTTP at a dead port to ensure failure.
      BRIDGE_HTTP_URL: "http://127.0.0.1:1",
    });
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("<bridge-history>");

    // Re-create store/broker shells so afterEach can tear down cleanly.
    store = createStore(join(tmpDir, "bridge-recreate.db"));
    broker = createBroker({
      wsPort: wsPort + 5,
      httpPort: httpPort + 5,
      store,
      logFile: null,
    });
  });
});

// ---------------------------------------------------------------------------
// stop.ps1 / user-prompt-submit.ps1 — they share the same drain mechanics
// ---------------------------------------------------------------------------

function queueMessageForAgent(agentId: string, body: string): void {
  // Insert directly into store so the broker replays it to the agent on (re)connect?
  // The broker only sends to live sockets; the hook drain script registers
  // briefly so we test the "queued in-flight while transient connection is open"
  // path: open a peer WS, register as raw_peer, send a message TO agentId, close.
  // The drain script opens AFTER, registers, then we send to it via a NEW peer.
  // Simpler approach in tests: connect a peer, then in parallel run the hook,
  // and during the hook's brief LISTEN_MS, send a status to the agent.
  void agentId;
  void body;
}

describe("hooks/stop.ps1", () => {
  test("emits <bridge-messages> when a peer sends to the agent during the drain window", async () => {
    // Allow extra time for PS cold-start + bun cold-start + LISTEN_MS window.
    // (Per-test timeout below in 4th arg.)
    const agentId = "stop_target";
    // Open a peer WS first.
    const peer = new WebSocket(`ws://127.0.0.1:${wsPort}`);
    await new Promise<void>((resolve, reject) => {
      peer.addEventListener("open", () => resolve(), { once: true });
      peer.addEventListener("error", (e) => reject(e), { once: true });
    });
    peer.send(
      JSON.stringify({
        id: crypto.randomUUID(),
        ts: Date.now(),
        from: "peer_a",
        to: "bridge",
        type: "register",
        thread_id: "system",
        reply_to: null,
        priority: false,
        body: "peer_a",
        needs_ack: false,
      }),
    );
    await new Promise((r) => setTimeout(r, 80));

    // Heartbeat peer every 150ms so broker presence sweep doesn't drop it
    // before the scheduled send fires.
    const hbTimer = setInterval(() => {
      if (peer.readyState !== peer.OPEN) return;
      peer.send(
        JSON.stringify({
          id: crypto.randomUUID(),
          ts: Date.now(),
          from: "peer_a",
          to: "bridge",
          type: "heartbeat",
          thread_id: "system",
          reply_to: null,
          priority: false,
          body: "",
          needs_ack: false,
        }),
      );
    }, 150);

    // Schedule a send to the agent during the hook drain window.
    const sendTimer = setTimeout(() => {
      peer.send(
        JSON.stringify({
          id: crypto.randomUUID(),
          ts: Date.now(),
          from: "peer_a",
          to: agentId,
          type: "status",
          thread_id: "t1",
          reply_to: null,
          priority: false,
          body: "hello-from-peer",
          needs_ack: false,
        }),
      );
    }, 1500);

    const r = await runHook("stop.ps1", {
      BRIDGE_AGENT_ID: agentId,
      BRIDGE_HOOK_LISTEN_MS: "3000",
    });
    clearTimeout(sendTimer);
    clearInterval(hbTimer);
    peer.close();

    expect(r.code).toBe(0);
    expect(r.stdout).toContain("<bridge-messages>");
    expect(r.stdout).toContain("hello-from-peer");
  }, 15000);

  test("silent no-op when no messages are queued", async () => {
    const r = await runHook("stop.ps1", {
      BRIDGE_AGENT_ID: "stop_idle",
      BRIDGE_HOOK_LISTEN_MS: "200",
    });
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("<bridge-messages>");
  });

  test("silent no-op (exit 0) when broker is unreachable", async () => {
    await broker.stop();
    store.close();

    const r = await runHook("stop.ps1", {
      BRIDGE_AGENT_ID: "stop_orphan",
      BRIDGE_URL: "ws://127.0.0.1:1",
      BRIDGE_HOOK_LISTEN_MS: "200",
    });
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("<bridge-messages>");

    store = createStore(join(tmpDir, "bridge-recreate.db"));
    broker = createBroker({
      wsPort: wsPort + 5,
      httpPort: httpPort + 5,
      store,
      logFile: null,
    });
  });

  test("silent no-op when BRIDGE_AGENT_ID is missing", async () => {
    const r = await runHook("stop.ps1", { BRIDGE_AGENT_ID: "" });
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("<bridge-messages>");
  });
});

describe("hooks/user-prompt-submit.ps1", () => {
  test("emits <bridge-messages> when peer sends during drain window", async () => {
    const agentId = "ups_target";
    const peer = new WebSocket(`ws://127.0.0.1:${wsPort}`);
    await new Promise<void>((resolve, reject) => {
      peer.addEventListener("open", () => resolve(), { once: true });
      peer.addEventListener("error", (e) => reject(e), { once: true });
    });
    peer.send(
      JSON.stringify({
        id: crypto.randomUUID(),
        ts: Date.now(),
        from: "peer_b",
        to: "bridge",
        type: "register",
        thread_id: "system",
        reply_to: null,
        priority: false,
        body: "peer_b",
        needs_ack: false,
      }),
    );
    await new Promise((r) => setTimeout(r, 80));

    const hbTimer = setInterval(() => {
      if (peer.readyState !== peer.OPEN) return;
      peer.send(
        JSON.stringify({
          id: crypto.randomUUID(),
          ts: Date.now(),
          from: "peer_b",
          to: "bridge",
          type: "heartbeat",
          thread_id: "system",
          reply_to: null,
          priority: false,
          body: "",
          needs_ack: false,
        }),
      );
    }, 150);

    const sendTimer = setTimeout(() => {
      peer.send(
        JSON.stringify({
          id: crypto.randomUUID(),
          ts: Date.now(),
          from: "peer_b",
          to: agentId,
          type: "question",
          thread_id: "t1",
          reply_to: null,
          priority: false,
          body: "what-time-is-it",
          needs_ack: false,
        }),
      );
    }, 1500);

    const r = await runHook("user-prompt-submit.ps1", {
      BRIDGE_AGENT_ID: agentId,
      BRIDGE_HOOK_LISTEN_MS: "3000",
    });
    clearTimeout(sendTimer);
    clearInterval(hbTimer);
    peer.close();

    expect(r.code).toBe(0);
    expect(r.stdout).toContain("<bridge-messages>");
    expect(r.stdout).toContain("what-time-is-it");
  }, 15000);

  test("silent no-op when broker unreachable", async () => {
    await broker.stop();
    store.close();
    const r = await runHook("user-prompt-submit.ps1", {
      BRIDGE_AGENT_ID: "ups_orphan",
      BRIDGE_URL: "ws://127.0.0.1:1",
      BRIDGE_HOOK_LISTEN_MS: "200",
    });
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("<bridge-messages>");

    store = createStore(join(tmpDir, "bridge-recreate.db"));
    broker = createBroker({
      wsPort: wsPort + 5,
      httpPort: httpPort + 5,
      store,
      logFile: null,
    });
  });
});

// Silence unused import (test helper kept for future, deliberate).
void queueMessageForAgent;
