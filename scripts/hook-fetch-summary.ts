// hook-fetch-summary.ts: print Markdown summary from broker /api/summary.
// Called from hooks/session-start.ps1. Silent no-op on broker-unreachable.
//
// Usage: bun run scripts/hook-fetch-summary.ts [--n 50] [--http http://127.0.0.1:4701]
//
// Exit codes:
//   0 — success OR broker unreachable (fail-open by design — never break a session)
//   2 — invalid CLI args

export {};

const args = process.argv.slice(2);
let n = 50;
let httpBase = process.env.BRIDGE_HTTP_URL ?? "http://127.0.0.1:4701";

for (let i = 0; i < args.length; i += 1) {
  const a = args[i];
  if (a === "--n" && i + 1 < args.length) {
    const next = args[i + 1];
    if (next === undefined) {
      console.error("--n requires a value");
      process.exit(2);
    }
    const parsed = Number.parseInt(next, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      console.error(`--n must be a positive integer, got ${next}`);
      process.exit(2);
    }
    n = parsed;
    i += 1;
  } else if (a === "--http" && i + 1 < args.length) {
    const next = args[i + 1];
    if (next === undefined) {
      console.error("--http requires a value");
      process.exit(2);
    }
    httpBase = next;
    i += 1;
  }
}

const url = `${httpBase}/api/summary?n=${n}`;

try {
  // 5s timeout so a hung broker can't stall session start.
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 5000);
  const resp = await fetch(url, { signal: ctrl.signal });
  clearTimeout(t);
  if (!resp.ok) {
    // Fail-open: emit empty placeholder so PowerShell wrapper still produces clean output.
    process.stdout.write("");
    process.exit(0);
  }
  // any: external JSON shape — we only read .markdown defensively.
  const body = (await resp.json()) as { markdown?: unknown };
  const md = typeof body.markdown === "string" ? body.markdown : "";
  process.stdout.write(md);
  process.exit(0);
} catch {
  // Broker unreachable — silent no-op.
  process.stdout.write("");
  process.exit(0);
}
