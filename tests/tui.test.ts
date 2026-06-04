// TUI tests: render with ink-testing-library, simulate keystrokes,
// assert floor_request is sent on Enter and chat rendered after floor_grant.

import { describe, expect, test, afterEach } from "bun:test";
import React from "react";
import { render, cleanup } from "ink-testing-library";
import {
  encodeMessage,
  parseMessage,
  type BridgeMessage,
} from "../src/server/protocol.ts";
import { BridgeTui, type TuiSocket } from "../src/client/tui.tsx";

// ---------------------------------------------------------------------------
// Mock socket: in-memory, tracks every outgoing wire message, lets the test
// fire arbitrary "open" / "message" events back at the TUI.
// ---------------------------------------------------------------------------

type Listener = (evt: { data?: unknown }) => void;

interface MockSocket extends TuiSocket {
  sent: string[];
  fireOpen(): void;
  fireMessage(env: BridgeMessage): void;
  fireClose(): void;
  parsedSent(): BridgeMessage[];
}

async function flushEffects(): Promise<void> {
  // Ink mounts and React effects flush on microtasks/timers — give them room.
  await new Promise((r) => setTimeout(r, 20));
}

function createMockSocket(): MockSocket {
  const listeners = new Map<string, Listener[]>();
  const sent: string[] = [];
  // Buffer events that fire before the TUI registers listeners.
  const pending: Array<{ event: string; payload: { data?: unknown } }> = [];

  function emit(event: string, payload: { data?: unknown }): void {
    const arr = listeners.get(event);
    if (!arr || arr.length === 0) {
      pending.push({ event, payload });
      return;
    }
    for (const l of arr) l(payload);
  }

  const sock: MockSocket = {
    sent,
    send(data: string): void {
      sent.push(data);
    },
    close(): void {
      emit("close", {});
    },
    addEventListener(event, handler): void {
      const arr = listeners.get(event) ?? [];
      arr.push(handler);
      listeners.set(event, arr);
      // Drain any buffered events for this channel now.
      for (let i = pending.length - 1; i >= 0; i--) {
        const p = pending[i]!;
        if (p.event === event) {
          handler(p.payload);
          pending.splice(i, 1);
        }
      }
    },
    fireOpen(): void {
      emit("open", {});
    },
    fireMessage(env: BridgeMessage): void {
      const wire = encodeMessage(env);
      emit("message", { data: wire });
    },
    fireClose(): void {
      emit("close", {});
    },
    parsedSent(): BridgeMessage[] {
      const out: BridgeMessage[] = [];
      for (const raw of sent) {
        try {
          out.push(parseMessage(raw));
        } catch {
          /* skip non-envelopes */
        }
      }
      return out;
    },
  };
  return sock;
}

function waitMs(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BridgeTui", () => {
  test("sends register on connect open", async () => {
    const sock = createMockSocket();
    const r = render(
      React.createElement(BridgeTui, {
        agentId: "test_agent",
        socketFactory: () => sock,
        heartbeatMs: 60_000,
        disableRawInput: true,
      }),
    );
    sock.fireOpen();
    await waitMs(10);
    const sentTypes = sock.parsedSent().map((m) => m.type);
    expect(sentTypes).toContain("register");
    r.unmount();
  });

  test("Enter on chat text sends floor_request, not chat", async () => {
    const sock = createMockSocket();
    const r = render(
      React.createElement(BridgeTui, {
        agentId: "test_agent",
        socketFactory: () => sock,
        heartbeatMs: 60_000,
        disableRawInput: true,
      }),
    );
    sock.fireOpen();
    await waitMs(10);

    // Type "hello" then Enter.
    r.stdin.write("hello");
    await waitMs(10);
    r.stdin.write("\r"); // Enter
    await waitMs(10);

    const sent = sock.parsedSent();
    const floorReqs = sent.filter((m) => m.type === "floor_request");
    const chats = sent.filter((m) => m.type === "chat");
    expect(floorReqs.length).toBe(1);
    expect(floorReqs[0]!.from).toBe("test_agent");
    expect(chats.length).toBe(0); // no chat until floor grant
    r.unmount();
  });

  test("chat is sent after floor_grant arrives", async () => {
    const sock = createMockSocket();
    const r = render(
      React.createElement(BridgeTui, {
        agentId: "test_agent",
        socketFactory: () => sock,
        heartbeatMs: 60_000,
        disableRawInput: true,
      }),
    );
    sock.fireOpen();
    await waitMs(10);

    r.stdin.write("hi there");
    await waitMs(10);
    r.stdin.write("\r");
    await waitMs(10);

    // Simulate broker granting the floor.
    sock.fireMessage({
      id: "g1",
      ts: Date.now(),
      from: "bridge",
      to: "test_agent",
      type: "floor_grant",
      thread_id: "system",
      reply_to: null,
      priority: false,
      body: "",
      needs_ack: false,
    });
    await waitMs(10);

    const chats = sock.parsedSent().filter((m) => m.type === "chat");
    expect(chats.length).toBe(1);
    expect(chats[0]!.body).toBe("hi there");
    expect(chats[0]!.from).toBe("test_agent");
    r.unmount();
  });

  test("incoming chat is rendered in scrollback", async () => {
    const sock = createMockSocket();
    const r = render(
      React.createElement(BridgeTui, {
        agentId: "test_agent",
        socketFactory: () => sock,
        heartbeatMs: 60_000,
        disableRawInput: true,
      }),
    );
    sock.fireOpen();
    await waitMs(10);

    sock.fireMessage({
      id: "m1",
      ts: Date.now(),
      from: "other_agent",
      to: "all",
      type: "chat",
      thread_id: "tui",
      reply_to: null,
      priority: false,
      body: "ping from other",
      needs_ack: false,
    });
    await waitMs(10);

    const frame = r.lastFrame() ?? "";
    expect(frame).toContain("other_agent");
    expect(frame).toContain("ping from other");
    r.unmount();
  });

  test("floor_deny shows holder notice and does not send chat", async () => {
    const sock = createMockSocket();
    const r = render(
      React.createElement(BridgeTui, {
        agentId: "test_agent",
        socketFactory: () => sock,
        heartbeatMs: 60_000,
        floorRetryMs: 5_000,
        disableRawInput: true,
      }),
    );
    sock.fireOpen();
    await waitMs(10);

    r.stdin.write("yo");
    await waitMs(10);
    r.stdin.write("\r");
    await waitMs(10);

    sock.fireMessage({
      id: "d1",
      ts: Date.now(),
      from: "bridge",
      to: "test_agent",
      type: "floor_deny",
      thread_id: "system",
      reply_to: null,
      priority: false,
      body: "other_agent",
      needs_ack: false,
    });
    await waitMs(10);

    const frame = r.lastFrame() ?? "";
    expect(frame).toContain("floor held by other_agent");
    const chats = sock.parsedSent().filter((m) => m.type === "chat");
    expect(chats.length).toBe(0);
    r.unmount();
  });

  test("/ask slash command sends question to specified agent", async () => {
    const sock = createMockSocket();
    const r = render(
      React.createElement(BridgeTui, {
        agentId: "test_agent",
        socketFactory: () => sock,
        heartbeatMs: 60_000,
        disableRawInput: true,
      }),
    );
    sock.fireOpen();
    await waitMs(10);

    r.stdin.write("/ask other_agent did it work");
    await waitMs(10);
    r.stdin.write("\r");
    await waitMs(10);

    const questions = sock.parsedSent().filter((m) => m.type === "question");
    expect(questions.length).toBe(1);
    expect(questions[0]!.to).toBe("other_agent");
    expect(questions[0]!.body).toBe("did it work");
    r.unmount();
  });
});
