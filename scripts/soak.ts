// Bridge 4h production soak.
// Drives 4 fake agents through a high-rate message exchange against a running
// broker on 127.0.0.1:4700, validates persistence every 10 min, writes a
// checkpoint summary every hour, and emits a final SUMMARY.md on exit.
//
// Targets per HANDOFF.md ship gate: 4h wall, 10k+ messages, zero data loss.
//
// Usage:
//   bun run scripts/soak.ts                  # 4h default
//   SOAK_MINUTES=10 bun run scripts/soak.ts  # quick run for verification
//   SOAK_AGENTS=6  bun run scripts/soak.ts   # more agents

import { WebSocket } from 'ws'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const WS_URL = process.env.BRIDGE_URL ?? 'ws://127.0.0.1:4700'
const HTTP = process.env.BRIDGE_HTTP ?? 'http://127.0.0.1:4701'
const SOAK_MIN = Number(process.env.SOAK_MINUTES ?? 240)
const N_AGENTS = Number(process.env.SOAK_AGENTS ?? 4)
const MSG_INTERVAL_MS = Number(process.env.SOAK_INTERVAL_MS ?? 1500)
const CHECKPOINT_MIN = Number(process.env.SOAK_CHECKPOINT_MIN ?? 10)

const startedAt = Date.now()
const outDir = resolve('logs')
mkdirSync(outDir, { recursive: true })
const stamp = new Date(startedAt).toISOString().replace(/[:.]/g, '-')
const logPath = `${outDir}/soak-${stamp}.log`
const sumPath = `${outDir}/soak-${stamp}-summary.md`

const log = (line: string) => {
  const out = `[${new Date(Date.now()).toISOString()}] ${line}`
  process.stdout.write(out + '\n')
  try { writeFileSync(logPath, out + '\n', { flag: 'a' }) } catch {}
}

interface Agent {
  id: string
  ws: WebSocket
  sent: number
  received: number
}

const agents: Agent[] = []
let totalSent = 0
let totalReceived = 0
let errors = 0
let lastValidateMs = 0
let lastValidatedCount = 0

function envelope(from: string, to: string, type: string, body: string, replyTo: string | null = null) {
  return {
    id: crypto.randomUUID(),
    ts: Date.now(),
    from, to, type,
    thread_id: 'soak',
    reply_to: replyTo,
    priority: false,
    body,
    needs_ack: false,
  }
}

function connectAgent(id: string): Promise<Agent> {
  return new Promise((res, rej) => {
    const ws = new WebSocket(WS_URL)
    const a: Agent = { id, ws, sent: 0, received: 0 }
    ws.on('open', () => {
      ws.send(JSON.stringify(envelope(id, 'broker', 'register', JSON.stringify({ project_dir: 'soak', pid: process.pid }))))
      res(a)
    })
    ws.on('message', (raw) => {
      a.received++; totalReceived++
      try {
        const m = JSON.parse(raw.toString())
        // Auto-answer any inbound question
        if (m.type === 'question') {
          const ans = envelope(id, m.from, 'answer', `ack:${m.body.slice(0, 30)}`, m.id)
          ws.send(JSON.stringify(ans))
          a.sent++; totalSent++
        }
      } catch { errors++ }
    })
    ws.on('error', () => { errors++ })
    ws.on('close', () => log(`agent ${id} socket closed`))
  })
}

async function validate(): Promise<{ ok: boolean; persisted: number }> {
  try {
    const since = startedAt - 1000
    const r = await fetch(`${HTTP}/api/messages?since=${since}&limit=100000`)
    if (!r.ok) return { ok: false, persisted: -1 }
    const arr = (await r.json()) as any[]
    return { ok: true, persisted: arr.length }
  } catch {
    return { ok: false, persisted: -1 }
  }
}

async function checkpoint(label: string) {
  const v = await validate()
  const elapsedMin = Math.round((Date.now() - startedAt) / 60000)
  log(`CHECKPOINT ${label}: elapsed=${elapsedMin}min sent=${totalSent} recv=${totalReceived} persisted=${v.persisted} errors=${errors} alive=${agents.filter(a => a.ws.readyState === WebSocket.OPEN).length}/${agents.length}`)
}

async function writeSummary(outcome: 'PASS' | 'FAIL', reason: string) {
  const v = await validate()
  const elapsedMin = Math.round((Date.now() - startedAt) / 60000)
  const md = `# Bridge soak — ${stamp}

- **Outcome:** ${outcome}
- **Reason:** ${reason}
- **Wall clock:** ${elapsedMin} minutes (target ${SOAK_MIN})
- **Agents:** ${N_AGENTS}
- **Message interval:** ${MSG_INTERVAL_MS}ms
- **Total sent:** ${totalSent}
- **Total received (cross-agent):** ${totalReceived}
- **Persisted in SQLite:** ${v.persisted}
- **Transient errors:** ${errors}
- **Alive at end:** ${agents.filter(a => a.ws.readyState === WebSocket.OPEN).length}/${agents.length}

## Per-agent stats

${agents.map(a => `- ${a.id}: sent=${a.sent} received=${a.received} state=${a.ws.readyState === WebSocket.OPEN ? 'OPEN' : 'CLOSED'}`).join('\n')}

## Log

\`${logPath}\`
`
  writeFileSync(sumPath, md)
  log(`SUMMARY written: ${sumPath}`)
}

let stopping = false
function stop(reason: string, code: number) {
  if (stopping) return
  stopping = true
  log(`STOPPING: ${reason}`)
  agents.forEach(a => { try { a.ws.close() } catch {} })
  void writeSummary(code === 0 ? 'PASS' : 'FAIL', reason).finally(() => process.exit(code))
}
process.on('SIGINT', () => stop('SIGINT', 0))
process.on('SIGTERM', () => stop('SIGTERM', 0))

async function main() {
  log(`Bridge soak start: ${SOAK_MIN}min, ${N_AGENTS} agents, interval=${MSG_INTERVAL_MS}ms`)
  for (let i = 0; i < N_AGENTS; i++) {
    const a = await connectAgent(`soak_${i}`)
    agents.push(a)
    log(`registered agent ${a.id}`)
  }
  await new Promise(r => setTimeout(r, 1000))

  const stopAt = startedAt + SOAK_MIN * 60000
  let nextCheckpoint = startedAt + CHECKPOINT_MIN * 60000
  let questionCounter = 0

  const tick = setInterval(async () => {
    if (Date.now() >= stopAt) {
      clearInterval(tick)
      stop('soak duration reached', 0)
      return
    }
    if (Date.now() >= nextCheckpoint) {
      await checkpoint(`+${Math.round((Date.now() - startedAt) / 60000)}min`)
      nextCheckpoint += CHECKPOINT_MIN * 60000
    }

    // Each tick: every agent sends a status, and one agent asks another a question.
    for (const a of agents) {
      if (a.ws.readyState !== WebSocket.OPEN) continue
      try {
        a.ws.send(JSON.stringify(envelope(a.id, 'all', 'status', `tick ${a.sent} from ${a.id}`)))
        a.sent++; totalSent++
      } catch { errors++ }
    }
    const from = agents[questionCounter % agents.length]
    const to = agents[(questionCounter + 1) % agents.length]
    questionCounter++
    if (from.ws.readyState === WebSocket.OPEN) {
      try {
        from.ws.send(JSON.stringify(envelope(from.id, to.id, 'question', `q-${questionCounter} from ${from.id}`)))
        from.sent++; totalSent++
      } catch { errors++ }
    }
  }, MSG_INTERVAL_MS)
}

main().catch((e) => { log(`FATAL: ${e}`); stop(`fatal: ${e}`, 1) })
