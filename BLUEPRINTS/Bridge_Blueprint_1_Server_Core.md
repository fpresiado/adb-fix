







FUTURE ATI LLC



BRIDGE



SOVEREIGN MULTI-AGENT CHAT SYSTEM



━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━



Blueprint 1 of 2 — Server Core, Protocol & Dashboard



Location: Z:\FutureApps\universal_tools\tools\Bridge\



Stack: Bun · TypeScript · SQLite · WebSocket · Ink · HTML Dashboard










01. EXECUTIVE SUMMARY



Bridge is a sovereign, self-hosted message coordination system for Claude Desktop, Claude Code agents, and human supervisors. It enables multiple AI agents — each identified by their project directory name — to communicate, coordinate tasks, share status, ask and answer questions, and maintain full persistent chat history across sessions.







Bridge does NOT require cloud services, third-party messaging platforms, or network access outside the local machine. It runs entirely on the Threadripper workstation and will extend to the Gigabyte AI TOP ATOM Linux machine with zero architectural changes.







What Bridge Is



• A WebSocket message broker — the hub all agents connect to



• A SQLite database — every message persisted, queryable, survives restarts



• An Ink TUI — real-time terminal chat window per agent in PowerShell



• An HTML dashboard — Isko's supervisor view in a browser tab



• A turn-based coordination protocol — typed conversation with floor control



• A CLAUDE.md-compatible history system — summaries injected into new sessions







What Bridge Is NOT



• NOT live interrupt mid-turn — agents receive messages at turn boundaries (explained in Blueprint 2)



• NOT cloud-dependent — zero external services



• NOT a replacement for CLAUDE.md — it complements it with live coordination



• NOT another framework (LangChain, CrewAI, AutoGen) — fully sovereign TypeScript

















02. SYSTEM ARCHITECTURE







2.1 Component Overview



Component



File



Port/Interface



Purpose



Broker Server



src/server/broker.ts



WS :4700 + HTTP :4701



Central hub — routes all messages, pub/sub, floor control



SQLite Store



src/server/store.ts



data/bridge.db



Persistent message history, WAL mode, FTS5 search



Presence Manager



src/server/presence.ts



In-process



Agent heartbeat, online/typing/idle/offline states



Protocol Layer



src/server/protocol.ts



Zod schemas



Message type validation, floor token logic



Ink TUI Client



src/client/tui.tsx



Connects to WS



Agent's terminal chat window (PowerShell)



HTML Dashboard



src/dashboard/



HTTP :4701/dashboard



Isko's browser supervisor view



NSSM Service



scripts/install-service.ps1



Windows SCM



Auto-start broker on boot, survive crashes











2.2 Data Flow



┌─────────────────────────────────────────────────────────────┐



│                     AGENT LAYER                             │



│  [aegis_agent TUI]  [marea_agent TUI]  [Isko Dashboard]    │



└──────────┬───────────────┬──────────────────┬──────────────┘



           │ WebSocket     │ WebSocket         │ WebSocket



           │ :4700         │ :4700             │ :4700



           ▼               ▼                   ▼



┌─────────────────────────────────────────────────────────────┐



│               BRIDGE BROKER  (127.0.0.1:4700)              │



│  ┌──────────────┐  ┌────────────────┐  ┌────────────────┐  │



│  │ Message Router│  │ Floor Controller│  │ Presence/TTL  │  │



│  │ fan-out/direct│  │ turn token mgmt │  │ heartbeat 10s │  │



│  └──────┬───────┘  └────────────────┘  └────────────────┘  │



│         │ every message persisted                           │



│         ▼                                                   │



│  ┌───────────────────────────────────────────────────────┐  │



│  │           SQLite WAL  (data/bridge.db)                │  │



│  │  messages · agents · threads · summaries · cursors    │  │



│  └───────────────────────────────────────────────────────┘  │



└─────────────────────────────────────────────────────────────┘



           │



           ▼ HTTP :4701



┌─────────────────────────────┐



│  HTML Dashboard (browser)   │



│  Isko supervisor + inject   │



└─────────────────────────────┘

















03. MESSAGE PROTOCOL







3.1 Message Envelope (all messages)



interface BridgeMessage {



  id:        string;     // uuid v4



  ts:        number;     // Unix ms



  from:      string;     // agent id e.g. "aegis_agent" | "isko"



  to:        string;     // agent id | "all" (broadcast)



  type:      MessageType;



  thread_id: string;     // groups a conversation (uuid)



  reply_to:  string | null;  // links answer → question



  priority:  boolean;    // true = Isko supervisor (bypasses floor)



  body:      string;     // message content



  needs_ack: boolean;    // request delivery confirmation



}











3.2 Message Types



Type



Direction



Persisted



Description



chat



Any → Any/All



YES



Normal conversation message. Requires floor token to send.



question



A → B



YES



Agent asks another agent a question. Does NOT require floor token.



answer



B → A



YES



Response to a question. Carries reply_to ID linking to the question.



status



Agent → All



YES



Task progress update. "Building P3 USB transport, ETA 20 min."



error



Agent → All



YES



Agent hit a blocker. Surfaces immediately on all dashboards.



ping



A → B



NO



Are you there? Expects pong within 5s.



pong



B → A



NO



I am here. Reply to ping.



typing



Agent → All



NO



Ephemeral typing indicator. States: active / paused / done.



ack



B → A



NO



Delivery confirmation for needs_ack:true messages.



register



Agent → Broker



YES



Agent joins Bridge. Carries {agentId, projectDir, pid}.



deregister



Agent → Broker



YES



Agent leaving cleanly.



heartbeat



Agent → Broker



NO



Keepalive every 10s. Missing 3 → agent marked offline.



floor_request



Agent → Broker



NO



Request permission to send a chat message.



floor_grant



Broker → Agent



NO



Permission granted. Agent may send one chat message.



floor_deny



Broker → Agent



NO



Floor occupied. Agent must wait and retry.



summary_request



Any → Broker



NO



Request a Markdown summary of recent history for injection.



summary



Broker → Agent



YES



Markdown history summary for CLAUDE.md / session injection.











3.3 Turn / Floor Control



Only one agent can hold the "floor" (permission to send a chat message) at a time. This prevents message collision and simulates polite turn-taking. question, answer, status, and error messages bypass the floor entirely — only chat requires it.







Floor State Machine (lives in broker.ts):







  currentFloor: string | null  // null = floor is free



  floorTimeout: 30000ms        // auto-release if agent goes silent







  Agent A wants to chat:



    1. Sends floor_request



    2. Broker checks: currentFloor === null



       YES → set currentFloor = "aegis_agent", send floor_grant to A



       NO  → send floor_deny to A (A waits 2s and retries)



    3. Agent A sends chat message



    4. Broker broadcasts to target, resets currentFloor = null



    5. Broker broadcasts floor_free to all







  Isko override:



    → priority:true messages skip floor entirely



    → Broker broadcasts immediately, resets floor







  Floor timeout:



    → If A holds floor > 30s without sending: auto-release



    → Broadcast floor_free, log incident











3.4 Typing Indicator Protocol



Modeled on IRCv3 typing client tag. States: active (composing), paused (stopped briefly), done (sent/cancelled). Ephemeral — never persisted to SQLite.







Timing rules (IRCv3 compliant):



  Send "active" when user/agent begins composing



  Throttle: do not send another "active" within 3 seconds



  Send "paused" when composing stops but message not sent



  Send "done" when message is sent or composing cancelled







Auto-clear on receive:



  Clear indicator if 6s passes after last "active"



  Clear indicator if 30s passes after "paused"



  Clear immediately on "done" or agent disconnect







Server-side TTL:



  Broker tracks lastTyping per agent



  setInterval every 5s: clear stale indicators > TTL



  Prevents "stuck typing forever" bug (weechat issue #1718)

















04. DATABASE SCHEMA (SQLite WAL + FTS5)



All persistent state lives in data/bridge.db. WAL mode is set on DB open and is a property of the file — survives restarts. The broker is the ONLY process that writes to the database, eliminating all concurrent-write contention.







-- Core message table



CREATE TABLE messages (



  id          TEXT PRIMARY KEY,         -- uuid



  ts          INTEGER NOT NULL,          -- Unix ms



  from_agent  TEXT NOT NULL,



  to_agent    TEXT NOT NULL,             -- agent id or "all"



  type        TEXT NOT NULL,



  thread_id   TEXT NOT NULL,



  reply_to    TEXT,                      -- FK to messages.id



  priority    INTEGER NOT NULL DEFAULT 0,



  body        TEXT NOT NULL,



  needs_ack   INTEGER NOT NULL DEFAULT 0,



  read_by     TEXT NOT NULL DEFAULT "[]" -- JSON array of agent ids



);







-- FTS5 full-text search over message bodies



CREATE VIRTUAL TABLE messages_fts USING fts5(



  body, content=messages, content_rowid=rowid



);







-- Agent registry



CREATE TABLE agents (



  agent_id    TEXT PRIMARY KEY,



  project_dir TEXT NOT NULL,



  pid         INTEGER,



  state       TEXT NOT NULL DEFAULT "offline", -- online|typing|idle|offline



  last_seen   INTEGER NOT NULL,



  last_seq    INTEGER NOT NULL DEFAULT 0,      -- cursor for resume



  registered_at INTEGER NOT NULL



);







-- Conversation threads



CREATE TABLE threads (



  thread_id   TEXT PRIMARY KEY,



  title       TEXT,



  created_at  INTEGER NOT NULL,



  updated_at  INTEGER NOT NULL,



  participants TEXT NOT NULL DEFAULT "[]" -- JSON array



);







-- Compressed history summaries (for CLAUDE.md injection)



CREATE TABLE summaries (



  id          INTEGER PRIMARY KEY AUTOINCREMENT,



  thread_id   TEXT,



  from_msg_id TEXT NOT NULL,



  to_msg_id   TEXT NOT NULL,



  body        TEXT NOT NULL,    -- Markdown summary



  created_at  INTEGER NOT NULL



);







-- Acknowledgment tracking



CREATE TABLE acks (



  msg_id      TEXT NOT NULL,



  agent_id    TEXT NOT NULL,



  acked_at    INTEGER NOT NULL,



  PRIMARY KEY (msg_id, agent_id)



);







-- WAL + performance pragmas (set on every DB open)



PRAGMA journal_mode = WAL;



PRAGMA synchronous = NORMAL;



PRAGMA foreign_keys = ON;



PRAGMA cache_size = -32000; -- 32MB







-- Auto-checkpoint WAL at 1000 pages (~4MB)



-- Retention: keep last 30 days, summarize older rows

















05. BROKER SERVER (src/server/broker.ts)







5.1 Server Startup



Bun.serve({



  port: 4700,



  hostname: "127.0.0.1",



  fetch(req, server) {



    // Upgrade WebSocket connections



    if (server.upgrade(req)) return;



    // HTTP routes for dashboard on :4701



    return handleHttp(req);



  },



  websocket: {



    idleTimeout: 30,          // seconds — triggers ping/pong



    message(ws, data) { handleMessage(ws, data); },



    open(ws)   { handleConnect(ws); },



    close(ws)  { handleDisconnect(ws); },



    drain(ws)  { /* backpressure relief */ },



  }



});







// Bun native pub/sub — instant fan-out, no extra code



ws.subscribe("global");          // receive all broadcasts



ws.subscribe("agent:aegis");     // receive directed messages



server.publish("global", msg);   // broadcast to all subscribers











5.2 Connection Lifecycle



handleConnect(ws):



  → ws.data = { agentId: null, authenticated: false }



  → Start 10s registration timeout (disconnect if no register msg)







On register message:



  → Validate agentId (alphanumeric + underscore only)



  → INSERT or UPDATE agents table



  → ws.subscribe("global") + ws.subscribe("agent:" + agentId)



  → Start heartbeat TTL timer (30s)



  → Broadcast presence update to all



  → Send replay of unread messages (since last_seq)







On heartbeat message:



  → UPDATE agents SET last_seen = now, state = "online"



  → Reset TTL timer







handleDisconnect(ws):



  → UPDATE agents SET state = "offline"



  → Clear floor if agent held it



  → Clear typing indicator if set



  → Broadcast presence update



  → Log disconnect to messages table (type: "status")











5.3 Message Routing



handleMessage(ws, raw):



  1. Parse JSON → BridgeMessage (Zod validate)



  2. Assign id (uuid) + ts if not set



  3. Switch on type:







     "chat"      → check floor token



                   if granted: persist + fan-out + release floor



                   if denied:  send floor_deny back







     "question"  → persist + send directly to ws.subscribe(target)



     "answer"    → persist + send to reply_to.from_agent



     "status"    → persist + server.publish("global", msg)



     "error"     → persist + server.publish("global", msg) [high priority]



     "typing"    → update typingState map + publish (NO persist)



     "heartbeat" → update presence (NO persist)



     "floor_request" → floor logic (NO persist)



     "ack"       → UPDATE acks table



     "ping"      → route to target, start 5s pong timer



     "summary_request" → generate Markdown from SQLite + send back







  4. If needs_ack: track in pending_acks map, resend if no ack in 10s

















06. INK TUI CHAT WINDOW (src/client/tui.tsx)



Each agent runs their own TUI instance in a PowerShell 7 window. The TUI connects to the broker WebSocket and renders a real-time chat interface using Ink (React for terminal).







Requirements



• PowerShell 7 + Windows Terminal (NOT legacy conhost — Ink layout breaks in conhost)



• Bun 1.2+ (process.stdin.ref() bug fixed)



• npm packages: ink@5.x react react-dom ink-spinner ink-text-input



• Windows Terminal profile per agent with distinct color scheme











6.1 TUI Layout



┌──────────────────────────────────────────────────┐



│ BRIDGE  aegis_agent  ● online     [floor: free]  │ ← header bar



├──────────────────────────────────────────────────┤



│ AGENTS: aegis● marea● isko●                      │ ← presence bar



├──────────────────────────────────────────────────┤



│                                                  │



│  [10:42:01] isko: check aegis did u finish P3?  │ ← scrollback



│                                                  │ ← <Static> component



│  [10:42:15] aegis_agent: yes! P3 shipped. USB   │   (no re-render)



│    hybrid working. Note 20 + AVD simultaneously.│



│    Q for marea: did your SQLite migrations run?  │



│                                                  │



│  [10:43:01] marea_agent: ✓ migrations ran clean │



│                                                  │



│  marea_agent is typing...                        │ ← typing indicator



├──────────────────────────────────────────────────┤



│ > _                                              │ ← input box



│ /question <agent> <text>   /status <text>        │ ← command hint



└──────────────────────────────────────────────────┘











6.2 Ink Component Structure



<App>                          // main component, holds WebSocket state



  <Box flexDirection="column" height="100%">



    <Header />                 // agent name, status, floor state



    <PresenceBar />            // all agents + online state dots



    <Static items={messages}>  // scrollback — Static = no re-render



      {msg => <Message key={msg.id} {...msg} />}



    </Static>



    <TypingIndicator />        // "marea_agent is typing..."



    <InputBox />               // ink-text-input, command parsing



  </Box>



</App>







// Message component — color per agent, icon per type



<Message>



  <Text color="gray">[{ts}]</Text>



  <Text color={agentColor}>{from}: </Text>



  {type === "question" && <Text color="yellow">❓ </Text>}



  {type === "error"    && <Text color="red">🔴 </Text>}



  {type === "status"   && <Text color="cyan">📌 </Text>}



  <Text>{body}</Text>



</Message>











6.3 Input Commands



Command



Sends Type



Description



<text> [Enter]



chat



Send normal chat message (requests floor first)



/q <agent> <text>



question



Ask specific agent a question (no floor needed)



/a <msg-id> <text>



answer



Answer a specific question by its ID



/s <text>



status



Broadcast a status update to all



/e <text>



error



Broadcast an error/blocker to all



/ping <agent>



ping



Check if agent is alive



/agents



local



Show all registered agents + states



/history [n]



local



Show last n messages (default 20) from SQLite



/thread <title>



local



Start a new named conversation thread



/summary



summary_request



Request Markdown summary for CLAUDE.md injection



/help



local



Show all commands

















07. HTML DASHBOARD (src/dashboard/)



Served at http://127.0.0.1:4701/dashboard — Isko's supervisor view. Opens in any browser. Connects to the Bridge WebSocket for real-time updates. Richer than the TUI: full scrollback, per-agent color panels, multi-thread view, and injection controls.











7.1 Dashboard Features



Feature



Description



Agent status sidebar



All registered agents, online/offline/typing state, last seen, current task



Multi-thread chat view



Separate panels per conversation thread, switchable via tabs



Message type icons



chat / question / answer / status / error each have distinct color + icon



Isko injection box



Always-visible input — priority:true messages that bypass floor



Unread badges



Per-agent unread count, clears when thread is opened



Error highlight



Error messages surface as full-width banner, persist until dismissed



Question tracker



Open questions list: who asked, who needs to answer, how long ago



History search



FTS5-powered search over all message history



Summary generator



Button to generate + copy CLAUDE.md-ready Markdown summary



Agent graph



Visual node graph of who has talked to whom this session











7.2 Dashboard Tech Stack



Single-file HTML + vanilla JS (no build step — served directly by Bun)







Broker serves:



  GET /dashboard        → serves index.html



  GET /dashboard/api/messages?since=N  → JSON history from SQLite



  GET /dashboard/api/agents            → JSON agent roster



  WS  /dashboard/ws    → same Bridge protocol (Isko registers as "isko")







Tech: Alpine.js (3.x, CDN from local cache) + Tailwind CSS (CDN local)



  → Zero build step, works offline, sovereign



  → Alpine handles reactive state: v-for messages, x-show for panels



  → Tailwind handles colors, layout, badges







NO React, NO Next.js, NO Vite — keeps it lightweight and serveable



directly from Bun without a separate build pipeline.

















08. DIRECTORY STRUCTURE



Z:\FutureApps\universal_tools\tools\Bridge\



├── src/



│   ├── server/



│   │   ├── broker.ts          # Bun.serve WS :4700 + HTTP :4701



│   │   ├── store.ts           # bun:sqlite, WAL, FTS5, CRUD



│   │   ├── presence.ts        # heartbeat TTL, state machine



│   │   ├── floor.ts           # floor token + timeout



│   │   ├── protocol.ts        # Zod message schemas



│   │   └── summary.ts         # Markdown history generator



│   ├── client/



│   │   ├── tui.tsx            # Ink React TUI entry point



│   │   ├── components/



│   │   │   ├── Header.tsx     # agent name, status, floor



│   │   │   ├── PresenceBar.tsx# all agents + states



│   │   │   ├── MessageList.tsx# <Static> scrollback



│   │   │   ├── Message.tsx    # single message + type icon



│   │   │   ├── Typing.tsx     # typing indicator



│   │   │   └── InputBox.tsx   # ink-text-input + command parser



│   │   └── ws-client.ts       # shared WS connection + reconnect



│   └── dashboard/



│       ├── index.html         # Isko supervisor view



│       └── assets/



│           ├── alpine.min.js  # local cache (no CDN required)



│           └── tailwind.min.css



├── data/



│   └── bridge.db              # SQLite WAL database



├── logs/



│   └── bridge.log             # Pino structured JSON logs



├── config/



│   └── bridge.config.ts       # ports, paths, TTLs, agent colors



├── scripts/



│   ├── install-service.ps1    # NSSM Windows service



│   └── bridge.service         # systemd unit (Linux)



├── CLAUDE.md                  # Bridge conventions for agents



├── package.json



├── tsconfig.json



└── bunfig.toml

















09. WINDOWS SERVICE INSTALLATION



The Bridge broker runs as a Windows service via NSSM. It starts on boot before any agent session opens, so agents can connect immediately. Uses a different NSSM port config than ADBPD to avoid the handle-inheritance issue.







# scripts/install-service.ps1







$serviceName = "BridgeBroker"



$bunPath    = "C:\Users\<user>\.bun\bin\bun.exe"



$appPath    = "Z:\FutureApps\universal_tools\tools\Bridge\src\server\broker.ts"



$workingDir = "Z:\FutureApps\universal_tools\tools\Bridge"







nssm install $serviceName $bunPath "run $appPath"



nssm set $serviceName AppDirectory $workingDir



nssm set $serviceName Start SERVICE_AUTO_START



nssm set $serviceName AppNoConsole 1



nssm set $serviceName AppStdout "$workingDir\logs\broker-stdout.log"



nssm set $serviceName AppStderr "$workingDir\logs\broker-stderr.log"



nssm set $serviceName AppRotateFiles 1



nssm set $serviceName AppRotateBytes 52428800







nssm start $serviceName



Start-Sleep 2



Invoke-RestMethod http://127.0.0.1:4701/health



Write-Host "Bridge broker running."

















10. CONFIGURATION (config/bridge.config.ts)



export const BridgeConfig = {



  broker: {



    wsPort:   4700,



    httpPort: 4701,



    host:     "127.0.0.1",



  },



  db: {



    path:            "./data/bridge.db",



    retentionDays:   30,



    walCheckpointPx: 1000,



  },



  presence: {



    heartbeatIntervalMs: 10000,



    timeoutMs:           30000,   // 3 missed heartbeats



    idleAfterMs:         120000,  // 2 min no message = idle



  },



  floor: {



    timeoutMs:  30000,  // auto-release if held > 30s



    retryMs:    2000,   // agent waits 2s before retry



  },



  typing: {



    throttleMs:     3000,  // min gap between "active" sends



    clearActiveMs:  6000,  // clear if no "active" for 6s



    clearPausedMs:  30000, // clear if no update for 30s



  },



  agents: {



    // Colors for TUI + dashboard (ANSI + hex)



    colors: {



      isko:         { ansi: "magenta",  hex: "#FF79C6" },



      aegis_agent:  { ansi: "cyan",     hex: "#8BE9FD" },



      marea_agent:  { ansi: "green",    hex: "#50FA7B" },



      adbpd_agent:  { ansi: "yellow",   hex: "#F1FA8C" },



      // Add more agents here — auto-assigned if not listed



    }



  },



  logging: {



    level: "info",



    file:  "./logs/bridge.log",



  }



};

















11. BUILD PHASES & MILESTONES



Phase



Days



Deliverable



Done When



P1



2



Broker core: WS server, register, heartbeat, presence TTL



Two test clients connect, send heartbeats, broker marks offline on disconnect



P2



2



Message protocol: chat, question, answer, status, error, floor control



Agent A asks question, Agent B answers, linked by reply_to. Floor token prevents collision.



P3



2



SQLite store: WAL, FTS5, schema, migrations, replay on connect



Agent disconnects, reconnects, receives missed messages from last_seq cursor



P4



2



Ink TUI: full chat window, typing indicator, commands



Two PowerShell windows exchange chat messages in real time with typing indicators



P5



2



HTML dashboard: agent sidebar, thread view, Isko injection



Browser dashboard shows live messages, Isko injects priority message from browser



P6



1



Summary generator: Markdown history for CLAUDE.md injection



GET /summary returns formatted Markdown covering last 50 messages



P7



1



Windows service: NSSM install, auto-start, health endpoint



Broker survives reboot, starts before any agent session



P8



1



Integration test: 3 agents + Isko, 1hr soak



Zero message loss, zero floor deadlocks, all disconnects auto-recover







Total estimated build time: 13 working days (Blueprint 1). Blueprint 2 (Claude Code integration) runs in parallel from P3 onward.

















12. BRIDGE CLAUDE.md (for agents)



# Bridge — Agent Communication System



# Read this at session start. Bridge is how you coordinate with other agents.







## Connection



Bridge broker runs at ws://127.0.0.1:4700



You connect via the Bridge MCP tools (see Blueprint 2).



Your agent ID = your project directory name + "_agent".



Example: if you are working in "aegis/" your ID is "aegis_agent".







## How to communicate



  bridge_send(to:"all", type:"status", body:"Starting P3 USB transport")



  bridge_send(to:"marea_agent", type:"question", body:"Did migrations run?")



  bridge_send(to:"aegis_agent", type:"answer", reply_to:"<msg-id>", body:"Yes, clean.")



  bridge_send(to:"all", type:"error", body:"Bun FFI segfault on line 42")







## Rules



1. ALWAYS send a status update when you start a new task



2. ALWAYS send a status update when you finish a task



3. If you hit a blocker, send type:error immediately



4. Check bridge_read() at the START of every turn for queued messages



5. Answer questions before continuing your own work



6. Never hold the floor for more than one message at a time







## Message history



bridge_history(n:20) returns last 20 messages as JSON



bridge_summary() returns Markdown summary for context







## Isko (supervisor)



Messages from "isko" are priority — read and respond before anything else.







━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━



Future ATI LLC — Bridge Blueprint 1 of 2 — Server Core, Protocol & Dashboard



Sovereign · Self-Hosted · Zero Cloud Dependencies





