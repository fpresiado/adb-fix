// Tests for Bridge SQLite store: append/read-back, FTS5 search, idempotent
// migration on re-open, cursor round-trip, non-persisted types are no-ops.

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// Use a project-local tmp dir; the global %TEMP% on this workstation is on a
// drive (M:) that holds WAL locks for the test DB, causing EBUSY on cleanup.
const LOCAL_TMP_ROOT = join(import.meta.dir, ".tmp");
mkdirSync(LOCAL_TMP_ROOT, { recursive: true });
import {
  createStore,
  PERSISTED_TYPES,
  type Store,
  type StoredMessage,
  type MessageType,
} from "../src/server/store.ts";

let tmpDir: string;
let dbPath: string;
let store: Store;

function makeMsg(overrides: Partial<StoredMessage> = {}): StoredMessage {
  return {
    id: crypto.randomUUID(),
    ts: Date.now(),
    from_id: "aegis_agent",
    to_id: "marea_agent",
    type: "chat",
    thread_id: "thread-1",
    reply_to: null,
    priority: false,
    body: "hello bridge",
    needs_ack: false,
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(LOCAL_TMP_ROOT, "bridge-store-"));
  dbPath = join(tmpDir, "bridge.db");
  store = createStore(dbPath);
});

afterEach(() => {
  try {
    store.close();
  } catch {
    /* already closed */
  }
  // Best-effort cleanup; Windows can briefly hold WAL/SHM file handles after
  // close, which is harmless for these tests since LOCAL_TMP_ROOT is gitignored.
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* leave for next run */
  }
});

describe("appendMessage + read-back", () => {
  test("persists a chat message and reads it back via getMessagesSince", () => {
    const m = makeMsg({ body: "first message", ts: 1000 });
    expect(store.appendMessage(m)).toBe(true);

    const rows = store.getMessagesSince(0);
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(row.id).toBe(m.id);
    expect(row.body).toBe("first message");
    expect(row.from_id).toBe("aegis_agent");
    expect(row.to_id).toBe("marea_agent");
    expect(row.priority).toBe(false);
    expect(row.needs_ack).toBe(false);
    expect(row.reply_to).toBeNull();
  });

  test("getThread returns messages ordered by ts ascending", () => {
    store.appendMessage(makeMsg({ ts: 300, body: "three" }));
    store.appendMessage(makeMsg({ ts: 100, body: "one" }));
    store.appendMessage(makeMsg({ ts: 200, body: "two" }));

    const thread = store.getThread("thread-1");
    expect(thread.map((m) => m.body)).toEqual(["one", "two", "three"]);
  });

  test("preserves booleans and reply_to linkage", () => {
    const q = makeMsg({ type: "question", body: "did it work?", ts: 10 });
    store.appendMessage(q);
    const a = makeMsg({
      type: "answer",
      body: "yes",
      ts: 20,
      reply_to: q.id,
      priority: true,
      needs_ack: true,
    });
    store.appendMessage(a);

    const rows = store.getMessagesSince(0);
    const answer = rows.find((r) => r.id === a.id)!;
    expect(answer.type).toBe("answer");
    expect(answer.reply_to).toBe(q.id);
    expect(answer.priority).toBe(true);
    expect(answer.needs_ack).toBe(true);
  });
});

describe("FTS5 search", () => {
  test("searchMessages finds rows by full-text body match", () => {
    store.appendMessage(makeMsg({ body: "USB hybrid working on Note 20", ts: 1 }));
    store.appendMessage(makeMsg({ body: "SQLite migrations ran clean", ts: 2 }));
    store.appendMessage(makeMsg({ body: "Bun FFI segfault on line 42", ts: 3 }));

    const usb = store.searchMessages("USB");
    expect(usb.length).toBe(1);
    expect(usb[0]!.body).toContain("USB");

    const sqlite = store.searchMessages("SQLite");
    expect(sqlite.length).toBe(1);
    expect(sqlite[0]!.body).toContain("SQLite");

    const none = store.searchMessages("nonexistentword");
    expect(none.length).toBe(0);
  });

  test("searchMessages returns rows in ts DESC order", () => {
    store.appendMessage(makeMsg({ body: "ship one", ts: 100 }));
    store.appendMessage(makeMsg({ body: "ship two", ts: 200 }));
    store.appendMessage(makeMsg({ body: "ship three", ts: 300 }));

    const hits = store.searchMessages("ship");
    expect(hits.length).toBe(3);
    expect(hits[0]!.ts).toBe(300);
    expect(hits[2]!.ts).toBe(100);
  });
});

describe("idempotent migrations on re-open", () => {
  test("re-opening the same DB does not duplicate migrations or lose data", () => {
    store.appendMessage(makeMsg({ body: "persisted across reopen", ts: 42 }));
    store.close();

    // Re-open the same path; should not throw and should preserve data.
    store = createStore(dbPath);
    const rows = store.getMessagesSince(0);
    expect(rows.length).toBe(1);
    expect(rows[0]!.body).toBe("persisted across reopen");

    // Migration tracking table should have exactly one row per version.
    const counts = store.db
      .prepare(`SELECT version, COUNT(*) AS c FROM _migrations GROUP BY version`)
      .all() as { version: number; c: number }[];
    for (const row of counts) {
      expect(row.c).toBe(1);
    }
    expect(counts.length).toBeGreaterThanOrEqual(1);
  });

  test("can re-open three times without error", () => {
    store.close();
    for (let i = 0; i < 3; i++) {
      const s = createStore(dbPath);
      s.close();
    }
    store = createStore(dbPath);
    expect(store.getMessagesSince(0).length).toBe(0);
  });
});

describe("cursor round-trip", () => {
  test("recordCursor + getCursor returns the recorded ts", () => {
    expect(store.getCursor("aegis_agent", "thread-1")).toBeNull();

    store.recordCursor("aegis_agent", "thread-1", 12345);
    const c = store.getCursor("aegis_agent", "thread-1");
    expect(c).not.toBeNull();
    expect(c!.agent_id).toBe("aegis_agent");
    expect(c!.thread_id).toBe("thread-1");
    expect(c!.last_seen_ts).toBe(12345);
  });

  test("recordCursor overwrites prior ts for same (agent, thread)", () => {
    store.recordCursor("aegis_agent", "thread-1", 100);
    store.recordCursor("aegis_agent", "thread-1", 999);
    const c = store.getCursor("aegis_agent", "thread-1");
    expect(c!.last_seen_ts).toBe(999);
  });

  test("separate cursors per (agent, thread) pair", () => {
    store.recordCursor("aegis_agent", "thread-1", 1);
    store.recordCursor("aegis_agent", "thread-2", 2);
    store.recordCursor("marea_agent", "thread-1", 3);

    expect(store.getCursor("aegis_agent", "thread-1")!.last_seen_ts).toBe(1);
    expect(store.getCursor("aegis_agent", "thread-2")!.last_seen_ts).toBe(2);
    expect(store.getCursor("marea_agent", "thread-1")!.last_seen_ts).toBe(3);
  });
});

describe("non-persisted message types are silent no-ops", () => {
  const ephemeralTypes: MessageType[] = [
    "ping",
    "pong",
    "typing",
    "ack",
    "heartbeat",
    "floor_request",
    "floor_grant",
    "floor_deny",
    "summary_request",
  ];

  for (const t of ephemeralTypes) {
    test(`type=${t} is not persisted`, () => {
      expect(PERSISTED_TYPES.has(t)).toBe(false);
      const persisted = store.appendMessage(makeMsg({ type: t, body: `ephemeral-${t}` }));
      expect(persisted).toBe(false);
      expect(store.getMessagesSince(0).length).toBe(0);
    });
  }

  test("persisted types ARE in PERSISTED_TYPES", () => {
    const persistedTypes: MessageType[] = [
      "chat",
      "question",
      "answer",
      "status",
      "error",
      "register",
      "deregister",
      "summary",
    ];
    for (const t of persistedTypes) {
      expect(PERSISTED_TYPES.has(t)).toBe(true);
    }
  });
});

describe("agents CRUD", () => {
  test("upsertAgent inserts, then updates", () => {
    store.upsertAgent({
      id: "aegis_agent",
      project_dir: "P:/aegis",
      pid: 1234,
      registered_ts: 100,
      last_heartbeat_ts: 100,
      state: "online",
    });
    let all = store.getAgents();
    expect(all.length).toBe(1);
    expect(all[0]!.pid).toBe(1234);

    store.upsertAgent({
      id: "aegis_agent",
      project_dir: "P:/aegis",
      pid: 5678,
      registered_ts: 100,
      last_heartbeat_ts: 200,
      state: "idle",
    });
    all = store.getAgents();
    expect(all.length).toBe(1);
    expect(all[0]!.pid).toBe(5678);
    expect(all[0]!.state).toBe("idle");
  });

  test("setAgentState mutates only the state column", () => {
    store.upsertAgent({
      id: "marea_agent",
      project_dir: "P:/marea",
      pid: null,
      registered_ts: 1,
      last_heartbeat_ts: 1,
      state: "online",
    });
    store.setAgentState("marea_agent", "offline");
    const a = store.getAgents().find((x) => x.id === "marea_agent")!;
    expect(a.state).toBe("offline");
  });
});
