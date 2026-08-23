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
  MAX_STORED_TEXT,
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
    replyToText: undefined,
    attachments: [],
    unsupportedMedia: undefined,
    messageThreadId: undefined,
    isTopicMessage: false,
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

  // mt#3507
  test("/bind extracts the task ref", () => {
    const route = routeInboundMessage(message({ text: "/bind mt#3507" }), AUTH);
    expect(route).toEqual({ kind: "bind", taskRef: "mt#3507" });
  });

  test("/bind is case-insensitive and tolerates surrounding whitespace", () => {
    expect(routeInboundMessage(message({ text: "  /BIND mt#42  " }), AUTH)).toEqual({
      kind: "bind",
      taskRef: "mt#42",
    });
  });

  test("/bind with no task ref is not a command", () => {
    // Mirrors /answer-with-no-text: falls through so the agent can ask what
    // was meant, rather than erroring at a human typing naturally.
    expect(routeInboundMessage(message({ text: "/bind" }), AUTH).kind).toBe("channel-agent");
  });

  test("a word that merely starts with bind is not the command", () => {
    expect(routeInboundMessage(message({ text: "/bindery mt#1" }), AUTH).kind).toBe(
      "channel-agent"
    );
  });

  test("/bind carries whatever ref the principal typed, malformed or not — validation is downstream", () => {
    // The router does no I/O, so it cannot tell a malformed ref from a real
    // one; that check belongs to whatever carries the route out.
    const route = routeInboundMessage(message({ text: "/bind not-a-task-id" }), AUTH);
    expect(route).toEqual({ kind: "bind", taskRef: "not-a-task-id" });
  });
});

describe("routeInboundMessage — default", () => {
  test("free text goes to the channel agent", () => {
    const route = routeInboundMessage(message({ text: "how is the soak test?" }), AUTH);
    expect(route).toEqual({
      kind: "channel-agent",
      text: "how is the soak test?",
      replyToMessageId: undefined,
      replyToText: undefined,
      attachments: [],
      unsupportedMedia: undefined,
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

  // mt#3243: the router already carried the reply's id; the quoted TEXT is
  // what the session driver can actually put in front of the agent.
  test("carries the quoted message's text on the channel-agent route", () => {
    const route = routeInboundMessage(
      message({ replyToMessageId: 13, replyToText: "mt#3243 is the next task" }),
      AUTH
    );
    expect(route).toMatchObject({
      kind: "channel-agent",
      replyToMessageId: 13,
      replyToText: "mt#3243 is the next task",
    });
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

  test("records that an image was part of the turn (mt#3235)", () => {
    // Without this the audit row for a captioned photo is indistinguishable
    // from a plain text message, hiding the image from the record entirely.
    const msg = message({
      text: "look at this",
      attachments: [{ fileId: "f1", mediaType: "image/jpeg", fileName: undefined }],
    });
    const payload = buildInboundEventPayload(msg, routeInboundMessage(msg, AUTH));
    expect(payload.attachmentCount).toBe(1);
  });

  // mt#3505: the router "gains a thread dimension" — the audit record must
  // say WHICH topic a message came from, or the audit trail cannot answer
  // "did this conversation actually route to the right topic?".
  test("records messageThreadId when the message arrived in a topic", () => {
    const msg = message({ text: "in a topic", messageThreadId: 749667, isTopicMessage: true });
    const payload = buildInboundEventPayload(msg, routeInboundMessage(msg, AUTH));
    expect(payload.messageThreadId).toBe(749667);
  });

  test("omits messageThreadId for a message with no topic", () => {
    const msg = message({ text: "no topic here" });
    const payload = buildInboundEventPayload(msg, routeInboundMessage(msg, AUTH));
    expect("messageThreadId" in payload).toBe(false);
  });
});

describe("routeInboundMessage — media (mt#3235)", () => {
  const IMAGE = { fileId: "f1", mediaType: "image/jpeg" as const, fileName: undefined };

  test("a caption-less photo reaches the channel agent instead of being rejected", () => {
    const route = routeInboundMessage(message({ text: "", attachments: [IMAGE] }), AUTH);
    expect(route.kind).toBe("channel-agent");
    if (route.kind === "channel-agent") {
      expect(route.attachments).toEqual([IMAGE]);
      expect(route.text).toBe("");
    }
  });

  test("media that cannot be read gets its own route, not a silent rejection", () => {
    const route = routeInboundMessage(
      message({ text: "", unsupportedMedia: "a voice message" }),
      AUTH
    );
    expect(route).toEqual({ kind: "unsupported-media", label: "a voice message" });
  });

  test("a caption alongside unreadable media still goes to the agent, carrying the label", () => {
    const route = routeInboundMessage(
      message({ text: "what do you think?", attachments: [IMAGE], unsupportedMedia: "a video" }),
      AUTH
    );
    expect(route.kind).toBe("channel-agent");
    if (route.kind === "channel-agent") expect(route.unsupportedMedia).toBe("a video");
  });

  test("an unauthorized chat is still rejected before media is considered", () => {
    // Authorization runs first, so an attacker cannot reach the media path.
    const route = routeInboundMessage(
      message({ chatId: "999", text: "", unsupportedMedia: "a voice message" }),
      AUTH
    );
    expect(route).toEqual({ kind: "rejected", reason: CHAT_NOT_ALLOWED });
  });

  test("regression: a genuinely empty message is still rejected", () => {
    const route = routeInboundMessage(message({ text: "   " }), AUTH);
    expect(route).toEqual({ kind: "rejected", reason: "empty-text" });
  });
});

describe("buildInboundEventPayload — over-length text keeps its OPENING (mt#4065)", () => {
  /** Distinctive markers at each end, so the assertion is about CONTENT, not length. */
  const OPENING = "FIRST-WORDS";
  const CLOSING = "LAST-WORDS";

  function overlongText(): string {
    const filler = "x".repeat(MAX_STORED_TEXT);
    return `${OPENING} ${filler} ${CLOSING}`;
  }

  function payloadFor(text: string) {
    const msg = message({ text });
    return buildInboundEventPayload(msg, routeInboundMessage(msg, AUTH));
  }

  test("the stored text starts with what the principal wrote first", () => {
    // Asserting by CONTENT is the whole point. The sibling defect in PR #2935
    // shipped past a test that checked only a length bound — which the
    // wrong-direction truncation satisfies perfectly.
    const payload = payloadFor(overlongText());
    expect(payload.text?.startsWith(OPENING)).toBe(true);
  });

  test("the dropped end is the tail, not the head", () => {
    const payload = payloadFor(overlongText());
    expect(payload.text).not.toContain(CLOSING);
  });

  test("a truncated payload still carries the textTruncated flag", () => {
    const payload = payloadFor(overlongText());
    expect(payload.text?.length).toBe(MAX_STORED_TEXT);
    expect(payload.textTruncated).toBe(true);
  });

  test("a message under the limit is stored byte-identical and unflagged", () => {
    const short = "what is blocked on the reviewer?";
    const payload = payloadFor(short);
    expect(payload.text).toBe(short);
    expect(payload.textTruncated).toBeUndefined();
  });

  test("a message exactly at the limit is not treated as truncated", () => {
    const exact = "y".repeat(MAX_STORED_TEXT);
    const payload = payloadFor(exact);
    expect(payload.text).toBe(exact);
    expect(payload.textTruncated).toBeUndefined();
  });

  test("the cut never severs a surrogate pair at the boundary (PR #2951 R1)", () => {
    // Surrogate-safety is the reason `safeTruncate` exists at all — an unpaired
    // surrogate survives JSON.stringify and then breaks the re-parser (mt#1598).
    // The direction tests above use plain ASCII, so they cannot reach it; this
    // puts a 4-byte emoji astride the exact cut.
    const emoji = "🔍"; // two UTF-16 code units
    const head = "z".repeat(MAX_STORED_TEXT - 1);
    const payload = payloadFor(`${head}${emoji}${"tail".repeat(50)}`);

    // The window shrinks by one to drop the lone high surrogate rather than
    // keeping it, so the stored text is one shorter than the cap.
    expect(payload.text).toBe(head);
    expect(payload.textTruncated).toBe(true);
    // The real assertion: no unpaired surrogate survived, so a round-trip works.
    expect(JSON.parse(JSON.stringify({ t: payload.text })).t).toBe(head);
  });
});
