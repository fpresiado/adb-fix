// Bridge TUI: Ink React terminal client. Connects to broker via ws, renders
// header / message stream / compose box, drives chat floor flow & slash commands.

import React, { useEffect, useMemo, useReducer, useRef } from "react";
import { Box, Static, Text, useApp, useInput, render } from "ink";
import TextInput from "ink-text-input";
import {
  BridgeMessageSchema,
  encodeMessage,
  HEARTBEAT_MS,
  type BridgeMessage,
  type MessageType,
} from "../server/protocol.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Minimal WebSocket surface the TUI relies on (matches global WebSocket). */
export interface TuiSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    event: "open" | "message" | "close" | "error",
    handler: (evt: { data?: unknown }) => void,
  ): void;
  removeEventListener?: (event: string, handler: (evt: unknown) => void) => void;
}

export interface TuiProps {
  agentId: string;
  url?: string;
  /** Factory to allow tests to inject a mock socket. Defaults to global WebSocket. */
  socketFactory?: (url: string) => TuiSocket;
  /** Override heartbeat cadence (ms). Tests set this very low. */
  heartbeatMs?: number;
  /** Override floor retry cadence (ms). Default 1000ms per blueprint. */
  floorRetryMs?: number;
  /** Override typing idle threshold (ms). Default 3000ms per blueprint. */
  typingIdleMs?: number;
  /** Disable Ink raw-input handling (useful in some test environments). */
  disableRawInput?: boolean;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface AppState {
  connectionState: "connecting" | "connected" | "disconnected";
  messages: BridgeMessage[];
  inputValue: string;
  notice: string | null; // transient status line above input
  threadFilter: string | null;
  floorWaiting: boolean; // true while we're queued waiting for floor_grant
  pendingChatBody: string | null; // body to send once floor is granted
  typingActive: boolean; // we have emitted typing=active and not yet done
}

type Action =
  | { kind: "conn"; state: AppState["connectionState"] }
  | { kind: "msg"; msg: BridgeMessage }
  | { kind: "input"; value: string }
  | { kind: "notice"; text: string | null }
  | { kind: "threadFilter"; id: string | null }
  | { kind: "floorWait"; body: string | null }
  | { kind: "floorGranted" } // resets pendingChatBody + waiting
  | { kind: "typingActive"; active: boolean }
  | { kind: "clearInput" };

function reducer(state: AppState, action: Action): AppState {
  switch (action.kind) {
    case "conn":
      return { ...state, connectionState: action.state };
    case "msg":
      return { ...state, messages: [...state.messages, action.msg] };
    case "input":
      return { ...state, inputValue: action.value };
    case "notice":
      return { ...state, notice: action.text };
    case "threadFilter":
      return { ...state, threadFilter: action.id };
    case "floorWait":
      return {
        ...state,
        floorWaiting: action.body !== null,
        pendingChatBody: action.body,
      };
    case "floorGranted":
      return { ...state, floorWaiting: false, pendingChatBody: null };
    case "typingActive":
      return { ...state, typingActive: action.active };
    case "clearInput":
      return { ...state, inputValue: "" };
  }
}

const INITIAL_STATE: AppState = {
  connectionState: "connecting",
  messages: [],
  inputValue: "",
  notice: null,
  threadFilter: null,
  floorWaiting: false,
  pendingChatBody: null,
  typingActive: false,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowMs(): number {
  return Date.now();
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function makeEnv(
  from: string,
  to: string,
  type: MessageType,
  body: string,
  opts: Partial<BridgeMessage> = {},
): BridgeMessage {
  return {
    id: crypto.randomUUID(),
    ts: nowMs(),
    from,
    to,
    type,
    thread_id: opts.thread_id ?? "tui",
    reply_to: opts.reply_to ?? null,
    priority: opts.priority ?? false,
    body,
    needs_ack: opts.needs_ack ?? false,
  };
}

// any: incoming wire payload is unknown until parsed by Zod below.
function parseIncoming(data: unknown): BridgeMessage | null {
  try {
    const text =
      typeof data === "string"
        ? data
        : data instanceof Uint8Array
          ? new TextDecoder().decode(data)
          : // any: Bun/ws may deliver Buffer-like with toString
            String((data as { toString(): string }).toString());
    const json: unknown = JSON.parse(text);
    return BridgeMessageSchema.parse(json);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Default socket factory (browser/Node/Bun all expose global WebSocket).
// ---------------------------------------------------------------------------

function defaultSocketFactory(url: string): TuiSocket {
  // any: WebSocket constructor is global in Bun/modern Node; cast for TS.
  const Ctor = (globalThis as { WebSocket: new (u: string) => TuiSocket })
    .WebSocket;
  return new Ctor(url);
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function BridgeTui(props: TuiProps): React.ReactElement {
  const {
    agentId,
    url = "ws://127.0.0.1:4700",
    socketFactory = defaultSocketFactory,
    heartbeatMs = HEARTBEAT_MS,
    floorRetryMs = 1000,
    typingIdleMs = 3000,
    disableRawInput = false,
  } = props;

  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);
  const app = useApp();

  // Mutable refs we need across handlers/timers without forcing re-renders.
  const sockRef = useRef<TuiSocket | null>(null);
  const heartbeatTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const floorRetryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingIdleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingChatRef = useRef<string | null>(null);
  const typingActiveRef = useRef<boolean>(false);
  const connectedRef = useRef<boolean>(false);

  // -------------------------------------------------------------------------
  // Wire helpers
  // -------------------------------------------------------------------------

  function safeSend(env: BridgeMessage): void {
    const sock = sockRef.current;
    if (!sock || !connectedRef.current) return;
    try {
      sock.send(encodeMessage(env));
    } catch {
      /* socket may be dying — presence sweep will reconcile */
    }
  }

  function sendTyping(stateStr: "active" | "done"): void {
    safeSend(makeEnv(agentId, "all", "typing", stateStr));
  }

  function emitTypingActive(): void {
    if (!typingActiveRef.current) {
      typingActiveRef.current = true;
      dispatch({ kind: "typingActive", active: true });
      sendTyping("active");
    }
    if (typingIdleTimer.current) clearTimeout(typingIdleTimer.current);
    typingIdleTimer.current = setTimeout(() => {
      if (typingActiveRef.current) {
        typingActiveRef.current = false;
        dispatch({ kind: "typingActive", active: false });
        sendTyping("done");
      }
    }, typingIdleMs);
  }

  function endTypingNow(): void {
    if (typingIdleTimer.current) {
      clearTimeout(typingIdleTimer.current);
      typingIdleTimer.current = null;
    }
    if (typingActiveRef.current) {
      typingActiveRef.current = false;
      dispatch({ kind: "typingActive", active: false });
      sendTyping("done");
    }
  }

  function requestFloor(body: string): void {
    pendingChatRef.current = body;
    dispatch({ kind: "floorWait", body });
    safeSend(makeEnv(agentId, "bridge", "floor_request", ""));
  }

  function retryFloorLater(): void {
    if (floorRetryTimer.current) clearTimeout(floorRetryTimer.current);
    floorRetryTimer.current = setTimeout(() => {
      const body = pendingChatRef.current;
      if (body !== null) {
        safeSend(makeEnv(agentId, "bridge", "floor_request", ""));
      }
    }, floorRetryMs);
  }

  // -------------------------------------------------------------------------
  // Slash command dispatch
  // -------------------------------------------------------------------------

  function handleSlash(raw: string): void {
    const [cmd, ...rest] = raw.slice(1).split(/\s+/);
    const rejoined = rest.join(" ");

    switch (cmd) {
      case "q":
      case "quit":
      case "exit": {
        safeSend(makeEnv(agentId, "bridge", "deregister", "user_quit"));
        endTypingNow();
        try {
          sockRef.current?.close(1000, "user_quit");
        } catch {
          /* ignore */
        }
        app.exit();
        return;
      }
      case "list":
      case "agents": {
        // Server doesn't expose a list-via-ws yet; surface as a status request.
        safeSend(makeEnv(agentId, "all", "status", "bridge_agents"));
        dispatch({ kind: "notice", text: "requested agent list" });
        return;
      }
      case "ask": {
        // /ask <agent> <body>
        const parts = rejoined.split(/\s+/);
        const target = parts.shift();
        const body = parts.join(" ");
        if (!target || !body) {
          dispatch({ kind: "notice", text: "usage: /ask <agent> <body>" });
          return;
        }
        safeSend(makeEnv(agentId, target, "question", body));
        dispatch({ kind: "notice", text: `asked ${target}` });
        return;
      }
      case "thread": {
        const id = rejoined.trim();
        if (!id) {
          dispatch({ kind: "threadFilter", id: null });
          dispatch({ kind: "notice", text: "thread filter cleared" });
          return;
        }
        dispatch({ kind: "threadFilter", id });
        dispatch({ kind: "notice", text: `filtering thread ${id}` });
        return;
      }
      default: {
        dispatch({ kind: "notice", text: `unknown command: /${cmd}` });
        return;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Submit (Enter pressed)
  // -------------------------------------------------------------------------

  function handleSubmit(value: string): void {
    const text = value.trim();
    dispatch({ kind: "clearInput" });
    endTypingNow();
    if (text.length === 0) return;
    if (text.startsWith("/")) {
      handleSlash(text);
      return;
    }
    // Normal chat — request the floor first.
    requestFloor(text);
  }

  function handleChange(value: string): void {
    dispatch({ kind: "input", value });
    if (value.length > 0) emitTypingActive();
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  useEffect(() => {
    const sock = socketFactory(url);
    sockRef.current = sock;

    sock.addEventListener("open", () => {
      connectedRef.current = true;
      dispatch({ kind: "conn", state: "connected" });
      // Send register envelope (body carries project dir best-effort).
      const projectDir = process.env.BRIDGE_PROJECT_DIR ?? agentId;
      safeSend(makeEnv(agentId, "bridge", "register", projectDir));
      heartbeatTimer.current = setInterval(() => {
        safeSend(makeEnv(agentId, "bridge", "heartbeat", ""));
      }, heartbeatMs);
    });

    sock.addEventListener("message", (evt) => {
      const env = parseIncoming(evt.data);
      if (!env) return;

      // Floor protocol
      if (env.type === "floor_grant" && env.to === agentId) {
        const body = pendingChatRef.current;
        if (body !== null) {
          safeSend(makeEnv(agentId, "all", "chat", body));
          pendingChatRef.current = null;
          dispatch({ kind: "floorGranted" });
          dispatch({ kind: "notice", text: null });
        }
        return;
      }
      if (env.type === "floor_deny" && env.to === agentId) {
        const holder = env.body || "another agent";
        dispatch({
          kind: "notice",
          text: `floor held by ${holder} — waiting`,
        });
        retryFloorLater();
        return;
      }

      // Typing indicators are transient — show as notice, do not push to log.
      if (env.type === "typing") {
        if (env.from !== agentId && env.body === "active") {
          dispatch({ kind: "notice", text: `${env.from} is typing...` });
        }
        return;
      }

      // Everything else lands in the scrollback.
      dispatch({ kind: "msg", msg: env });
    });

    sock.addEventListener("close", () => {
      connectedRef.current = false;
      dispatch({ kind: "conn", state: "disconnected" });
      if (heartbeatTimer.current) clearInterval(heartbeatTimer.current);
    });

    sock.addEventListener("error", () => {
      // ws errors arrive before close; mirror the state transition.
      connectedRef.current = false;
      dispatch({ kind: "conn", state: "disconnected" });
    });

    return (): void => {
      if (heartbeatTimer.current) clearInterval(heartbeatTimer.current);
      if (floorRetryTimer.current) clearTimeout(floorRetryTimer.current);
      if (typingIdleTimer.current) clearTimeout(typingIdleTimer.current);
      try {
        sock.close(1000, "tui_unmount");
      } catch {
        /* ignore */
      }
    };
    // We intentionally bind once on mount; agentId/url are immutable per session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -------------------------------------------------------------------------
  // Optional Ctrl-C handling — Ink already exits on Ctrl-C by default, but we
  // hook useInput so tests can simulate keys without a TextInput focus race.
  // -------------------------------------------------------------------------

  useInput(
    (input, key) => {
      if (key.ctrl && input === "c") {
        safeSend(makeEnv(agentId, "bridge", "deregister", "ctrl_c"));
        app.exit();
      }
    },
    { isActive: !disableRawInput },
  );

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const visibleMessages = useMemo(() => {
    if (state.threadFilter === null) return state.messages;
    return state.messages.filter((m) => m.thread_id === state.threadFilter);
  }, [state.messages, state.threadFilter]);

  const connColor =
    state.connectionState === "connected"
      ? "green"
      : state.connectionState === "connecting"
        ? "yellow"
        : "red";

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold>BRIDGE </Text>
        <Text color="cyan">{agentId} </Text>
        <Text color={connColor}>[{state.connectionState}]</Text>
        {state.threadFilter !== null && (
          <Text color="magenta"> thread:{state.threadFilter}</Text>
        )}
      </Box>

      <Static items={visibleMessages}>
        {(m: BridgeMessage): React.ReactElement => (
          <Box key={m.id}>
            <Text color="gray">[{fmtTime(m.ts)}] </Text>
            <Text color="cyan">{m.from}</Text>
            <Text>: {m.body}</Text>
          </Box>
        )}
      </Static>

      {state.notice !== null && (
        <Box>
          <Text color="yellow">{state.notice}</Text>
        </Box>
      )}

      <Box>
        <Text color="green">{"> "}</Text>
        <TextInput
          value={state.inputValue}
          onChange={handleChange}
          onSubmit={handleSubmit}
          placeholder="type a message or /help"
        />
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

export function startTui(opts: TuiProps): ReturnType<typeof render> {
  return render(<BridgeTui {...opts} />);
}

if (import.meta.main) {
  const agentId = process.env.BRIDGE_AGENT_ID;
  if (!agentId || agentId.trim().length === 0) {
    // stderr per logging convention; TUI hasn't taken stdout yet here.
    console.error("BRIDGE_AGENT_ID env var is required");
    process.exit(1);
  }
  const url = process.env.BRIDGE_URL ?? "ws://127.0.0.1:4700";
  startTui({ agentId, url });
}
