# `bridge` branch — purpose

This branch is **NOT** ADBPD code. It exists only to host the coder handoff for a sister project called **Bridge** — a sovereign multi-agent chat broker for Future @I LLC.

## What this branch contains

- `bridge/HANDOFF.md` — implementation prompt for the coder (5 Sonnet 4.6 + 1 Opus 4.6 agent budget, 10-phase build order, hard rules, ship-gate definition)
- `bridge/BLUEPRINTS/Bridge_Blueprint_1_Server_Core.docx` — broker, store, protocol, TUI, dashboard, NSSM service
- `bridge/BLUEPRINTS/Bridge_Blueprint_2_Integration_Layer.docx` — MCP server, Claude Code hooks, registration

## Where the actual Bridge code lives

`Z:\FutureApps\universal_tools\tools\Bridge\` — separate project root. The coder reads the handoff + blueprints from this branch, then builds the code at the Z: path. Bridge will eventually get its own git repo; until then, this branch is the canonical handoff location.

## Why it's here and not in its own repo

The ADBPD coder is the right person to build Bridge (shared conventions: Bun + TypeScript, NSSM Windows service pattern, sovereign on-device daemon style, `/health` endpoint shape, reset-script disaster-recovery pattern). Co-locating the handoff in ADBPD's repo keeps it in the same coder's working tree without spinning up a separate repo for what is at this point only design artifacts.

## Rules

- **DO NOT merge this branch to master.** Master is the ADBPD product line.
- **DO NOT add Bridge source code here.** Source code lives at `Z:\FutureApps\universal_tools\tools\Bridge\`. This branch is design artifacts only.
- **DO update this branch** if the blueprints get revised or the handoff scope changes.
- Once Bridge has its own published repo (e.g. `fpresiado/bridge` or kept private), this branch can be archived.

## Related

- ADBPD product line: `master` branch (this repo).
- Bridge conventions: mirror ADBPD's `docs/` structure, NSSM service install pattern, reset-script disaster-recovery pattern.
- The coder building Bridge should also keep ADBPD's `scripts/reset-adbpd.ps1` in mind as the model for `scripts/reset-bridge.ps1`.
