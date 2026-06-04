// Tests for src/server/protocol.ts — Blueprint 1 §3 conformance.
// Covers: round-trip of every MessageType, invalid JSON, missing fields,
// isPersistedType table parity, requiresFloor true-only-for-chat.

import { describe, test, expect } from "bun:test";
import {
  BridgeMessageSchema,
  parseMessage,
  encodeMessage,
  isPersistedType,
  requiresFloor,
  PORT_WS,
  PORT_HTTP,
  FLOOR_TIMEOUT_MS,
  HEARTBEAT_MS,
  OFFLINE_AFTER_MISSED,
  type BridgeMessage,
  type MessageType,
} from "../src/server/protocol";

const ALL_TYPES: MessageType[] = [
  "chat",
  "question",
  "answer",
  "status",
  "error",
  "ping",
  "pong",
  "typing",
  "ack",
  "register",
  "deregister",
  "heartbeat",
  "floor_request",
  "floor_grant",
  "floor_deny",
  "summary_request",
  "summary",
];

// Persisted = YES rows in Blueprint 1 §3.2.
const EXPECTED_PERSISTED: ReadonlySet<MessageType> = new Set<MessageType>([
  "chat",
  "question",
  "answer",
  "status",
  "error",
  "register",
  "deregister",
  "summary",
]);

function makeMsg(type: MessageType): BridgeMessage {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    ts: 1_700_000_000_000,
    from: "aegis_agent",
    to: "marea_agent",
    type,
    thread_id: "22222222-2222-2222-2222-222222222222",
    reply_to: null,
    priority: false,
    body: `body for ${type}`,
    needs_ack: false,
  };
}

describe("constants", () => {
  test("match Blueprint 1 values", () => {
    expect(PORT_WS).toBe(4700);
    expect(PORT_HTTP).toBe(4701);
    expect(FLOOR_TIMEOUT_MS).toBe(30000);
    expect(HEARTBEAT_MS).toBe(10000);
    expect(OFFLINE_AFTER_MISSED).toBe(3);
  });
});

describe("encode/parse round-trip", () => {
  for (const t of ALL_TYPES) {
    test(`type=${t} round-trips`, () => {
      const original = makeMsg(t);
      const wire = encodeMessage(original);
      expect(typeof wire).toBe("string");
      const decoded = parseMessage(wire);
      expect(decoded).toEqual(original);
    });
  }

  test("Buffer input parses identically to string", () => {
    const msg = makeMsg("chat");
    const wire = encodeMessage(msg);
    const buf = Buffer.from(wire, "utf8");
    expect(parseMessage(buf)).toEqual(msg);
  });

  test("reply_to may be a string (answer linking)", () => {
    const msg: BridgeMessage = {
      ...makeMsg("answer"),
      reply_to: "33333333-3333-3333-3333-333333333333",
    };
    expect(parseMessage(encodeMessage(msg))).toEqual(msg);
  });
});

describe("parseMessage rejection", () => {
  test("invalid JSON throws", () => {
    expect(() => parseMessage("{not json")).toThrow();
    expect(() => parseMessage("")).toThrow();
  });

  test("missing required field throws", () => {
    const { body: _omit, ...partial } = makeMsg("chat");
    void _omit;
    expect(() => parseMessage(JSON.stringify(partial))).toThrow();
  });

  test("unknown type literal throws", () => {
    const bad = { ...makeMsg("chat"), type: "gossip" };
    expect(() => parseMessage(JSON.stringify(bad))).toThrow();
  });

  test("wrong primitive type throws", () => {
    const bad = { ...makeMsg("chat"), ts: "not-a-number" };
    expect(() => parseMessage(JSON.stringify(bad))).toThrow();
  });

  test("non-object root throws", () => {
    expect(() => parseMessage("null")).toThrow();
    expect(() => parseMessage("42")).toThrow();
    expect(() => parseMessage("[]")).toThrow();
  });
});

describe("encodeMessage validates", () => {
  test("rejects malformed envelope before serializing", () => {
    // any: deliberately bypassing type system to test runtime guard.
    const bad = { ...makeMsg("chat"), id: 123 } as unknown as BridgeMessage;
    expect(() => encodeMessage(bad)).toThrow();
  });
});

describe("isPersistedType matches Blueprint 1 §3.2", () => {
  for (const t of ALL_TYPES) {
    test(`${t} → ${EXPECTED_PERSISTED.has(t)}`, () => {
      expect(isPersistedType(t)).toBe(EXPECTED_PERSISTED.has(t));
    });
  }
});

describe("requiresFloor: only chat", () => {
  for (const t of ALL_TYPES) {
    test(`${t}`, () => {
      expect(requiresFloor(t)).toBe(t === "chat");
    });
  }
});

describe("schema export", () => {
  test("BridgeMessageSchema parses a valid envelope", () => {
    expect(() => BridgeMessageSchema.parse(makeMsg("status"))).not.toThrow();
  });
});
