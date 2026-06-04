# Bridge

**Sovereign multi-agent chat broker.** Future @I LLC.

Bridge is a self-hosted message coordination plane for Claude Code agents, Claude Desktop, and human supervisors. Multiple AI agents — each tied to a project directory — register, exchange typed messages, ask each other questions, share status, and persist full chat history across sessions. Zero cloud, zero third-party services, loopback only (`127.0.0.1`).

**Status:** v0.1.0 — Phases 1–6 complete (broker, store, protocol, dashboard, Ink TUI, MCP server, Claude Code hooks, NSSM packaging, integration tests).

---

## Architecture

| Component | Path | Listens / runs on |
| --- | --- | --- |
| Broker (WS + HTTP) | `src/server/broker.ts` | `127.0.0.1:4700` (WS), `127.0.0.1:4701` (HTTP) |
| SQLite store | `src/server/store.ts` | `data/bridge.sqlite` (WAL, FTS5) |
| Protocol | `src/server/protocol.ts` | Zod-validated `BridgeMessage` envelope, 17 typed kinds |
| Ink TUI | `src/client/tui.tsx` | PowerShell terminal, per-`BRIDGE_AGENT_ID` |
| Dashboard | `src/dashboard/` | `http://127.0.0.1:4701/dashboard` |
| MCP server | `src/mcp/bridge-mcp.ts` | stdio MCP — 5 tools: `bridge_send`, `bridge_read`, `bridge_history`, `bridge_agents`, `bridge_summary` |
| Hooks | `hooks/*.ps1` | `SessionStart`, `Stop`, `UserPromptSubmit` for Claude Code |
| NSSM service | `scripts/install-service.ps1` | Windows service `Bridge`, autostart |

The broker is the only writer to SQLite. All clients (TUI, MCP, dashboard) talk through the broker, never to the database directly.

---

## Prerequisites

- **Bun 1.3+** on Windows (PowerShell). The broker uses `bun:sqlite` and `Bun.serve`.
- **NSSM** on `PATH` if you want Bridge installed as a Windows service (`scripts/install-service.ps1`).
- Claude Code or Claude Desktop, if you want MCP integration.

---

## Install

```powershell
cd Z:\FutureApps\universal_tools\tools\Bridge

# 1. Install dependencies (lockfile-pinned, no network at runtime).
bun install

# 2. (Optional, recommended) install as a Windows service. Run elevated.
#    Mirrors the ADBPD NSSM pattern; idempotent.
scripts\install-service.ps1

# 3. Wire MCP for each Bridge-aware project (AegisRx, ADBPD, future apps).
#    Idempotent: skips if the .mcp.json already matches the template.
scripts\install-mcp.ps1

# 4. Open Isko's supervisor dashboard.
Start-Process http://127.0.0.1:4701/dashboard
```

If you skipped step 2, run the broker in the foreground for dev:

```powershell
bun run start:broker
```

Confirm health:

```powershell
Invoke-RestMethod http://127.0.0.1:4701/health
# -> { status: "ok", uptime: <sec>, connectedAgents: <n>, version: "0.1.0" }
```

---

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `BRIDGE_LOG_LEVEL` | `info` | pino level for the broker (`trace`/`debug`/`info`/`warn`/`error`/`silent`). |
| `BRIDGE_ISKO_TOKEN` | _(none)_ | Bearer token required for `POST /api/inject` and `DELETE /api/floor`. If unset, both endpoints return **503 `inject_disabled_no_token_configured`** — supervisor controls are locked down by default. |
| `BRIDGE_AGENT_ID` | _(required)_ | Agent identity used by `bridge-mcp.ts` and `tui.tsx` when connecting. Set per project in the project's `.mcp.json`. |
| `BRIDGE_WS_URL` | `ws://127.0.0.1:4700` | WebSocket URL the MCP server / TUI dials. |
| `BRIDGE_HTTP_URL` | `http://127.0.0.1:4701` | HTTP URL used for summary + agents lookups. |

---

## Docs

Long-form documentation lives under `docs/`, mirroring the ADBPD structure:

- [`docs/01-overview.md`](docs/01-overview.md) — what Bridge is, who it's for, what it is not
- [`docs/02-architecture.md`](docs/02-architecture.md) — components, ports, message flow
- [`docs/03-protocol.md`](docs/03-protocol.md) — the 17 `BridgeMessage` types, persistence rules, floor control
- [`docs/04-disaster-recovery.md`](docs/04-disaster-recovery.md) — reset playbook, port conflicts, NSSM gotchas
- [`docs/05-operations.md`](docs/05-operations.md) — day-2 ops, log rotation, soak tests, backups

Both blueprints (`BLUEPRINTS/Bridge_Blueprint_1_Server_Core.md`, `BLUEPRINTS/Bridge_Blueprint_2_Integration_Layer.md`) remain the contract source-of-truth.

---

## Hard rules (inherited from ADBPD)

- **127.0.0.1 only.** No cloud deps. Loopback bind on every socket.
- **TypeScript strict.** No `any` without a one-line justification comment.
- **Stable releases only.** No alpha/beta/rc per Law 11.
- **SQLite = `bun:sqlite`** (built-in), not `better-sqlite3`.
- **Logging** is structured `pino` to `logs/`. No `console.log` in production paths.
- **Exception:** `src/mcp/bridge-mcp.ts` uses `console.error` for debug; stdout is reserved for stdio JSON-RPC.
- **Health endpoint shape:** `{ status, uptime, connectedAgents, version }` — mirrors ADBPD's `/health`.

---

## License

Pending owner decision (HANDOFF.md open question #1: MIT vs. Future ATI proprietary). The repository is shipped `UNLICENSED` in `package.json` until that decision lands; treat all code as © Future @I LLC, all rights reserved, internal use only.

---

## Known follow-ups (v0.2.0)

- **LLM-generated summaries.** `reduceToMarkdown()` in `src/server/broker.ts` is a deterministic markdown reduction. Owner standard is on-device Gemma 4 E4B for narrative summaries; the deterministic path will remain as a fallback when the model is not loaded.
- **Force-release-floor endpoint.** Implemented as `DELETE /api/floor` (Isko-token-gated). The dashboard does not yet expose a button for it — wire it from `src/dashboard/dashboard.js` when convenient.
- **Soak test.** `scripts/soak.ts` not yet written. Owner's ship-gate item — 4h continuous run with 10k+ messages, zero data loss — must run before tagging `v1.0.0`.
- **HANDOFF open questions 2–4** (CLI access for non-registered processes, retention policy, summary backend) remain owner-pending.
