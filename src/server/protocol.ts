// Bridge protocol layer: Zod schemas for BridgeMessage envelope and helpers.
// Source of truth: Blueprint 1 §3 (Message Protocol).

import { z } from "zod";

// Network + timing constants (Blueprint 1 §3.3, §3.4, §10).
export const PORT_WS = 4700;
export const PORT_HTTP = 4701;
export const FLOOR_TIMEOUT_MS = 30000;
export const HEARTBEAT_MS = 10000;
export const OFFLINE_AFTER_MISSED = 3;

// Message types — Blueprint 1 §3.2, in table order. Do not invent or reorder.
export const MessageType = z.union([
  z.literal("chat"),
  z.literal("question"),
  z.literal("answer"),
  z.literal("status"),
  z.literal("error"),
  z.literal("ping"),
  z.literal("pong"),
  z.literal("typing"),
  z.literal("ack"),
  z.literal("register"),
  z.literal("deregister"),
  z.literal("heartbeat"),
  z.literal("floor_request"),
  z.literal("floor_grant"),
  z.literal("floor_deny"),
  z.literal("summary_request"),
  z.literal("summary"),
]);
export type MessageType = z.infer<typeof MessageType>;

// All persisted message types per Blueprint 1 §3.2 "Persisted = YES" column.
const PERSISTED_TYPES: ReadonlySet<MessageType> = new Set<MessageType>([
  "chat",
  "question",
  "answer",
  "status",
  "error",
  "register",
  "deregister",
  "summary",
]);

// Only "chat" requires floor token per Blueprint 1 §3.3.
const FLOOR_REQUIRED_TYPES: ReadonlySet<MessageType> = new Set<MessageType>([
  "chat",
]);

// Envelope schema — matches the TS interface in Blueprint 1 §3.1 exactly.
export const BridgeMessageSchema = z.object({
  id: z.string().min(1),
  ts: z.number().int().nonnegative(),
  from: z.string().min(1),
  to: z.string().min(1),
  type: MessageType,
  thread_id: z.string().min(1),
  reply_to: z.string().nullable(),
  priority: z.boolean(),
  body: z.string(),
  needs_ack: z.boolean(),
});
export type BridgeMessage = z.infer<typeof BridgeMessageSchema>;

/**
 * Parse a raw wire payload into a validated BridgeMessage.
 * Throws on invalid JSON or schema violations (callers handle in broker handler).
 */
export function parseMessage(raw: string | Buffer | Uint8Array): BridgeMessage {
  const text =
    typeof raw === "string"
      ? raw
      : // any: Buffer/Uint8Array decoding — toString is universally available on both.
        (raw as { toString(encoding?: string): string }).toString("utf8");
  const json: unknown = JSON.parse(text);
  return BridgeMessageSchema.parse(json);
}

/**
 * Encode a BridgeMessage to a JSON wire string. Validates before serializing
 * so we never put malformed envelopes on the wire.
 */
export function encodeMessage(msg: BridgeMessage): string {
  const validated = BridgeMessageSchema.parse(msg);
  return JSON.stringify(validated);
}

/** True iff a message of this type is persisted to SQLite (Blueprint 1 §3.2). */
export function isPersistedType(type: MessageType): boolean {
  return PERSISTED_TYPES.has(type);
}

/** True iff sending this type requires holding the floor (Blueprint 1 §3.3). */
export function requiresFloor(type: MessageType): boolean {
  return FLOOR_REQUIRED_TYPES.has(type);
}
