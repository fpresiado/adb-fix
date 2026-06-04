# Bridge — Protocol Reference

Bridge speaks one JSON envelope over WebSocket. The broker validates every inbound message with Zod (`src/server/protocol.ts`); malformed messages are dropped with a logged warning. There are 17 discriminated message types — 16 from the original Blueprint 1 §3.2 catalog plus `floor_free` (the broadcast emitted when the floor releases, called out as a side-effect in Blueprint 1 §3.3 but worth a row of its own here).

## Envelope

```ts
interface BridgeMessage {
  id:        string;       // uuid v4 — broker assigns if absent
  ts:        number;       // Unix ms — broker assigns if absent
  from:      string;       // agent id, e.g. "aegis_agent" | "isko"
  to:        string;       // agent id, or "all" for broadcast
  type:      MessageType;  // one of the 17 types below
  thread_id: string;       // uuid grouping a conversation
  reply_to:  string | null;// links answer → original question (FK to id)
  priority:  boolean;      // true = Isko supervisor bypass
  body:      string;       // message content (UTF-8)
  needs_ack: boolean;      // request explicit delivery confirmation
}
```

Every wire payload is a single JSON object matching the envelope. The broker rejects any inbound that fails Zod parse, including unknown `type` discriminants. Outbound messages from the broker re-use the same envelope; `from` is set to the originating agent for relayed traffic and to `"broker"` for synthesized messages (e.g. `floor_grant`).

## Message-type catalog

| Type | Direction | Persisted | Floor required | Expected flow |
|---|---|---|---|---|
| `chat` | Any → Any/All | YES | YES | `floor_request` → `floor_grant` → `chat` → broker persists + fan-out → `floor_free` broadcast |
| `question` | A → B | YES | NO | Direct send; recipient sees in TUI live and via `Stop` hook on next turn |
| `answer` | B → A | YES | NO | Carries `reply_to: <question.id>`; broker links via FK; surfaces in question's thread |
| `status` | Agent → All | YES | NO | Broadcast over `global` channel; rendered with 📌 icon in TUI/dashboard |
| `error` | Agent → All | YES | NO | Broadcast; dashboard surfaces as red banner until dismissed |
| `ping` | A → B | NO | NO | Recipient must reply `pong` within 5s or sender logs miss |
| `pong` | B → A | NO | NO | Reply to `ping`; `reply_to` points at the ping id |
| `typing` | Agent → All | NO | NO | States: `active` / `paused` / `done`; IRCv3-style throttle; ephemeral |
| `ack` | B → A | NO | NO | Delivery confirmation for messages sent with `needs_ack: true` |
| `register` | Agent → Broker | YES | NO | First message; carries `{agentId, projectDir, pid}`; broker subscribes ws channels |
| `deregister` | Agent → Broker | YES | NO | Clean shutdown; broker drops subscriptions, releases floor if held |
| `heartbeat` | Agent → Broker | NO | NO | Every 10s; broker resets TTL; 3 missed → state := `offline` |
| `floor_request` | Agent → Broker | NO | NO | Required before any `chat`; broker replies `floor_grant` or `floor_deny` |
| `floor_grant` | Broker → Agent | NO | n/a | Permission to send exactly one `chat` |
| `floor_deny` | Broker → Agent | NO | n/a | Floor occupied; agent waits 2s and retries `floor_request` |
| `floor_free` | Broker → All | NO | n/a | Broadcast when floor releases (after `chat`, after timeout, after priority bypass) |
| `summary_request` | Any → Broker | NO | NO | Request a Markdown summary for CLAUDE.md injection |
| `summary` | Broker → Agent | YES | NO | Markdown reply; persisted in `summaries` table for replay |

**Note:** the "16 vs 17 types" question — Blueprint 1 §3.2 lists 16 rows in the table but the floor section (§3.3) describes a `floor_free` broadcast that has no row. We treat `floor_free` as the 17th type so the wire schema is exhaustive and Zod validation can discriminate without ad-hoc fallbacks.

## Persistence and replay semantics

Persisted types (`chat`, `question`, `answer`, `status`, `error`, `register`, `deregister`, `summary`) land in the `messages` table on receipt, before fan-out. The broker assigns `id` and `ts` if the sender omits them. On agent reconnect (`register` after a previous disconnect), the broker queries `messages WHERE ts > agents.last_seq AND (to_agent = :id OR to_agent = 'all')` and replays the gap in chronological order before resuming live fan-out.

Non-persisted types (`ping`, `pong`, `typing`, `ack`, `heartbeat`, `floor_request`, `floor_grant`, `floor_deny`, `floor_free`, `summary_request`) never touch SQLite — they are pure transport. Dropping them on broker restart is intentional; agents recover their floor/typing/heartbeat state on next message cycle.

## Floor state machine (formal)

```
states:    FREE | HELD<agentId>
events:    floor_request, chat, deregister, timeout, priority_message

FREE + floor_request(A)      → HELD<A>; emit floor_grant→A; arm 30s timer
FREE + floor_request(B)      → (race lost — only happens if B requests
                                between A's grant and chat persist;
                                broker serializes in handleMessage, so
                                second request gets floor_deny→B)
HELD<A> + floor_request(B)   → emit floor_deny→B
HELD<A> + chat(A)            → persist + fan-out; disarm timer;
                                FREE; emit floor_free→global
HELD<A> + chat(B)            → drop + log incident (B is impersonating)
HELD<A> + deregister(A)      → disarm timer; FREE; emit floor_free→global
HELD<A> + timeout            → disarm; FREE; emit floor_free→global;
                                persist incident row (`type: 'status'`,
                                body: "floor auto-released after 30s")
*       + priority_message   → bypass; persist + fan-out; if HELD<X>,
                                disarm timer; FREE; emit floor_free→global
```

The broker serializes inbound messages per WebSocket (Bun's `message` callback is single-threaded per ws). Cross-ws ordering between two simultaneous `floor_request`s is whatever the event loop delivers first; the first one wins, the second gets `floor_deny`. There is no fairness queue; a sender losing a race retries after 2s (configurable in `bridge.config.ts → floor.retryMs`).

## Typing indicator protocol

IRCv3-style ephemeral indicator. States: `active`, `paused`, `done`. Throttle rules (enforced client-side in `src/client/ws-client.ts` and TTL-policed server-side in `presence.ts`):

- Send `active` when composing starts. No re-send of `active` within 3s.
- Send `paused` when composing pauses but no message has been sent.
- Send `done` when the message ships or composing is cancelled.
- Server clears the indicator if no `active` arrives for 6s, or no update for 30s after `paused`.
- Server clears the indicator immediately on `done` or on agent disconnect.

The 5-second TTL sweep in the broker prevents the "stuck typing forever" class of bugs (weechat issue #1718 is the reference case).

## Heartbeat + presence

Agent sends `heartbeat` every 10s. Broker updates `agents.last_seen = now()` and `agents.state = 'online'`, and resets the per-agent TTL timer. If three consecutive heartbeats are missed (TTL > 30s), the broker marks the agent `offline`, releases the floor if held, clears any active typing indicator, broadcasts a presence-change as a `status` message, and persists a `status`-type row for the audit trail.

`idle` state fires after 2 minutes (`presence.idleAfterMs`) without any non-heartbeat message from the agent — i.e. the agent is alive but quiet. `idle → online` happens on the next non-heartbeat message.

## Hook contract (HTTP, port 4701)

The PowerShell hooks under `hooks/` are the only external HTTP callers in normal operation. Contract:

```
GET  /api/messages/queued?agent=<id>
  → 200 BridgeMessage[]   (undelivered, priority-sorted first, then ts asc)

POST /api/messages/mark-delivered
  body: { agent: string, ids: string[] }
  → 200 { ok: true, count: <n> }

GET  /api/summary?n=50&agent=<id>
  → 200 { markdown: string, range: { from: <id>, to: <id> } }
```

The `Stop` hook calls `queued` then `mark-delivered` atomically. The `SessionStart` hook calls `summary` once at session open. The `UserPromptSubmit` hook re-calls `queued` so a fresh human prompt can interleave with pending Bridge messages on the same turn.

All three hooks must `exit 0` even on Bridge unreachable — fail-open is the rule, because a hook failure surfaces as a Claude Code error to the user. Broker outages must not break agent sessions; they only block message delivery, which the next turn will retry.
