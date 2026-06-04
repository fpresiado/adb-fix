







FUTURE ATI LLC



BRIDGE



CLAUDE CODE & DESKTOP INTEGRATION LAYER



━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━



Blueprint 2 of 2 — MCP Server, Hooks & Session Injection



Location: Z:\FutureApps\universal_tools\tools\Bridge\src\mcp\



Stack: Bun · TypeScript · @modelcontextprotocol/sdk · Claude Code Hooks










01. PURPOSE & CONSTRAINTS



Blueprint 2 covers the integration layer that connects Claude Code agents and Claude Desktop to the Bridge broker built in Blueprint 1. This is the most technically constrained part of the entire system — read this section carefully before building.







The Core Constraint — Turn Boundaries



Claude Code processes one turn at a time. While it is thinking or executing,



nothing external can interrupt that turn or inject new content into it.







Bridge messages land at the BOUNDARY between turns — when one turn ends



and the next begins. This is not a limitation of Bridge; it is a fundamental



property of how Claude Code works.







What this means in practice:



  • Agent A finishes a task → posts to Bridge



  • Agent B's next turn starts → Stop hook fires → Bridge messages injected



  • Agent B reads and responds







This is turn-by-turn relay — closer to email than instant messaging.



For coordinating parallel builds this is perfectly adequate.







What Works & What Does Not



WORKS:



  ✓ MCP tools (bridge_send, bridge_read) — agent calls them during its turn



  ✓ SessionStart hook — inject history summary when a new session opens



  ✓ Stop hook — inject queued messages at end of every turn



  ✓ UserPromptSubmit hook — inject messages when human types to agent







DOES NOT WORK:



  ✗ FileChanged hook — cannot inject additionalContext, fires unreliably



  ✗ MCP-triggered hook additionalContext — dropped (GitHub bug #24788)



  ✗ Mid-turn interruption — impossible by design



  ✗ Pushing messages TO a running turn — no mechanism exists

















02. BRIDGE MCP SERVER (src/mcp/bridge-mcp.ts)



The MCP server is a stdio-transport TypeScript process that bridges Claude Code / Claude Desktop to the Bridge broker. Each agent runs one instance. It exposes five tools the agent uses to communicate.







Critical: stdio MCP rules



• NEVER use console.log() — stdout is the JSON-RPC channel. Use console.error() for debug.



• Use StdioServerTransport from @modelcontextprotocol/sdk/server/stdio.js



• Register with: claude mcp add bridge-mcp -- bun run src/mcp/bridge-mcp.ts



• Or via .mcp.json in project root (per-project registration)



• The MCP server connects to Bridge broker WS on startup and maintains the connection











2.1 MCP Tools Exposed



Tool Name



Parameters



Returns



Description



bridge_send



to: string, type: string, body: string, reply_to?: string



{ id, ts }



Send any message type to any agent or "all"



bridge_read



since?: number, limit?: number



Message[]



Read messages since a sequence number (default: unread)



bridge_history



n?: number, thread_id?: string



Message[]



Get last n messages from SQLite (default 20)



bridge_agents



(none)



AgentInfo[]



List all registered agents and their current state



bridge_summary



n?: number



{ markdown: string }



Get Markdown summary of last n messages for CLAUDE.md











2.2 MCP Server Implementation



// src/mcp/bridge-mcp.ts



import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";



import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";



import { z } from "zod";







const agentId = process.env.BRIDGE_AGENT_ID ?? "unknown_agent";



const brokerUrl = process.env.BRIDGE_URL ?? "ws://127.0.0.1:4700";







// WebSocket connection to broker — maintained for lifetime of MCP server



let ws: WebSocket;



let messageQueue: Message[] = [];  // buffered until bridge_read called







function connectBroker() {



  ws = new WebSocket(brokerUrl);



  ws.onopen = () => {



    ws.send(JSON.stringify({ type: "register", from: agentId, body: "" }));



  };



  ws.onmessage = (e) => {



    const msg = JSON.parse(e.data);



    if (msg.type !== "heartbeat" && msg.type !== "typing") {



      messageQueue.push(msg);



    }



  };



  ws.onclose = () => {



    // Reconnect after 3s — broker may have restarted



    setTimeout(connectBroker, 3000);



  };



  // Send heartbeat every 10s



  setInterval(() => {



    if (ws.readyState === WebSocket.OPEN) {



      ws.send(JSON.stringify({ type: "heartbeat", from: agentId }));



    }



  }, 10000);



}







const server = new McpServer({ name: "bridge-mcp", version: "1.0.0" });







// bridge_send tool



server.tool("bridge_send",



  { to: z.string(), type: z.string(), body: z.string(), reply_to: z.string().optional() },



  async ({ to, type, body, reply_to }) => {



    const msg = { id: crypto.randomUUID(), ts: Date.now(),



                  from: agentId, to, type, body, reply_to, thread_id: "default" };



    ws.send(JSON.stringify(msg));



    return { content: [{ type: "text", text: JSON.stringify({ id: msg.id, ts: msg.ts }) }] };



  }



);







// bridge_read tool



server.tool("bridge_read",



  { since: z.number().optional(), limit: z.number().optional() },



  async ({ since, limit = 20 }) => {



    const msgs = messageQueue.splice(0, limit); // drain queue



    return { content: [{ type: "text", text: JSON.stringify(msgs) }] };



  }



);







// bridge_agents tool



server.tool("bridge_agents", {},



  async () => {



    const resp = await fetch("http://127.0.0.1:4701/api/agents");



    const agents = await resp.json();



    return { content: [{ type: "text", text: JSON.stringify(agents) }] };



  }



);







// bridge_summary tool



server.tool("bridge_summary",



  { n: z.number().optional() },



  async ({ n = 50 }) => {



    const resp = await fetch(`http://127.0.0.1:4701/api/summary?n=${n}`);



    const { markdown } = await resp.json();



    return { content: [{ type: "text", text: markdown }] };



  }



);







connectBroker();



const transport = new StdioServerTransport();



await server.connect(transport);

















03. MCP REGISTRATION







3.1 Per-Project Registration (.mcp.json)



Each Claude Code project registers the Bridge MCP server via a .mcp.json file in the project root. This file is read by Claude Code on session start.







// M:\FutureApps\aegis\.mcp.json



{



  "mcpServers": {



    "bridge-mcp": {



      "command": "bun",



      "args": ["run", "Z:\\FutureApps\\universal_tools\\tools\\Bridge\\src\\mcp\\bridge-mcp.ts"],



      "env": {



        "BRIDGE_AGENT_ID": "aegis_agent",



        "BRIDGE_URL": "ws://127.0.0.1:4700"



      }



    }



  }



}











3.2 Claude Desktop Registration



Claude Desktop reads MCP servers from its config file. Add Bridge MCP here to make bridge_* tools available in Claude Desktop conversations.







// %APPDATA%\Claude\claude_desktop_config.json



{



  "mcpServers": {



    "bridge-mcp": {



      "command": "bun",



      "args": ["run", "Z:\\FutureApps\\universal_tools\\tools\\Bridge\\src\\mcp\\bridge-mcp.ts"],



      "env": {



        "BRIDGE_AGENT_ID": "isko",



        "BRIDGE_URL": "ws://127.0.0.1:4700"



      }



    }



  }



}







Note on Claude Desktop



Claude Desktop MCP tools work immediately — Isko can call bridge_send and bridge_read



from any Claude Desktop conversation without any hooks or injection complexity.



This is the simplest integration path and works out of the box.

















04. CLAUDE CODE HOOKS



Claude Code hooks are shell scripts that fire at specific events in the Claude Code lifecycle. They are the mechanism for automatically injecting Bridge messages into an agent's context at turn boundaries.







Hook Location



Global hooks: %USERPROFILE%\.claude\hooks\



Project hooks: <project_root>\.claude\hooks\







Hook config: %USERPROFILE%\.claude\settings.json



Or per-project: <project_root>\.claude\settings.json







Each hook is a script that Claude Code runs at the specified event.



On Windows: PowerShell scripts (.ps1) called via "powershell -File hook.ps1"











4.1 SessionStart Hook — History Injection



Fires when a new Claude Code session opens. Injects the Bridge conversation summary and any unread messages as context, so the agent starts the session aware of what happened while it was away.







// .claude/settings.json (hook registration)



{



  "hooks": {



    "SessionStart": [



      {



        "matcher": "",



        "hooks": [{



          "type": "command",



          "command": "powershell -File Z:\\FutureApps\\universal_tools\\tools\\Bridge\\src\\hooks\\session-start.ps1"



        }]



      }



    ],



    "Stop": [



      {



        "matcher": "",



        "hooks": [{



          "type": "command",



          "command": "powershell -File Z:\\FutureApps\\universal_tools\\tools\\Bridge\\src\\hooks\\stop-inject.ps1"



        }]



      }



    ]



  }



}







# src/hooks/session-start.ps1



# Fires on new session. Fetches Bridge summary and injects as additionalContext.







$agentId = $env:BRIDGE_AGENT_ID



$brokerHttp = "http://127.0.0.1:4701"







# Fetch summary of last 50 messages



try {



  $summary = (Invoke-RestMethod "$brokerHttp/api/summary?n=50&agent=$agentId").markdown



  $unread  = (Invoke-RestMethod "$brokerHttp/api/messages/unread?agent=$agentId") | ConvertTo-Json







  $context = @"



## Bridge Communication History



$summary







## Unread Messages For You



$unread



"@







  # Output JSON for Claude Code additionalContext injection



  $output = @{



    hookSpecificOutput = @{



      hookEventName    = "SessionStart"



      additionalContext = $context



    }



  } | ConvertTo-Json -Depth 5







  Write-Output $output



  exit 0



}



catch {



  # Bridge broker down — non-fatal, session continues normally



  Write-Error "Bridge unavailable: $_"



  exit 0



}











4.2 Stop Hook — Turn-Boundary Message Injection



Fires at the end of every Claude Code turn. Checks if any Bridge messages are queued for this agent. If yes, returns decision:block to grant one more turn and injects the messages as additionalContext. The agent processes them in the new turn.







# src/hooks/stop-inject.ps1



# Fires at end of every turn. Injects queued Bridge messages if any exist.







$agentId = $env:BRIDGE_AGENT_ID



$brokerHttp = "http://127.0.0.1:4701"







# Guard: prevent infinite loop if we are already in injection turn



$hookActive = $env:BRIDGE_HOOK_ACTIVE



if ($hookActive -eq "1") {



  exit 0  # Let the turn end normally



}







try {



  # Check for queued messages



  $queued = Invoke-RestMethod "$brokerHttp/api/messages/queued?agent=$agentId"







  if ($queued.Count -eq 0) {



    exit 0  # Nothing queued — turn ends normally



  }







  # Format messages for injection



  $msgText = $queued | ForEach-Object {



    "[$($_.ts_formatted)] $($_.from): $($_.body)"



  } | Out-String







  $context = @"



## Bridge Messages Received



You have $($queued.Count) message(s) from other agents:







$msgText







Please read these messages and respond appropriately before continuing your task.



"@







  # Mark messages as delivered



  Invoke-RestMethod "$brokerHttp/api/messages/mark-delivered" `



    -Method POST `



    -Body (@{ agent=$agentId; ids=($queued | Select -Expand id) } | ConvertTo-Json) `



    -ContentType "application/json" | Out-Null







  # Set env var to prevent loop on next Stop



  $env:BRIDGE_HOOK_ACTIVE = "1"







  # Return block decision — grants one more turn



  $output = @{



    decision = "block"



    reason   = "Bridge messages queued for $agentId"



    hookSpecificOutput = @{



      hookEventName    = "Stop"



      additionalContext = $context



    }



  } | ConvertTo-Json -Depth 5







  Write-Output $output



  exit 0



}



catch {



  # Bridge unavailable — non-fatal



  Write-Error "Bridge Stop hook error: $_"



  exit 0



}







Hook Constraints — Read Before Building



1. additionalContext is capped at 10,000 characters — truncate if needed



2. All hook stdout is JSON — never mix debug prints with JSON output



3. GitHub bug #24788: additionalContext is DROPPED when hook fires on MCP tool events



   → ONLY use Stop and UserPromptSubmit hooks for injection (not PostToolUse)



4. stop_hook_active field: check env var BRIDGE_HOOK_ACTIVE to prevent infinite loops



5. Hook timeout: hooks have a 60s execution limit — keep HTTP calls fast



6. Non-zero exit code = hook failed = Claude Code shows error to user



   → Always exit 0, even on Bridge failure (fail open, not closed)

















05. AGENT WORKFLOW — END TO END







5.1 Aegis Agent Sending to Marea Agent



AEGIS AGENT TURN:



  1. Aegis finishes building USB hybrid transport



  2. Aegis calls: bridge_send(



       to: "marea_agent",



       type: "question",



       body: "P3 USB done. Did your SQLite migrations run clean?"



     )



  3. MCP server sends message to broker WS



  4. Broker persists to SQLite, queues for marea_agent



  5. Aegis continues its turn or ends it







BROKER:



  → Stores message, sets queued_for = ["marea_agent"]



  → If marea_agent TUI is open: shows message in real time



  → Dashboard: shows message, unread badge on marea panel







MAREA AGENT NEXT TURN END (Stop hook fires):



  1. stop-inject.ps1 calls /api/messages/queued?agent=marea_agent



  2. Gets aegis question



  3. Returns decision:block + additionalContext with the question



  4. Claude Code grants one more turn



  5. Marea agent reads question, calls:



       bridge_send(



         to: "aegis_agent",



         type: "answer",



         reply_to: "<aegis-question-id>",



         body: "Yes migrations ran clean. All 3 tables created."



       )



  6. Marea continues its task











5.2 Isko Injecting as Supervisor



ISKO (via browser dashboard OR Claude Desktop):



  → Types in dashboard injection box:



     "aegis: stop current task, priority fix needed on ADBPD port 5037"



  → Dashboard sends priority:true message via Bridge WebSocket



  → Broker: routes to aegis_agent, marks priority







AEGIS AGENT (Stop hook):



  → stop-inject.ps1 finds priority message



  → Priority messages always surface first (sorted before normal queue)



  → decision:block fires, aegis reads Isko's instruction



  → Aegis responds to Isko, adjusts task







ISKO sees response:



  → Dashboard shows aegis reply in real time



  → Isko can continue the conversation or dismiss

















06. BROKER HTTP ENDPOINTS (for hooks)



The hooks call the broker HTTP API to fetch queued messages and mark them delivered. These endpoints are served on port 4701 alongside the dashboard.







Method



Endpoint



Description



Returns



GET



/api/messages/queued?agent=<id>



Get all undelivered messages for agent



Message[]



POST



/api/messages/mark-delivered



Mark messages as delivered (body: {agent, ids[]})



{ ok }



GET



/api/messages/unread?agent=<id>



Get messages since agent's last_seq cursor



Message[]



GET



/api/summary?n=50&agent=<id>



Get Markdown summary of last n messages



{ markdown }



GET



/api/agents



List all agents + current state



AgentInfo[]



GET



/health



Broker health check



{ status, agents, uptime }

















07. DIRECTORY ADDITIONS (Blueprint 2)



These files extend the Blueprint 1 directory structure. Everything lives under the same Bridge root.







Z:\FutureApps\universal_tools\tools\Bridge\



└── src/



    ├── mcp/



    │   ├── bridge-mcp.ts          # stdio MCP server (all tools)



    │   └── ws-client.ts           # shared WS connection for MCP



    └── hooks/



        ├── session-start.ps1      # SessionStart hook — history injection



        └── stop-inject.ps1        # Stop hook — turn-boundary delivery







Per-project additions (in each Claude Code project):



  <project>\



  ├── .mcp.json                    # Bridge MCP registration



  └── .claude\



      └── settings.json            # Hook registration







Claude Desktop addition:



  %APPDATA%\Claude\



  └── claude_desktop_config.json   # Bridge MCP as "bridge-mcp" server

















08. AGENT ID NAMING CONVENTION



Agent IDs are derived from the project directory name. This is automatic — no manual configuration needed beyond setting BRIDGE_AGENT_ID in .mcp.json.







Project Directory



Agent ID



Color



Role



aegis/



aegis_agent



Cyan



Aegis app builder



marea/



marea_agent



Green



Marea app builder



adbpd/



adbpd_agent



Yellow



ADB daemon builder



zankyo/



zankyo_agent



Purple



Zankyō game builder



sonara/



sonara_agent



Orange



Sonara music engine builder



(human)



isko



Magenta



Supervisor — always priority



(desktop)



claude_desktop



Blue



Claude Desktop conversations







Adding a new agent: create .mcp.json in the project with the correct BRIDGE_AGENT_ID. No broker changes needed — agents self-register on connect.

















09. BUILD PHASES (Blueprint 2)



Blueprint 2 phases run in parallel with Blueprint 1 phases P3 onward. The MCP server requires the broker WebSocket to be running (Blueprint 1 P1).







Phase



Days



Deliverable



Done When



M1



1



Bridge MCP server — bridge_send and bridge_read only



Claude Code calls bridge_send, message appears in broker log



M2



1



Full MCP tools — bridge_history, bridge_agents, bridge_summary



All 5 tools work, Claude Code can read history and agent list



M3



1



SessionStart hook — history summary injection



New Claude Code session opens with Bridge context in first turn



M4



2



Stop hook — turn-boundary message delivery



Agent A sends question, Agent B receives it on next turn via Stop hook



M5



1



Claude Desktop registration + supervisor workflow



Isko sends priority message from Claude Desktop, aegis_agent receives it



M6



1



Per-project .mcp.json templates for all active apps



All active project directories have correct .mcp.json and settings.json



M7



1



Integration test — aegis + marea full exchange



Aegis asks question, marea answers, Isko injects, all messages in SQLite







Total Blueprint 2 build time: 8 working days. Runs alongside Blueprint 1 from P3 onward. Full system ready in ~3 weeks.

















10. PER-PROJECT CLAUDE.md ADDITIONS



Add this block to the CLAUDE.md of every Claude Code project that participates in Bridge. This ensures the agent uses Bridge correctly from the start of every session.







## Bridge Communication



# You are connected to Bridge — a multi-agent coordination system.



# Your agent ID: aegis_agent (change per project)







### At the START of every turn:



Call bridge_read() to check for messages from other agents or Isko.



If any messages exist: read them, respond if needed, then continue your task.







### When you START a task:



bridge_send(to:"all", type:"status", body:"Starting <task description>")







### When you FINISH a task:



bridge_send(to:"all", type:"status", body:"Finished <task>. Result: <summary>")







### When you hit a BLOCKER:



bridge_send(to:"all", type:"error", body:"BLOCKED: <description of problem>")







### To ASK another agent:



bridge_send(to:"marea_agent", type:"question", body:"<your question>")







### To ANSWER a question:



bridge_send(to:"<asker>", type:"answer", reply_to:"<question-msg-id>", body:"<answer>")







### Priority rule:



Messages from "isko" are always top priority.



Read and respond to Isko messages before any other work.







### Check who is online:



bridge_agents() — shows all agents and their current state.

















11. KNOWN ISSUES & MITIGATIONS



Issue



Impact



Mitigation



GitHub bug #24788 — additionalContext dropped on MCP-triggered hooks



Medium



Only use Stop and SessionStart hooks for injection. Never PostToolUse/MCP-triggered.



Stop hook fires every turn even with no messages



Low



HTTP call to /api/messages/queued is fast (<5ms local). Negligible overhead.



Infinite loop if Stop hook fires on injection turn



High



BRIDGE_HOOK_ACTIVE env var guard in stop-inject.ps1. Tested via integration test.



Hook additionalContext 10,000 char cap



Medium



Truncate summaries at 8,000 chars. Flag truncation in the context string.



Broker restart drops in-flight WS connections



Low



MCP ws-client.ts auto-reconnects after 3s. Messages already in SQLite survive.



Agent crashes mid-message — message never sent



Medium



No mitigation — same as any process crash. Check Bridge dashboard for gaps.



Claude Code session expires mid-conversation



Low



SessionStart hook re-injects context on new session. History in SQLite.

















12. MANDATORY SPIKE — RUN BEFORE P_M4



Before building the Stop hook injection (M4), run this spike to verify additionalContext injection works on your specific Claude Code version. This is the highest-risk piece of the build.







SPIKE PROCEDURE (30 minutes):







1. Create Z:\spike\test-hook\







2. Create .claude\settings.json:



   { "hooks": { "Stop": [{ "matcher": "", "hooks": [{ "type": "command",



     "command": "powershell -Command \"Write-Output '{\"decision\":\"block\",\"reason\":\"spike-test\",\"hookSpecificOutput\":{\"hookEventName\":\"Stop\",\"additionalContext\":\"SPIKE: This text was injected by the Stop hook.\"}}'\"" }] }] } }







3. Open Claude Code in Z:\spike\test-hook\







4. Type: "say hello"







5. Claude Code should end its turn, then the hook fires.



   Expected: a new turn opens automatically with the injected context visible.



   The agent should reference "SPIKE: This text was injected by the Stop hook."







PASS: Agent sees injected text → Stop hook injection works → build M4



FAIL: Agent does not see text → hit bug or version issue



      → Fall back: agents call bridge_read() manually at start of each turn



      → The MCP tool approach still works, just not automatic







Document result in Bridge BUILD_REPORT.md before M4 starts.







━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━



Future ATI LLC — Bridge Blueprint 2 of 2 — Claude Code & Desktop Integration



Sovereign · Self-Hosted · Zero Cloud Dependencies





