# Bridge — Known issues

## v0.2 — MCP `bridge_send` does not surface broker rejection

**Severity:** Real bug, blocking end-to-end chat-via-MCP.
**Discovered:** 2026-06-04 during live bidirectional proof with aegis_agent.
**Symptom:** Calling `bridge_send` from an agent's MCP tool with `type: "chat"` returns a successful-looking `{ id, ts }` payload, but the message is silently dropped by the broker and never persisted to SQLite.

**Root cause:** Two issues compound:

1. **MCP generates id locally, doesn't await broker.** `src/mcp/bridge-mcp.ts` builds the message envelope, generates a UUID, and writes it to the WebSocket. It then immediately returns `{ id, ts }` from the tool call without waiting for any acknowledgement frame from the broker. So the caller can't distinguish "broker accepted" from "broker errored".
2. **Broker silently drops non-priority chat without floor.** `src/server/broker.ts:415-421` correctly enforces blueprint §3.3 ("chat from non-holder → error frame, do not forward, do not persist"). It sends a `chat_without_floor` error frame back over WS. But the MCP server doesn't subscribe to inbound error frames and doesn't propagate them to the caller.

**Fix plan (v0.2):**

- A) `bridge_send` for `type: "chat"` should auto-acquire floor first: send `floor_request`, await `floor_grant` (or `floor_deny` with retry/timeout), then send the chat. Floor is a server-side invariant; MCP is the right layer to satisfy it transparently for agents.
- B) Independently, `bridge_send` should await a broker ack/error envelope addressed to the sender within a short window (e.g. 2s) and return that to the tool caller. If the broker errored, the tool result should be an error, not a fake success.
- C) Add a unit test in `tests/mcp.test.ts` that asserts: `bridge_send(type: "chat")` against a broker with floor held by another agent surfaces an error to the tool caller (not a fake `{ id, ts }` success).

**Workaround until fixed:** agents can use `type: "status"` (bypasses floor, persists) for cross-agent notifications, or `isko` can use `/api/inject` with priority=true for supervisor messages.

---

## v0.2 — Install script can't tighten ACL on `data/isko.token`

**Severity:** Security gap, not blocker.
**Discovered:** 2026-06-04 during `install-service.ps1` run.
**Symptom:** `install-service.ps1` emits `[WARN] could not tighten ACL on ...isko.token (Get-Acl command was found in the module 'Microsoft.PowerShell.Security', but the module could not be loaded.)`. Token file is created but inherits default directory ACLs.

**Fix plan (v0.2):** replace `Get-Acl` / `Set-Acl` with `icacls` calls — `icacls` is a Win32 binary, not a PS module, and works in any host even when module autoload is broken. Pattern:
```powershell
icacls $tokenPath /inheritance:r
icacls $tokenPath /grant:r "$env:USERNAME:(F)"
```

**Workaround until fixed:** don't put the token in places unprivileged readers can see (the directory's default ACL is usually adequate for single-user workstations).

---

## v0.2 — `/api/messages?limit=...` capped at 1000

**Severity:** Minor — affects external clients (soak harness) but not normal use.
**Symptom:** `GET /api/messages?since=<ts>&limit=100000` returns at most 1000 rows. The soak harness's per-checkpoint persistence validator reported `persisted=1000` for all 24 checkpoints during the 4h soak. True row count was verified directly via SQLite: 57,973.

**Fix plan (v0.2):** lift the cap to a higher hard ceiling (10,000) and let the client paginate via `since=<lastTs>` if it really wants more. Or expose a `/api/messages/count?since=<ts>` summary endpoint that doesn't return rows.

**Workaround until fixed:** clients that need a true count should query SQLite directly with `SELECT COUNT(*) FROM messages WHERE ts >= ?`.
