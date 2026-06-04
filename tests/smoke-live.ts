// Smoke test against a running broker on 127.0.0.1:4700.
// Drives ship-gate item: "2+ Claude Code sessions can register, exchange messages, see each other."

import { WebSocket } from 'ws'

const WS = 'ws://127.0.0.1:4700'
const HTTP = 'http://127.0.0.1:4701'

function connect(agentId: string, projectDir: string): Promise<{ ws: WebSocket; inbox: any[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS)
    const inbox: any[] = []
    ws.on('message', (data) => {
      try { inbox.push(JSON.parse(data.toString())) } catch {}
    })
    ws.on('open', () => {
      ws.send(JSON.stringify({
        id: crypto.randomUUID(),
        ts: Date.now(),
        from: agentId,
        to: 'broker',
        type: 'register',
        thread_id: 'system',
        reply_to: null,
        priority: false,
        body: JSON.stringify({ project_dir: projectDir, pid: process.pid }),
        needs_ack: false,
      }))
      resolve({ ws, inbox })
    })
    ws.on('error', reject)
  })
}

function send(ws: WebSocket, from: string, to: string, type: string, body: string, replyTo: string | null = null) {
  const id = crypto.randomUUID()
  ws.send(JSON.stringify({
    id, ts: Date.now(), from, to, type, thread_id: 'smoke',
    reply_to: replyTo, priority: false, body, needs_ack: false,
  }))
  return id
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main() {
  console.log('=== smoke: connect aegis + adbpd ===')
  const aegis = await connect('aegis_agent', 'AegisRx')
  const adbpd = await connect('adbpd_agent', 'adb-proxy-daemon')
  await sleep(500)

  console.log('=== aegis asks adbpd a question ===')
  const qId = send(aegis.ws, 'aegis_agent', 'adbpd_agent', 'question', 'Is port 5037 healthy?')
  await sleep(500)

  console.log(`adbpd inbox after question: ${adbpd.inbox.length} msgs`)
  const q = adbpd.inbox.find((m) => m.type === 'question' && m.id === qId)
  if (!q) throw new Error(`adbpd did not receive question (qId=${qId})`)
  console.log(`  → adbpd received: ${q.body}`)

  console.log('=== adbpd replies ===')
  send(adbpd.ws, 'adbpd_agent', 'aegis_agent', 'answer', 'Yes, /health=ok deviceCount=2', qId)
  await sleep(500)

  const a = aegis.inbox.find((m) => m.type === 'answer' && m.reply_to === qId)
  if (!a) throw new Error('aegis did not receive answer linked via reply_to')
  console.log(`  → aegis received answer: ${a.body}`)

  console.log('=== verify SQLite via /api/messages ===')
  const since = Date.now() - 10000
  const resp = await fetch(`${HTTP}/api/messages?since=${since}&limit=50`)
  const msgs = await resp.json() as any[]
  const persistedQ = msgs.find((m) => m.id === qId)
  const persistedA = msgs.find((m) => m.reply_to === qId)
  if (!persistedQ || !persistedA) throw new Error('question/answer not persisted in SQLite')
  console.log(`  → both messages found in SQLite (${msgs.length} total since cutoff)`)

  console.log('=== /api/agents ===')
  const agentsResp = await fetch(`${HTTP}/api/agents`)
  const agents = await agentsResp.json() as any[]
  const aegisFound = agents.find((a) => a.id === 'aegis_agent' && a.state === 'online')
  const adbpdFound = agents.find((a) => a.id === 'adbpd_agent' && a.state === 'online')
  if (!aegisFound || !adbpdFound) throw new Error(`agents not both online: ${JSON.stringify(agents)}`)
  console.log(`  → both online: ${aegisFound.id}, ${adbpdFound.id}`)

  console.log('=== /api/summary ===')
  const sumResp = await fetch(`${HTTP}/api/summary?n=20`)
  const { markdown } = await sumResp.json() as { markdown: string }
  if (!markdown.includes('5037') || !markdown.includes('/health=ok')) {
    throw new Error('summary missing message bodies')
  }
  console.log('  → summary contains both message bodies')

  console.log('\n✓ ALL SMOKE CHECKS PASS')
  aegis.ws.close()
  adbpd.ws.close()
  process.exit(0)
}

main().catch((e) => { console.error('SMOKE FAIL:', e); process.exit(1) })
