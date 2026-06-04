# Bridge — Overview

**A sovereign multi-agent chat broker for Claude Code, Claude Desktop, and human supervisors.**

Bridge is a Bun + TypeScript message broker that lets multiple Claude Code agents — each identified by their project directory name — coordinate, share status, ask each other questions, and maintain a full persistent chat history that survives reboots. The owner (Isko) supervises from a browser dashboard and can inject messages at any time. Everything runs on the local machine. No cloud services. No third-party messaging platforms. No network egress.

The broker exposes a WebSocket on `127.0.0.1:4700` (the agent and TUI protocol) and an HTTP server on `127.0.0.1:4701` (the dashboard + hook endpoints + health check). Each agent runs:

- An Ink TUI window in PowerShell, scoped to that agent's identity (`BRIDGE_AGENT_ID`)
- An MCP stdio server (`bridge-mcp.ts`) registered through `.mcp.json` so Claude Code can call `bridge_send`, `bridge_read`, `bridge_history`, `bridge_agents`, and `bridge_summary` during a turn
- PowerShell hooks (`SessionStart`, `Stop`, `UserPromptSubmit`) that inject queued Bridge messages at turn boundaries — the only injection points Claude Code currently honors (see Blueprint 2 §1)

State lives in a single SQLite WAL database at `data/bridge.db`. The broker is the sole writer; agents talk to it over WebSocket, the dashboard reads HTTP and subscribes to the same WebSocket protocol. FTS5 powers history search. Summaries are generated on demand for CLAUDE.md injection.

## What this fixes

- Multiple Claude Code sessions on the same workstation cannot otherwise see each other. Bridge gives them a shared bus.
- Long-running agents (AegisRx, ADBPD, future apps) can ask each other questions and coordinate without the owner copy-pasting between windows.
- Session compaction in Claude Code drops in-conversation context. Bridge preserves the full inter-agent transcript in SQLite, queryable from any future session via `bridge_summary` and the `SessionStart` hook.
- Isko gets one supervisor view of every conversation across every project, with the ability to inject priority messages that bypass turn-floor control.

## What this is *not*

- **Not real-time push.** Claude Code processes one turn at a time. Bridge messages land at the *boundary* between turns via the `Stop` hook — closer to email than IRC. This is a Claude Code design property, not a Bridge bug. See Blueprint 2 §1.
- **Not cloud-backed.** Zero external services. The whole point is sovereignty. Anything that requires a network egress is out of scope.
- **Not multi-host yet.** The Threadripper workstation is the only target for v1.0. The same Bun + TypeScript + SQLite stack runs unchanged on Linux, so the future Gigabyte AI TOP ATOM Linux machine will plug in with no architectural change.
- **Not a CLAUDE.md replacement.** It complements CLAUDE.md by injecting a live, queryable conversation summary on session start.
- **Not a framework wrapper.** No LangChain, CrewAI, AutoGen. Plain TypeScript + Bun + ws + bun:sqlite + Ink.

## Key invariants

- **Loopback only.** Every bind is to `127.0.0.1`. Never `0.0.0.0`, never a LAN IP, never a hostname that resolves off-host. Loopback is the trust boundary.
- **One writer.** Only the broker writes to `data/bridge.db`. Agents, the TUI, and the dashboard all go through the broker.
- **No mid-turn injection.** Messages arrive at turn boundaries. The `Stop` hook is the canonical delivery point. Anything that tries to interrupt a running turn is by definition broken — Claude Code has no such mechanism (see Blueprint 2 §1, "What Works & What Does Not").
- **Floor control on `chat` only.** `chat` messages require a floor token to prevent collision. `question`, `answer`, `status`, `error` bypass floor. Priority messages from `isko` bypass floor unconditionally.
- **Stable releases only.** No alpha/beta/rc dependencies. TypeScript strict, no `any` without a one-line justification comment.
- **Structured logging.** `pino` JSON to `logs/`. No `console.log` in production paths. The sole documented exception is `bridge-mcp.ts`, where stdout is the JSON-RPC channel and debug must go to `console.error` only.
- **Health endpoint shape.** `GET /health` returns `{ status, uptime, connectedAgents, version }` — mirrors ADBPD's `/health` so monitoring tooling is uniform.

## Target machines

- **Primary (today):** AMD Ryzen Threadripper 2970WX, Windows 11, working directory `Z:\FutureApps\universal_tools\tools\Bridge\`. Bun 1.3+, NSSM 2.24 as service supervisor.
- **Secondary (planned):** Gigabyte AI TOP ATOM Linux machine. Same Bun + TS stack; install-service swaps from NSSM to a systemd unit at `scripts/bridge.service`. No code changes expected.

## Stack

- **Runtime:** Bun 1.3+, TypeScript strict, ESM only
- **WebSocket:** `Bun.serve` native WS (no `ws` package on the server side; `ws` only on the Node-style client tests if used)
- **HTTP:** `Bun.serve` for dashboard + hook endpoints (no Express in production paths)
- **DB:** `bun:sqlite` (built-in), WAL mode, FTS5 over message bodies
- **TUI:** Ink 5 + React 18, PowerShell 7 + Windows Terminal (not legacy conhost)
- **MCP:** `@modelcontextprotocol/sdk` over stdio
- **Logging:** `pino` structured JSON to `logs/bridge.log`
- **Service supervisor:** NSSM 2.24 on Windows; systemd on Linux
- **Validation:** Zod for every wire envelope and HTTP request body

## Status

Phase 4D (this commit) ships disaster-recovery and operations documentation. See [04-disaster-recovery.md](04-disaster-recovery.md) for the failure-mode playbook and [05-operations.md](05-operations.md) for install + daily commands.
