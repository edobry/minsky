/**
 * Tests for inbound principal-channel routing (mt#3228).
 *
 * The authorization cases matter most: an accepted message becomes a user turn
 * in a local `claude` process, so a hole here is an RCE-adjacent hole.
 */

import { describe, expect, test } from "bun:test";
import {
  buildInboundEventPayload,
  inboundEventToken,
  routeInboundMessage,
  type InboundAuthorization,
} from "./principal-inbound";
import type { InboundTelegramMessage } from "./telegram-transport";

const ALLOWED_CHAT = "167346572";
const AUTH: InboundAuthorization = { allowedChatId: ALLOWED_CHAT };
const CHAT_NOT_ALLOWED = "chat-not-allowed";

function message(overrides: Partial<InboundTelegramMessage> = {}): InboundTelegramMessage {
  return {
    updateId: 100,
    messageId: 5,
    chatId: ALLOWED_CHAT,
    fromId: "777",
    text: "what is blocked?",
    date: 1700000000,
    replyToMessageId: undefined,
    ...overrides,
  };
}

describe("routeInboundMessage — authorization", () => {
  test("rejects a message from any other chat", () => {
    const route = routeInboundMessage(message({ chatId: "999" }), AUTH);
    expect(route).toEqual({ kind: "rejected", reason: CHAT_NOT_ALLOWED });
  });

  test("allows any sender in the allowed chat when no sender list is set", () => {
    const route = routeInboundMessage(message({ fromId: "someone-else" }), AUTH);
    expect(route.kind).toBe("channel-agent");
  });

  test("enforces the sender list when one is set", () => {
    const auth: InboundAuthorization = { allowedChatId: ALLOWED_CHAT, allowedUserIds: ["777"] };
    expect(routeInboundMessage(message({ fromId: "777" }), auth).kind).toBe("channel-agent");
    expect(routeInboundMessage(message({ fromId: "888" }), auth)).toEqual({
      kind: "rejected",
      reason: "sender-not-allowed",
    });
  });

  test("rejects an unknown sender when a sender list is set", () => {
    const auth: InboundAuthorization = { allowedChatId: ALLOWED_CHAT, allowedUserIds: ["777"] };
    expect(routeInboundMessage(message({ fromId: undefined }), auth)).toEqual({
      kind: "rejected",
      reason: "sender-not-allowed",
    });
  });

  test("an empty sender list does not lock the channel out", () => {
    const auth: InboundAuthorization = { allowedChatId: ALLOWED_CHAT, allowedUserIds: [] };
    expect(routeInboundMessage(message(), auth).kind).toBe("channel-agent");
  });

  test("checks the chat before anything else, including command parsing", () => {
    const route = routeInboundMessage(message({ chatId: "999", text: "/answer abc yes" }), AUTH);
    expect(route).toEqual({ kind: "rejected", reason: CHAT_NOT_ALLOWED });
  });
});

describe("routeInboundMessage — explicit commands", () => {
  test("/answer routes to an ask response, splitting ref from text", () => {
    const route = routeInboundMessage(
      message({ text: "/answer 38b1c0de go with the second option" }),
      AUTH
    );
    expect(route).toEqual({
      kind: "ask-response",
      askRef: "38b1c0de",
      text: "go with the second option",
    });
  });

  test("/answer keeps multi-line response text intact", () => {
    const route = routeInboundMessage(message({ text: "/answer abc line one\nline two" }), AUTH);
    expect(route).toMatchObject({ kind: "ask-response", text: "line one\nline two" });
  });

  test("/answer without response text is not a command", () => {
    // Falls through rather than erroring — the agent can ask what they meant.
    expect(routeInboundMessage(message({ text: "/answer abc" }), AUTH).kind).toBe("channel-agent");
  });

  test("/stop and /halt interrupt", () => {
    expect(routeInboundMessage(message({ text: "/stop" }), AUTH)).toEqual({ kind: "interrupt" });
    expect(routeInboundMessage(message({ text: "/halt" }), AUTH)).toEqual({ kind: "interrupt" });
  });

  test("/new and /reset start a fresh conversation", () => {
    expect(routeInboundMessage(message({ text: "/new" }), AUTH)).toEqual({ kind: "reset" });
    expect(routeInboundMessage(message({ text: "/reset" }), AUTH)).toEqual({ kind: "reset" });
  });

  test("commands are case-insensitive and tolerate surrounding whitespace", () => {
    expect(routeInboundMessage(message({ text: "  /STOP  " }), AUTH)).toEqual({
      kind: "interrupt",
    });
  });

  test("a word that merely starts with stop is not the command", () => {
    expect(routeInboundMessage(message({ text: "/stopwatch" }), AUTH).kind).toBe("channel-agent");
  });
});

describe("routeInboundMessage — default", () => {
  test("free text goes to the channel agent", () => {
    const route = routeInboundMessage(message({ text: "how is the soak test?" }), AUTH);
    expect(route).toEqual({
      kind: "channel-agent",
      text: "how is the soak test?",
      replyToMessageId: undefined,
    });
  });

  test("an unrecognized slash command falls through rather than erroring", () => {
    expect(routeInboundMessage(message({ text: "/deploy everything" }), AUTH).kind).toBe(
      "channel-agent"
    );
  });

  test("carries the reply target through for threading", () => {
    const route = routeInboundMessage(message({ replyToMessageId: 13 }), AUTH);
    expect(route).toMatchObject({ kind: "channel-agent", replyToMessageId: 13 });
  });

  test("whitespace-only text is rejected", () => {
    expect(routeInboundMessage(message({ text: "   \n  " }), AUTH)).toEqual({
      kind: "rejected",
      reason: "empty-text",
    });
  });
});

describe("audit payload", () => {
  test("token is derived from the update id", () => {
    expect(inboundEventToken(42)).toBe("telegram:update:42");
  });

  test("an accepted message records its text and route", () => {
    const msg = message({ text: "status?" });
    const payload = buildInboundEventPayload(msg, routeInboundMessage(msg, AUTH));

    expect(payload).toEqual({
      token: "telegram:update:100",
      updateId: 100,
      messageId: 5,
      route: "channel-agent",
      text: "status?",
      sentAt: 1700000000,
    });
  });

  test("a rejected message records the reason but NOT the text", () => {
    // An unauthorized chat must not be able to write attacker-chosen content
    // into the principal's event log, which the activity feed renders.
    const msg = message({ chatId: "999", text: "click https://evil.example" });
    const payload = buildInboundEventPayload(msg, routeInboundMessage(msg, AUTH));

    expect(payload.text).toBeUndefined();
    expect(payload.rejectionReason).toBe(CHAT_NOT_ALLOWED);
    expect(payload.updateId).toBe(100);
  });

  test("omits sentAt when Telegram did not supply a date", () => {
    const msg = message({ date: undefined });
    const payload = buildInboundEventPayload(msg, routeInboundMessage(msg, AUTH));
    expect("sentAt" in payload).toBe(false);
  });
});
