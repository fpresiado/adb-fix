# Bridge — Architecture

## Layer map

| # | Component | Port / Interface | Responsibility |
|---|---|---|---|
| L1 | Broker WebSocket | TCP `127.0.0.1:4700` | Agent + TUI + dashboard wire protocol. Bun native pub/sub. |
| L2 | Broker HTTP | TCP `127.0.0.1:4701` | Dashboard HTML, hook endpoints, `/health`, summary API |
| L3 | Store | `data/bridge.db` | bun:sqlite WAL, FTS5 search, single-writer invariant |
| L4 | Presence | in-process | Heartbeat TTL, online/typing/idle/offline state machine |
| L5 | Floor | in-process | Single-token floor for `chat`, 30s auto-release, priority bypass |
| L6 | Protocol | Zod schemas | Wire envelope validation, type discrimination |
| L7 | TUI | stdio (per PS session) | Ink chat window, one process per agent identity |
| L8 | Dashboard | HTTP + WS | Static HTML + Alpine.js, supervisor view, injection box |
| L9 | MCP | stdio JSON-RPC | `bridge-mcp.ts` per Claude Code project, 5 tools |
| L10 | Hooks | PowerShell scripts | `SessionStart`, `Stop`, `UserPromptSubmit` — turn-boundary injection |

## Key files

```
src/
├── server/
│   ├── broker.ts            # L1+L2 — Bun.serve WS :4700 + HTTP :4701
│   ├── store.ts             # L3 — bun:sqlite WAL, FTS5, CRUD
│   ├── presence.ts          # L4 — heartbeat TTL state machine
│   ├── floor.ts             # L5 — floor token + 30s auto-release
│   ├── protocol.ts          # L6 — Zod schemas, type guards
│   └── summary.ts           # Markdown history generator
├── client/
│   ├── tui.tsx              # L7 — Ink entry point
│   ├── components/          #   Header, PresenceBar, MessageList, InputBox
│   └── ws-client.ts         # Shared WS client + auto-reconnect
├── dashboard/
│   ├── index.html           # L8 — Alpine.js + Tailwind, single file
│   └── assets/              # Local Alpine + Tailwind, no CDN
├── mcp/
│   ├── bridge-mcp.ts        # L9 — stdio MCP server (console.error only)
│   └── ws-client.ts         # Reused WS connection for MCP
hooks/
├── session-start.ps1        # L10 — inject Markdown summary
├── stop-inject.ps1          # L10 — inject queued messages at turn end
└── user-prompt-submit.ps1   # L10 — inject pending messages on human input
scripts/
├── install-service.ps1      # NSSM service install (Windows)
├── reset-bridge.ps1         # Elevated reset playbook (mirrors reset-adbpd.ps1)
├── bridge.service           # systemd unit (Linux, future)
└── soak.ts                  # 4h production soak harness
docs/
├── 01-overview.md
├── 02-architecture.md       # THIS FILE
├── 03-protocol.md
├── 04-disaster-recovery.md
└── 05-operations.md
config/
└── bridge.config.ts         # Ports, paths, TTLs, agent colors
data/
└── bridge.db                # SQLite WAL — broker is sole writer
logs/
└── bridge.log               # Pino structured JSON
tests/
├── unit/                    # One .test.ts per module
└── integration/             # 2-agent question/answer, hook end-to-end
```

## Component diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          AGENT LAYER (per project)                      │
│                                                                         │
│   ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌──────────────┐  │
│   │ aegis_agent │  │ marea_agent │  │ adbpd_agent │  │     isko     │  │
│   │             │  │             │  │             │  │  (Claude     │  │
│   │ Ink TUI     │  │ Ink TUI     │  │ Ink TUI     │  │   Desktop +  │  │
│   │ + MCP stdio │  │ + MCP stdio │  │ + MCP stdio │  │   browser)   │  │
│   │ + hooks/*   │  │ + hooks/*   │  │ + hooks/*   │  │              │  │
│   └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └───────┬──────┘  │
└──────────┼─────────────────┼─────────────────┼─────────────────┼────────┘
           │ WS :4700        │ WS :4700        │ WS :4700        │ WS :4700
           │ HTTP :4701 (hk) │ HTTP :4701 (hk) │ HTTP :4701 (hk) │ HTTP :4701
           ▼                 ▼                 ▼                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      BRIDGE BROKER  (127.0.0.1)                         │
│                                                                         │
│   ┌──────────────────┐  ┌──────────────────┐  ┌────────────────────┐    │
│   │ Message Router   │  │ Floor Controller │  │ Presence Manager   │    │
│   │ direct + fan-out │  │ token + timeout  │  │ 10s heartbeat TTL  │    │
│   │ (broker.ts)      │  │ (floor.ts)       │  │ (presence.ts)      │    │
│   └────────┬─────────┘  └────────┬─────────┘  └─────────┬──────────┘    │
│            │                     │                       │              │
│            ▼                     ▼                       ▼              │
│   ┌──────────────────────────────────────────────────────────────────┐  │
│   │              Protocol Layer  —  Zod validation                   │  │
│   │  16 message types (chat / question / answer / status / error /  │  │
│   │  ping / pong / typing / ack / register / deregister /            │  │
│   │  heartbeat / floor_request / floor_grant / floor_deny /          │  │
│   │  summary_request / summary)                                      │  │
│   └─────────────────────────────────┬────────────────────────────────┘  │
│                                     │                                   │
│            persistence (broker is the SOLE writer)                      │
│                                     ▼                                   │
│   ┌──────────────────────────────────────────────────────────────────┐  │
│   │           bun:sqlite WAL  —  data/bridge.db                      │  │
│   │  messages · agents · threads · summaries · acks · messages_fts   │  │
│   └──────────────────────────────────────────────────────────────────┘  │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
           │                                                  │
           │ HTTP :4701/dashboard                              │ HTTP :4701/health
           ▼                                                  ▼
┌──────────────────────────────────┐     ┌──────────────────────────────┐
│  HTML Dashboard (browser)        │     │  Monitoring / smoke checks   │
│  Alpine.js + Tailwind, no build  │     │  { status, uptime,           │
│  Isko supervisor + inject box    │     │    connectedAgents, version }│
└──────────────────────────────────┘     └──────────────────────────────┘
```

## Data flow — three primary paths

### 1. Agent-to-agent question/answer

1. `aegis_agent` calls `bridge_send(to: "marea_agent", type: "question", body: "…")` via MCP.
2. `bridge-mcp.ts` serializes a `BridgeMessage`, sends over the persistent WS connection.
3. Broker validates via Zod, assigns `id` + `ts`, persists to `messages`, fans out to `agent:marea_agent` subscribers.
4. If `marea_agent`'s TUI is open, the message renders in real time.
5. When `marea_agent`'s next Claude Code turn ends, `stop-inject.ps1` calls `GET /api/messages/queued?agent=marea_agent`, gets the question, returns `decision:block` with the message in `additionalContext` — Claude Code grants one more turn.
6. `marea_agent` calls `bridge_send(to: "aegis_agent", type: "answer", reply_to: "<id>", …)`. Same path back.

### 2. Isko injection from the dashboard

1. Isko types in the dashboard injection box; Alpine.js sends a WS message with `from: "isko"` and `priority: true`.
2. Broker bypasses floor logic (priority short-circuit), persists, fans out to the target agent's subscription.
3. Target agent picks up the message via its next `Stop` hook with priority-sorted ordering.

### 3. SessionStart history injection

1. New Claude Code session opens on a project with Bridge registered.
2. `session-start.ps1` calls `GET /api/summary?n=50&agent=<id>` and prints a Markdown block as `additionalContext`.
3. The fresh session begins its first turn with the last 50 cross-agent messages already in context.

## Port layout

| Port | Bind | Purpose | Trust |
|---|---|---|---|
| 4700 | `127.0.0.1` | Broker WebSocket — agent + TUI + dashboard wire protocol | Loopback only |
| 4701 | `127.0.0.1` | Broker HTTP — dashboard, hook endpoints, `/health`, summary API | Loopback only |

Both binds are explicit. There is no `0.0.0.0` path anywhere in the broker. The trust boundary is the loopback interface — anyone with local access can impersonate any agent (documented threat model; see HANDOFF.md "Open questions").

## Database schema (bun:sqlite)

Six tables. The broker is the sole writer; readers (dashboard HTTP, summary API) hold read-only connections.

```sql
CREATE TABLE messages (
    id          TEXT PRIMARY KEY,         -- uuid v4
    ts          INTEGER NOT NULL,         -- Unix ms
    from_agent  TEXT NOT NULL,
    to_agent    TEXT NOT NULL,            -- agent id or "all"
    type        TEXT NOT NULL,
    thread_id   TEXT NOT NULL,
    reply_to    TEXT,                     -- FK to messages.id
    priority    INTEGER NOT NULL DEFAULT 0,
    body        TEXT NOT NULL,
    needs_ack   INTEGER NOT NULL DEFAULT 0,
    read_by     TEXT NOT NULL DEFAULT '[]'
);

CREATE VIRTUAL TABLE messages_fts USING fts5(
    body, content=messages, content_rowid=rowid
);

CREATE TABLE agents (
    agent_id      TEXT PRIMARY KEY,
    project_dir   TEXT NOT NULL,
    pid           INTEGER,
    state         TEXT NOT NULL DEFAULT 'offline',
    last_seen     INTEGER NOT NULL,
    last_seq      INTEGER NOT NULL DEFAULT 0,  -- replay cursor
    registered_at INTEGER NOT NULL
);

CREATE TABLE threads (
    thread_id    TEXT PRIMARY KEY,
    title        TEXT,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    participants TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE summaries (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id   TEXT,
    from_msg_id TEXT NOT NULL,
    to_msg_id   TEXT NOT NULL,
    body        TEXT NOT NULL,
    created_at  INTEGER NOT NULL
);

CREATE TABLE acks (
    msg_id   TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    acked_at INTEGER NOT NULL,
    PRIMARY KEY (msg_id, agent_id)
);

PRAGMA journal_mode = WAL;
PRAGMA synchronous  = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA cache_size   = -32000;   -- 32 MB
```

Auto-checkpoint fires at 1000 pages (~4 MB). Retention: 30 days of raw messages, older rows replaced by daily summaries. The single-writer invariant means no `BEGIN IMMEDIATE` contention and no `database is locked` errors in practice.

## HTTP endpoint table (port 4701)

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/health` | `{ status, uptime, connectedAgents, version }` — mirrors ADBPD |
| GET | `/dashboard` | Static HTML, Alpine.js bootstrap |
| GET | `/dashboard/api/messages?since=N` | JSON history slice for dashboard hydration |
| GET | `/dashboard/api/agents` | Agent roster + presence |
| GET | `/api/messages/queued?agent=<id>` | Stop-hook fetches undelivered messages |
| POST | `/api/messages/mark-delivered` | Stop-hook acks delivery (body: `{ agent, ids[] }`) |
| GET | `/api/messages/unread?agent=<id>` | Messages since `last_seq` cursor |
| GET | `/api/summary?n=50&agent=<id>` | Markdown summary for SessionStart injection |
| GET | `/api/agents` | Agent roster (alias of dashboard variant) |

The hook endpoints (`/api/messages/*` and `/api/summary`) are the contract surface for `hooks/stop-inject.ps1`, `hooks/session-start.ps1`, and `hooks/user-prompt-submit.ps1`. They must stay fast (sub-second) because hooks have a 60s execution ceiling and the Stop hook fires on every turn.

## Floor state machine

Lives in `src/server/floor.ts`. Only `chat` messages consume the floor; everything else bypasses.

```
state: { currentFloor: agentId | null,
         heldSince:    number | null,
         timer:        Timer | null  }

agent → floor_request:
    if currentFloor == null:
        currentFloor := agentId
        heldSince    := now
        timer        := setTimeout(autoRelease, 30_000)
        send floor_grant to agentId
    else:
        send floor_deny to agentId  (client retries after 2s)

agent → chat (must come AFTER floor_grant):
    if currentFloor != agentId:
        reject — log incident, drop message
    else:
        persist, fan-out per (to_agent),
        currentFloor := null, clear timer,
        broadcast floor_free

autoRelease (30s timeout fires):
    log incident,
    currentFloor := null, clear timer,
    broadcast floor_free

priority message (from: "isko", priority: true):
    persist, fan-out immediately,
    if currentFloor != null:
        clear timer, currentFloor := null,
        broadcast floor_free
```

`question`, `answer`, `status`, and `error` skip floor entirely — they cannot collide because they are routed to a specific recipient (or fan-out is intentional, in the case of `status` and `error`, and the user reads them in delivered order).

## WebSocket subscriptions (Bun native pub/sub)

```ts
// On register:
ws.subscribe("global");                  // all broadcasts
ws.subscribe(`agent:${agentId}`);        // direct messages

// On broker fan-out:
server.publish("global", encoded);                // status, error, broadcasts
server.publish(`agent:${to}`, encoded);           // direct
```

The dashboard registers as `isko` and subscribes to `global` plus `agent:isko`. The TUI subscribes to `global` plus its agent's channel. No glob patterns — exact-channel subscribes only, which keeps fan-out cheap.

## Logging

`pino` structured JSON to `logs/bridge.log`, rotated at 50 MB via NSSM's `AppRotateBytes` on Windows (logrotate on Linux). Production paths never call `console.log`. The lone exception is `src/mcp/bridge-mcp.ts`, which inherits the stdio JSON-RPC contract — all debug there uses `console.error` only, because stdout belongs to the MCP transport.
