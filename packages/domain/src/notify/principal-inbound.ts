/**
 * Inbound routing for the principal channel (mt#3228).
 *
 * Pure decision logic: given one inbound Telegram message, decide what should
 * happen to it. No I/O, no side effects — the poller owns those, so every
 * routing rule (especially the authorization rules) is testable without a
 * network, a database, or a spawned agent.
 *
 * ## Almost everything routes to the channel agent, on purpose
 *
 * The router does NOT try to classify intent. Free text goes to a standing
 * conversation with full substrate access, which figures out what the principal
 * meant and acts. Ashby's law is the reason: the principal on a phone is a
 * low-variety controller of a high-variety swarm, so the channel's job is to
 * AMPLIFY — one sentence in, real work out. A routing table cannot do that; an
 * agent with tools can. Encoding intent classification here would cap the
 * channel's variety at whatever cases someone thought to enumerate.
 *
 * The explicit commands exist only where a deterministic path is strictly
 * better than an agent turn: answering a specific ask by id (no ambiguity to
 * resolve), and interrupting (must preempt, not queue behind a turn).
 *
 * ## Authorization is the first thing that happens
 *
 * An accepted message becomes a user turn in a local `claude` process — an
 * RCE-adjacent surface (mt#2238 names the threat model as a success criterion).
 * The allowlist check runs before parsing, before logging, before anything.
 *
 * @see mt#3228 — the bidirectional principal channel
 * @see mt#2238 — Rung 3, remote interface / local execution
 */

import { safeTruncate } from "@minsky/shared/safe-truncate";
import type { InboundTelegramMessage } from "./telegram-transport";

/**
 * Cap on message text stored in the append-only event log.
 *
 * `system_events` rows are never deleted, so an unbounded string write is
 * permanent row bloat (PR #2324 R1 non-blocking). Telegram's own ceiling is
 * 4096 characters; 2000 keeps every realistic instruction intact while bounding
 * the pathological case. The full text was never the artifact of record here —
 * the conversation transcript is.
 */
export const MAX_STORED_TEXT = 2000;

/** Who is permitted to drive this channel. */
export interface InboundAuthorization {
  /** The one chat this channel serves. Any other chat is rejected outright. */
  allowedChatId: string;
  /**
   * Permitted sender ids within that chat. Empty/omitted means "any sender in
   * the allowed chat" — correct for a 1:1 private chat, which is what a
   * discovered chat id is. In a group, set this.
   */
  allowedUserIds?: string[];
}

export type InboundRejectionReason = "chat-not-allowed" | "sender-not-allowed" | "empty-text";

export type InboundRoute =
  /** Dropped before any side effect. Counted, never acted on. */
  | { kind: "rejected"; reason: InboundRejectionReason }
  /** Answer a specific ask by id, with no agent turn in between. */
  | { kind: "ask-response"; askRef: string; text: string }
  /** Interrupt whatever the channel session is doing. */
  | { kind: "interrupt" }
  /** Abandon the current channel conversation and start a fresh one. */
  | { kind: "reset" }
  /** The default: hand the text to the standing channel conversation. */
  | { kind: "channel-agent"; text: string; replyToMessageId: number | undefined };

/** `/answer <ask-ref> <text>` — the ref is a uuid, a short id, or a prefix. */
const ANSWER_COMMAND_RE = /^\/answer\s+(\S+)\s+([\s\S]+)$/i;
const INTERRUPT_COMMAND_RE = /^\/(stop|halt)\s*$/i;
const RESET_COMMAND_RE = /^\/(new|reset)\s*$/i;

/**
 * Decide what to do with one inbound message.
 *
 * Unrecognized `/slash` input is deliberately NOT an error — it falls through
 * to the channel agent, which can explain itself. A channel that answers
 * "unknown command" to a human typing naturally is a channel they stop using.
 */
export function routeInboundMessage(
  message: InboundTelegramMessage,
  auth: InboundAuthorization
): InboundRoute {
  if (message.chatId !== auth.allowedChatId) {
    return { kind: "rejected", reason: "chat-not-allowed" };
  }
  if (
    auth.allowedUserIds &&
    auth.allowedUserIds.length > 0 &&
    (message.fromId === undefined || !auth.allowedUserIds.includes(message.fromId))
  ) {
    return { kind: "rejected", reason: "sender-not-allowed" };
  }

  const text = message.text.trim();
  if (text.length === 0) {
    return { kind: "rejected", reason: "empty-text" };
  }

  const answer = text.match(ANSWER_COMMAND_RE);
  if (answer?.[1] && answer[2]) {
    return { kind: "ask-response", askRef: answer[1], text: answer[2].trim() };
  }
  if (INTERRUPT_COMMAND_RE.test(text)) {
    return { kind: "interrupt" };
  }
  if (RESET_COMMAND_RE.test(text)) {
    return { kind: "reset" };
  }

  return {
    kind: "channel-agent",
    text,
    replyToMessageId: message.replyToMessageId,
  };
}

// ---------------------------------------------------------------------------
// Audit record
// ---------------------------------------------------------------------------

/**
 * Payload of the `principal.message_received` system event.
 *
 * Written for EVERY accepted message before any side effect runs, which makes
 * the append-only event log serve three jobs at once: the audit trail for an
 * RCE-adjacent surface, the poll cursor across restarts, and the idempotency
 * record that absorbs a replay. Telegram retains undelivered updates for 24h,
 * so a poller that restarts without a persisted cursor re-receives up to a
 * day of messages — `token` is what makes that harmless.
 */
export interface PrincipalMessageEventPayload {
  /** Idempotency key. `telegram:update:<update_id>`; matched via payload->>'token'. */
  token: string;
  updateId: number;
  messageId: number;
  /** Which branch the router chose, so the log explains what was done and why. */
  route: InboundRoute["kind"];
  /** Present only on a rejection. */
  rejectionReason?: InboundRejectionReason;
  /**
   * The message text, bounded by {@link MAX_STORED_TEXT}. Absent on a
   * rejection — unauthorized content is not stored.
   */
  text?: string;
  /** True when `text` was clipped to fit the bound. */
  textTruncated?: boolean;
  /** Telegram's send time, distinct from when this row was written. */
  sentAt?: number;
  /** Why carrying the message out failed. Only on `principal.message_failed`. */
  failureDetail?: string;
}

/** Build the idempotency token for an update id. */
export function inboundEventToken(updateId: number): string {
  return `telegram:update:${updateId}`;
}

/**
 * Build the audit payload for one routed message.
 *
 * A rejected message's TEXT is deliberately omitted: an unauthorized chat can
 * otherwise write arbitrary attacker-chosen content into the principal's event
 * log, which the cockpit activity feed renders. The metadata needed to notice
 * and investigate an intrusion attempt (that it happened, when, which update)
 * is all retained.
 */
export function buildInboundEventPayload(
  message: InboundTelegramMessage,
  route: InboundRoute
): PrincipalMessageEventPayload {
  const base: PrincipalMessageEventPayload = {
    token: inboundEventToken(message.updateId),
    updateId: message.updateId,
    messageId: message.messageId,
    route: route.kind,
    ...(message.date === undefined ? {} : { sentAt: message.date }),
  };

  if (route.kind === "rejected") {
    return { ...base, rejectionReason: route.reason };
  }

  const text = safeTruncate(message.text, MAX_STORED_TEXT);
  return {
    ...base,
    text,
    ...(text.length < message.text.length ? { textTruncated: true } : {}),
  };
}
