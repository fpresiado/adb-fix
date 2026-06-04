// Bridge SQLite store: WAL-mode bun:sqlite with FTS5 search, idempotent migrations.
// Persists only the message types flagged YES in Blueprint 1 §3.2; all others are no-ops.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/**
 * Message types defined by Bridge protocol (Blueprint 1 §3.2).
 * The store persists only the subset marked "YES" in the Persisted column.
 */
export type MessageType =
  | "chat"
  | "question"
  | "answer"
  | "status"
  | "error"
  | "register"
  | "deregister"
  | "summary"
  | "ping"
  | "pong"
  | "typing"
  | "ack"
  | "heartbeat"
  | "floor_request"
  | "floor_grant"
  | "floor_deny"
  | "summary_request";

/** Persisted message types (Blueprint 1 §3.2, "Persisted" column = YES). */
export const PERSISTED_TYPES: ReadonlySet<MessageType> = new Set<MessageType>([
  "chat",
  "question",
  "answer",
  "status",
  "error",
  "register",
  "deregister",
  "summary",
]);

export interface StoredMessage {
  id: string;
  ts: number;
  from_id: string;
  to_id: string;
  type: MessageType;
  thread_id: string;
  reply_to: string | null;
  priority: boolean;
  body: string;
  needs_ack: boolean;
}

export type AgentState = "online" | "typing" | "idle" | "offline";

export interface AgentInfo {
  id: string;
  project_dir: string;
  pid: number | null;
  registered_ts: number;
  last_heartbeat_ts: number;
  state: AgentState;
}

export interface ThreadInfo {
  id: string;
  started_ts: number;
  title: string | null;
}

export interface SummaryRow {
  id: number;
  thread_id: string;
  ts: number;
  n_messages: number;
  markdown: string;
}

export interface CursorRow {
  agent_id: string;
  thread_id: string;
  last_seen_ts: number;
}

// -----------------------------------------------------------------------------
// Raw row shapes returned by SQLite (booleans stored as 0/1 integers)
// -----------------------------------------------------------------------------

interface MessageRow {
  id: string;
  ts: number;
  from_id: string;
  to_id: string;
  type: string;
  thread_id: string;
  reply_to: string | null;
  priority: number;
  body: string;
  needs_ack: number;
}

interface AgentRow {
  id: string;
  project_dir: string;
  pid: number | null;
  registered_ts: number;
  last_heartbeat_ts: number;
  state: string;
}

// -----------------------------------------------------------------------------
// Migrations
// -----------------------------------------------------------------------------

interface Migration {
  version: number;
  name: string;
  up: string;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial_schema",
    up: `
      CREATE TABLE IF NOT EXISTS messages (
        id         TEXT PRIMARY KEY,
        ts         INTEGER NOT NULL,
        from_id    TEXT NOT NULL,
        to_id      TEXT NOT NULL,
        type       TEXT NOT NULL,
        thread_id  TEXT NOT NULL,
        reply_to   TEXT,
        priority   INTEGER NOT NULL DEFAULT 0,
        body       TEXT NOT NULL,
        needs_ack  INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_messages_ts        ON messages(ts);
      CREATE INDEX IF NOT EXISTS idx_messages_thread    ON messages(thread_id, ts);
      CREATE INDEX IF NOT EXISTS idx_messages_to        ON messages(to_id, ts);

      CREATE TABLE IF NOT EXISTS agents (
        id                 TEXT PRIMARY KEY,
        project_dir        TEXT NOT NULL,
        pid                INTEGER,
        registered_ts      INTEGER NOT NULL,
        last_heartbeat_ts  INTEGER NOT NULL,
        state              TEXT NOT NULL DEFAULT 'offline'
      );

      CREATE TABLE IF NOT EXISTS threads (
        id          TEXT PRIMARY KEY,
        started_ts  INTEGER NOT NULL,
        title       TEXT
      );

      CREATE TABLE IF NOT EXISTS summaries (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id   TEXT NOT NULL,
        ts          INTEGER NOT NULL,
        n_messages  INTEGER NOT NULL,
        markdown    TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_summaries_thread ON summaries(thread_id, ts);

      CREATE TABLE IF NOT EXISTS cursors (
        agent_id      TEXT NOT NULL,
        thread_id     TEXT NOT NULL,
        last_seen_ts  INTEGER NOT NULL,
        PRIMARY KEY (agent_id, thread_id)
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        body,
        content='messages',
        content_rowid='rowid'
      );

      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, body) VALUES (new.rowid, new.body);
      END;
      CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, body) VALUES('delete', old.rowid, old.body);
      END;
      CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, body) VALUES('delete', old.rowid, old.body);
        INSERT INTO messages_fts(rowid, body) VALUES (new.rowid, new.body);
      END;
    `,
  },
];

// -----------------------------------------------------------------------------
// Store API
// -----------------------------------------------------------------------------

export interface Store {
  /** Persist a message if its type is in PERSISTED_TYPES; otherwise no-op. Returns true if persisted. */
  appendMessage(msg: StoredMessage): boolean;
  /** Return messages with ts > since, ordered by ts ascending, up to limit. */
  getMessagesSince(since: number, limit?: number): StoredMessage[];
  /** Return all messages in a thread, ordered by ts ascending. */
  getThread(threadId: string): StoredMessage[];
  /** FTS5 search over message.body; returns rows ordered by ts descending. */
  searchMessages(query: string, limit?: number): StoredMessage[];

  /** Insert or update an agent record. */
  upsertAgent(info: AgentInfo): void;
  /** Return all known agents. */
  getAgents(): AgentInfo[];
  /** Update an agent's state column. */
  setAgentState(id: string, state: AgentState): void;

  /** Insert or update a thread record. */
  upsertThread(thread: ThreadInfo): void;
  /** Lookup thread metadata by id. */
  getThreadInfo(id: string): ThreadInfo | null;

  /** Append a summary row. */
  appendSummary(s: Omit<SummaryRow, "id">): number;
  /** Latest summary rows for a thread, newest first. */
  getSummaries(threadId: string, limit?: number): SummaryRow[];

  /** Record an agent's read cursor for a thread. */
  recordCursor(agentId: string, threadId: string, ts: number): void;
  /** Lookup an agent's cursor for a thread, or null. */
  getCursor(agentId: string, threadId: string): CursorRow | null;

  /** Underlying bun:sqlite Database (escape hatch for tests/admin only). */
  readonly db: Database;
  /** Close the database (no-op if already closed). */
  close(): void;
}

const DEFAULT_PATH = "./data/bridge.db";

/**
 * Open (or create) the Bridge SQLite store at the given path and apply migrations.
 * Idempotent: opening the same path twice is safe; migrations only run once per version.
 */
export function createStore(path: string = DEFAULT_PATH): Store {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new Database(path, { create: true });

  // Pragmas per Blueprint 1 §4.
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA cache_size = -32000;");

  runMigrations(db);

  // ---------------------------------------------------------------------------
  // Prepared statements (cached for hot paths)
  // ---------------------------------------------------------------------------
  const insertMessage = db.prepare(
    `INSERT OR REPLACE INTO messages
       (id, ts, from_id, to_id, type, thread_id, reply_to, priority, body, needs_ack)
     VALUES ($id, $ts, $from_id, $to_id, $type, $thread_id, $reply_to, $priority, $body, $needs_ack)`,
  );
  const selectSince = db.prepare(
    `SELECT * FROM messages WHERE ts > $since ORDER BY ts ASC LIMIT $limit`,
  );
  const selectThread = db.prepare(
    `SELECT * FROM messages WHERE thread_id = $tid ORDER BY ts ASC`,
  );
  const selectSearch = db.prepare(
    `SELECT m.* FROM messages m
       JOIN messages_fts f ON f.rowid = m.rowid
      WHERE messages_fts MATCH $q
      ORDER BY m.ts DESC LIMIT $limit`,
  );

  const upsertAgentStmt = db.prepare(
    `INSERT INTO agents (id, project_dir, pid, registered_ts, last_heartbeat_ts, state)
     VALUES ($id, $project_dir, $pid, $registered_ts, $last_heartbeat_ts, $state)
     ON CONFLICT(id) DO UPDATE SET
       project_dir = excluded.project_dir,
       pid = excluded.pid,
       last_heartbeat_ts = excluded.last_heartbeat_ts,
       state = excluded.state`,
  );
  const selectAgents = db.prepare(`SELECT * FROM agents ORDER BY id ASC`);
  const setAgentStateStmt = db.prepare(
    `UPDATE agents SET state = $state, last_heartbeat_ts = $ts WHERE id = $id`,
  );

  const upsertThreadStmt = db.prepare(
    `INSERT INTO threads (id, started_ts, title) VALUES ($id, $started_ts, $title)
     ON CONFLICT(id) DO UPDATE SET title = excluded.title`,
  );
  const selectThreadInfoStmt = db.prepare(`SELECT * FROM threads WHERE id = $id`);

  const insertSummary = db.prepare(
    `INSERT INTO summaries (thread_id, ts, n_messages, markdown)
     VALUES ($thread_id, $ts, $n_messages, $markdown)`,
  );
  const selectSummariesStmt = db.prepare(
    `SELECT * FROM summaries WHERE thread_id = $tid ORDER BY ts DESC LIMIT $limit`,
  );

  const upsertCursor = db.prepare(
    `INSERT INTO cursors (agent_id, thread_id, last_seen_ts)
     VALUES ($agent_id, $thread_id, $ts)
     ON CONFLICT(agent_id, thread_id) DO UPDATE SET last_seen_ts = excluded.last_seen_ts`,
  );
  const selectCursor = db.prepare(
    `SELECT * FROM cursors WHERE agent_id = $agent_id AND thread_id = $thread_id`,
  );

  // ---------------------------------------------------------------------------
  // Row mappers
  // ---------------------------------------------------------------------------
  const toMessage = (r: MessageRow): StoredMessage => ({
    id: r.id,
    ts: r.ts,
    from_id: r.from_id,
    to_id: r.to_id,
    // Cast: the column is constrained at write-time via PERSISTED_TYPES check.
    type: r.type as MessageType,
    thread_id: r.thread_id,
    reply_to: r.reply_to,
    priority: r.priority !== 0,
    body: r.body,
    needs_ack: r.needs_ack !== 0,
  });

  const toAgent = (r: AgentRow): AgentInfo => ({
    id: r.id,
    project_dir: r.project_dir,
    pid: r.pid,
    registered_ts: r.registered_ts,
    last_heartbeat_ts: r.last_heartbeat_ts,
    // Cast: state column is constrained at write-time via AgentState type.
    state: r.state as AgentState,
  });

  // ---------------------------------------------------------------------------
  // Public methods
  // ---------------------------------------------------------------------------
  const store: Store = {
    db,

    appendMessage(msg: StoredMessage): boolean {
      if (!PERSISTED_TYPES.has(msg.type)) return false;
      insertMessage.run({
        $id: msg.id,
        $ts: msg.ts,
        $from_id: msg.from_id,
        $to_id: msg.to_id,
        $type: msg.type,
        $thread_id: msg.thread_id,
        $reply_to: msg.reply_to,
        $priority: msg.priority ? 1 : 0,
        $body: msg.body,
        $needs_ack: msg.needs_ack ? 1 : 0,
      });
      return true;
    },

    getMessagesSince(since: number, limit: number = 1000): StoredMessage[] {
      const rows = selectSince.all({ $since: since, $limit: limit }) as MessageRow[];
      return rows.map(toMessage);
    },

    getThread(threadId: string): StoredMessage[] {
      const rows = selectThread.all({ $tid: threadId }) as MessageRow[];
      return rows.map(toMessage);
    },

    searchMessages(query: string, limit: number = 100): StoredMessage[] {
      const rows = selectSearch.all({ $q: query, $limit: limit }) as MessageRow[];
      return rows.map(toMessage);
    },

    upsertAgent(info: AgentInfo): void {
      upsertAgentStmt.run({
        $id: info.id,
        $project_dir: info.project_dir,
        $pid: info.pid,
        $registered_ts: info.registered_ts,
        $last_heartbeat_ts: info.last_heartbeat_ts,
        $state: info.state,
      });
    },

    getAgents(): AgentInfo[] {
      const rows = selectAgents.all() as AgentRow[];
      return rows.map(toAgent);
    },

    setAgentState(id: string, state: AgentState): void {
      setAgentStateStmt.run({ $id: id, $state: state, $ts: Date.now() });
    },

    upsertThread(thread: ThreadInfo): void {
      upsertThreadStmt.run({
        $id: thread.id,
        $started_ts: thread.started_ts,
        $title: thread.title,
      });
    },

    getThreadInfo(id: string): ThreadInfo | null {
      const row = selectThreadInfoStmt.get({ $id: id }) as
        | { id: string; started_ts: number; title: string | null }
        | null;
      return row ?? null;
    },

    appendSummary(s: Omit<SummaryRow, "id">): number {
      const res = insertSummary.run({
        $thread_id: s.thread_id,
        $ts: s.ts,
        $n_messages: s.n_messages,
        $markdown: s.markdown,
      });
      return Number(res.lastInsertRowid);
    },

    getSummaries(threadId: string, limit: number = 20): SummaryRow[] {
      const rows = selectSummariesStmt.all({ $tid: threadId, $limit: limit }) as SummaryRow[];
      return rows;
    },

    recordCursor(agentId: string, threadId: string, ts: number): void {
      upsertCursor.run({ $agent_id: agentId, $thread_id: threadId, $ts: ts });
    },

    getCursor(agentId: string, threadId: string): CursorRow | null {
      const row = selectCursor.get({
        $agent_id: agentId,
        $thread_id: threadId,
      }) as CursorRow | null;
      return row ?? null;
    },

    close(): void {
      db.close();
    },
  };

  return store;
}

// -----------------------------------------------------------------------------
// Migration runner (idempotent, tracked in `_migrations` table)
// -----------------------------------------------------------------------------

function runMigrations(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_ts INTEGER NOT NULL
    );
  `);

  const appliedRows = db
    .prepare(`SELECT version FROM _migrations`)
    .all() as { version: number }[];
  const applied = new Set(appliedRows.map((r) => r.version));

  const insertApplied = db.prepare(
    `INSERT INTO _migrations (version, name, applied_ts) VALUES ($v, $n, $t)`,
  );

  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    db.transaction(() => {
      db.exec(m.up);
      insertApplied.run({ $v: m.version, $n: m.name, $t: Date.now() });
    })();
  }
}
