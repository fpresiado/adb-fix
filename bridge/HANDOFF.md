# Bridge — Sovereign Multi-Agent Chat System — Coder Handoff

**Owner:** Francisco Ricardo Preciado Jr (Future @I LLC, "Isko")
**Date opened:** 2026-06-03
**Repo:** new project — fresh git repo to be initialized at this location
**Project root:** `Z:\FutureApps\universal_tools\tools\Bridge\`
**Blueprints:** `Z:\FutureApps\universal_tools\tools\Bridge\BLUEPRINTS\` — two `.docx` files (Server Core + Integration Layer). **READ BOTH FRONT TO BACK BEFORE WRITING CODE.**

---

## Resource budget

You have **5 Sonnet 4.6 agents + 1 Opus 4.6 agent**. Use them like this:

- **Sonnet 4.6 ×5** — parallel implementation of independent modules (broker, store, protocol, TUI, dashboard, hooks, packaging). Mechanical TypeScript implementation against detailed blueprint specs. Each agent owns a module end-to-end including its unit tests.
- **Opus 4.6 ×1** — reserve for COMPLEX work only:
  1. Floor-control + turn-token state machine in `broker.ts` (concurrency edges, timeout semantics, deadlock prevention)
  2. MCP stdio server (`bridge-mcp.ts`) — stdout/stderr discipline, WebSocket reconnect, race condition on initial register vs first `bridge_send`
  3. Claude Code hooks integration & lifecycle (`SessionStart`, `Stop`, `UserPromptSubmit`) — the documented edge cases in Blueprint 2 §1 ("What Works & What Does Not") are non-obvious
  4. Final security review + threat model: anyone with localhost access can speak as any agent — is that acceptable for owner? document trade-offs explicitly.

Do NOT spend Opus tokens on Ink layout, HTML/CSS for the dashboard, SQL DDL, or unit-test scaffolding. Those are pure Sonnet work.

---

## Why this project exists

Owner has multiple Claude Code sessions running across multiple projects on the same Threadripper workstation (AegisRx, ADBPD, future apps). Today they have **no way to talk to each other** — each session is its own process with its own context. Bridge is the sovereign coordination plane:

- AI agents register, send/receive messages, ask each other questions, share status, request summaries
- Isko (the human owner, identified as `isko` in the system) supervises from a browser dashboard, can inject messages, can override floor control
- Everything persists to local SQLite — survives reboots, no cloud, no third-party services
- Architecture extends cleanly to the future Gigabyte AI TOP ATOM Linux machine with zero changes (same Bun + TS + WS + SQLite stack works there)

**Constraint owner cares about (Blueprint 2 §1):** Claude Code processes one turn at a time. Mid-turn interruption is impossible. Bridge delivers messages at TURN BOUNDARIES via hooks. This is documented and expected — don't try to make it real-time push.

---

## What's in scope for v1.0

Blueprint 1 + Blueprint 2 in full. Treat the docx files as the contract — every component, port, protocol type, MCP tool, hook, registration path. Do not invent features. Do not skip pieces. If the blueprint says "Ink TUI" you build an Ink TUI, not a generic terminal print loop.

### Build order (recommended phase sequence)

1. **Phase 1 — Repo + tooling** (Sonnet, 30 min)
   - `bun init`, `tsconfig.json` (strict), Zod, `@modelcontextprotocol/sdk`, `ink`, `react`, `ws`, `better-sqlite3` (or `bun:sqlite`)
   - `.gitignore`, `README.md` shell, `LICENSE` (MIT or Future ATI proprietary — confirm with owner)
   - `package.json` scripts: `dev`, `build`, `test`, `lint`, `start:broker`, `start:tui`, `start:dashboard`
   - Create directory tree per Blueprint 1 §2.1

2. **Phase 2 — SQLite store** (Sonnet, parallel) — `src/server/store.ts`
   - Tables per blueprint: `messages`, `agents`, `threads`, `summaries`, `cursors`
   - WAL mode, FTS5 search on `messages.body`
   - Idempotent migrations
   - Unit tests for every CRUD path

3. **Phase 3 — Protocol layer** (Sonnet, parallel) — `src/server/protocol.ts`
   - Zod schemas for `BridgeMessage` envelope + all 16 message types from Blueprint 1 §3.2
   - Encoder/decoder/validator helpers
   - 100% type coverage

4. **Phase 4 — Broker server** (Opus, gates parallel work) — `src/server/broker.ts`
   - WS :4700, HTTP :4701
   - Floor controller state machine (Blueprint 1 §3.3)
   - Presence/heartbeat (10s TTL, 3-miss = offline)
   - Message routing: direct (`to: "agentId"`), broadcast (`to: "all"`), reply linking
   - Priority-bypass for `from: "isko"`
   - All messages persisted via store layer
   - **This is the Opus gate before any client work.**

5. **Phase 5 — Ink TUI** (Sonnet, parallel) — `src/client/tui.tsx`
   - PowerShell-native terminal chat window
   - Per-agent identity from `BRIDGE_AGENT_ID` env
   - Live message stream, typing indicators, presence list
   - Compose box + floor request flow

6. **Phase 6 — HTML dashboard** (Sonnet, parallel) — `src/dashboard/`
   - Browser view at `http://127.0.0.1:4701/dashboard`
   - Isko's supervisor seat: see all messages across all threads, inject messages, kick agents, force-release floor
   - Plain HTML+CSS+vanilla JS; no React/Vue/build pipeline unless blueprint requires

7. **Phase 7 — MCP server** (Opus, complex) — `src/mcp/bridge-mcp.ts`
   - stdio transport — **NEVER `console.log` to stdout** (Blueprint 2 §2)
   - 5 tools: `bridge_send`, `bridge_read`, `bridge_history`, `bridge_agents`, `bridge_summary`
   - WS reconnect with 3s backoff
   - Heartbeat every 10s
   - Message queue drains on `bridge_read` call

8. **Phase 8 — Claude Code hooks** (Opus, complex) — `hooks/`
   - `SessionStart` hook — inject Bridge history summary
   - `Stop` hook — inject queued messages at turn boundary
   - `UserPromptSubmit` hook — inject pending messages when human types
   - Per Blueprint 2 §1: these are the ONLY working injection points. Do NOT attempt FileChanged hook or MCP-triggered `additionalContext`.

9. **Phase 9 — NSSM Windows service** (Sonnet) — `scripts/install-service.ps1`
   - Mirror ADBPD's pattern (`M:\FutureApps\adb-proxy-daemon\scripts\install-service.ps1`) — but be aware of the NSSM handle-inheritance gap documented there. If port 4700 ever exhibits a zombie-listener pattern, ADBPD has the diagnostic playbook (`scripts/reset-adbpd.ps1`).

10. **Phase 10 — Per-project registration files** (Sonnet) — generate `.mcp.json` for each project that should be Bridge-aware:
    - `P:\futureapps\AegisRx\kage_src\.mcp.json` → `aegis_agent`
    - `M:\FutureApps\adb-proxy-daemon\.mcp.json` → `adbpd_agent`
    - `%APPDATA%\Claude\claude_desktop_config.json` → `isko`
    - Future apps: agent ID = project directory name, registered the same way

---

## Hard rules — do not violate

- **NEVER** add cloud dependencies. No HTTPS to external services. Bridge is sovereign — fully on-device. The whole point.
- **NEVER** use `console.log()` inside `bridge-mcp.ts`. stdio MCP rule. Use `console.error()` for debug.
- **NEVER** invent message types. Only the 16 types from Blueprint 1 §3.2. If a new type is needed, ask owner before adding.
- **NEVER** allow non-floor-holding agents to send `chat` messages. `question`/`answer`/`status`/`error` bypass floor; `chat` does NOT.
- **NEVER** persist `ping`/`pong`/`typing`/`heartbeat`/`floor_request`/`floor_grant`/`floor_deny`/`ack`. Per blueprint §3.2 "Persisted" column.
- **NEVER** auto-restart Bridge mid-run if agents are connected. Use SCM/NSSM stop + restart with a 30s drain window for connected clients.
- **NEVER** open port 4700 or 4701 to anything other than `127.0.0.1`. Bind explicitly. Loopback only.
- **NEVER** ship without integration tests that prove: two agents register → exchange a question/answer → SQLite has both rows → dashboard sees the thread → SessionStart hook surfaces a summary.
- **NEVER** claim done without DONE PROOF: a recorded run showing (a) broker up via NSSM, (b) two TUI clients chatting, (c) dashboard showing the conversation, (d) a Claude Code SessionStart hook successfully injecting a history summary. Owner enforces COMPLETION_FRAUD_PREVENTION (see AegisRx CLAUDE.md).

---

## Conventions inherited from ADBPD

This is your sister project (same owner, same author, same machine). Mirror its conventions:

- **TypeScript strict.** No `any` without comment justification.
- **Stable-only deps.** No alpha/beta/rc per Law 11.
- **Logging:** structured (`pino`) to a `logs/` dir, never `console.log` in production paths.
- **Health endpoint:** `GET http://127.0.0.1:4701/health` → `{ status: "ok", uptime: <s>, connectedAgents: N }` (matches ADBPD `/health` style).
- **Disaster recovery doc:** ship `docs/04-disaster-recovery.md` from day 1 (mirror ADBPD's structure).
- **Reset script:** `scripts/reset-bridge.ps1` — same elevation gate + SCM-stop + force-kill + verify-port-free + restart pattern as `scripts/reset-adbpd.ps1`.
- **Soak test:** `scripts/soak.ts` — 4h production soak before declaring v1.0 shippable. Owner's standard.

---

## Definition of done — v1.0 ship gate

1. Both blueprints implemented in full. Every component, port, message type, MCP tool, hook.
2. NSSM service installed, `Get-Service Bridge` shows Running, auto-starts on boot.
3. `Invoke-RestMethod http://127.0.0.1:4701/health` returns `status=ok`.
4. 2+ Claude Code sessions can register, exchange messages, see each other in `bridge_agents`.
5. Isko's dashboard at `http://127.0.0.1:4701/dashboard` shows live messages, can inject.
6. SessionStart hook proven to inject summary into a fresh AegisRx Claude Code session.
7. 4-hour soak run with 10k+ messages and zero data loss.
8. Public README + 5 docs files matching ADBPD's structure.
9. Initial git tag `v1.0.0` after soak passes.
10. ADBPD `.mcp.json` written + Bridge tools callable from an ADBPD Claude Code session.

---

## Helpful starting commands

```powershell
# From an elevated PowerShell, after the repo is initialized:
cd Z:\FutureApps\universal_tools\tools\Bridge
bun install
bun run start:broker          # foreground for dev
bun run test                  # unit + integration

# Later, once NSSM service is installed:
Get-Service Bridge
Invoke-RestMethod http://127.0.0.1:4701/health
```

---

## Open questions to surface to owner (Isko) before shipping

1. License: MIT (mirror ADBPD public) or Future ATI proprietary (mirror AegisRx)?
2. Should Bridge expose its history to non-registered local processes (e.g. a `bridge query` CLI for shell scripts), or strictly to registered agents + dashboard?
3. Retention policy: keep all messages forever (SQLite WAL grows unbounded) or auto-prune after N days? Owner has multi-TB Z: drive so size isn't urgent, but worth pinning a policy.
4. Should `summary` generation use a local LLM (Gemma 4 E4B per kit standard) or a deterministic markdown reduction? Local LLM is heavier but produces better narrative; deterministic is instant and predictable.

---

Good luck. Ship clean.
