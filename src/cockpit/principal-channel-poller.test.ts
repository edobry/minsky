/**
 * Tests for the inbound principal-channel poll cycle (mt#3228).
 *
 * Everything is injected — no network, no DB, no spawned `claude`. The cases
 * that matter most are the ones a live test could not reliably produce: the
 * audit-before-action ordering, cursor advancement past unparseable updates,
 * and the promise that an actuator failure still reaches the principal.
 */

import { describe, expect, test } from "bun:test";
import {
  runPollCycle,
  truncateReply,
  type ChannelActuator,
  type PollCursor,
  type PollCycleDeps,
} from "./principal-channel-poller";
import type { PrincipalMessageEventPayload } from "@minsky/domain/notify/principal-inbound";
import type { FetchFn } from "@minsky/domain/notify/telegram-transport";

const TOKEN = "tok";
const CHAT = "167346572";
const GET_UPDATES = "/getUpdates";
const SEND_MESSAGE = "/sendMessage";

interface Recorded {
  type: string;
  payload: PrincipalMessageEventPayload;
}

interface Harness {
  deps: PollCycleDeps;
  recorded: Recorded[];
  sentTexts: string[];
  actuatorCalls: string[];
  cursorWrites: number[];
  order: string[];
  /** The harness's own fetch, so a test can wrap it to inspect one request. */
  baseFetch: FetchFn;
}

function updateBody(
  messages: Array<{ updateId: number; text: string; chatId?: string; messageId?: number }>,
  extraUpdates: unknown[] = []
): unknown {
  return {
    ok: true,
    result: [
      ...messages.map((m) => ({
        update_id: m.updateId,
        message: {
          message_id: m.messageId ?? m.updateId,
          date: 1700000000,
          chat: { id: m.chatId ?? CHAT, type: "private" },
          from: { id: 777 },
          text: m.text,
        },
      })),
      ...extraUpdates,
    ],
  };
}

function harness(
  body: unknown,
  overrides: {
    actuator?: Partial<ChannelActuator>;
    cursorStart?: number;
    recordEventThrows?: boolean;
  } = {}
): Harness {
  const recorded: Recorded[] = [];
  const sentTexts: string[] = [];
  const actuatorCalls: string[] = [];
  const cursorWrites: number[] = [];
  const order: string[] = [];

  const actuator: ChannelActuator = {
    converse: async (text) => {
      actuatorCalls.push(`converse:${text}`);
      order.push("act");
      return `answered: ${text}`;
    },
    interrupt: async () => {
      actuatorCalls.push("interrupt");
      order.push("act");
      return "stopped";
    },
    reset: async () => {
      actuatorCalls.push("reset");
      order.push("act");
      return "fresh conversation";
    },
    answerAsk: async (ref, text) => {
      actuatorCalls.push(`answerAsk:${ref}:${text}`);
      order.push("act");
      return `ask ${ref} answered`;
    },
    ...overrides.actuator,
  };

  const cursor: PollCursor = {
    read: async () => overrides.cursorStart,
    write: async (id) => {
      cursorWrites.push(id);
    },
  };

  const baseFetch: FetchFn = async (url, init) => {
    const target = String(url);
    if (target.includes(GET_UPDATES)) {
      return new Response(JSON.stringify(body));
    }
    if (target.includes(SEND_MESSAGE)) {
      const parsed = JSON.parse(String(init?.body)) as { text: string };
      sentTexts.push(parsed.text);
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    }
    // sendChatAction
    return new Response(JSON.stringify({ ok: true, result: true }));
  };

  const deps: PollCycleDeps = {
    token: TOKEN,
    chatId: CHAT,
    auth: { allowedChatId: CHAT },
    actuator,
    cursor,
    recordEvent: async (type, payload) => {
      order.push("record");
      if (overrides.recordEventThrows) throw new Error("db down");
      recorded.push({ type, payload });
    },
    fetchFn: baseFetch,
  };

  return { deps, recorded, sentTexts, actuatorCalls, cursorWrites, order, baseFetch };
}

describe("runPollCycle — happy path", () => {
  test("routes free text to the channel agent and replies with its output", async () => {
    const h = harness(updateBody([{ updateId: 5, text: "what is blocked?" }]));
    const outcome = await runPollCycle(h.deps);

    expect(outcome).toEqual({ received: 1, handled: 1, rejected: 0 });
    expect(h.actuatorCalls).toEqual(["converse:what is blocked?"]);
    expect(h.sentTexts).toEqual(["answered: what is blocked?"]);
  });

  test("routes /answer straight to the ask, with no agent turn", async () => {
    const h = harness(updateBody([{ updateId: 5, text: "/answer abc123 yes do it" }]));
    await runPollCycle(h.deps);
    expect(h.actuatorCalls).toEqual(["answerAsk:abc123:yes do it"]);
  });

  test("routes /stop to interrupt", async () => {
    const h = harness(updateBody([{ updateId: 5, text: "/stop" }]));
    await runPollCycle(h.deps);
    expect(h.actuatorCalls).toEqual(["interrupt"]);
  });

  test("handles several messages in the order they were sent", async () => {
    // Two messages in a row are turns in one conversation; racing them would
    // interleave and destroy the grounding the standing session provides.
    const h = harness(
      updateBody([
        { updateId: 5, text: "first" },
        { updateId: 6, text: "second" },
      ])
    );
    await runPollCycle(h.deps);
    expect(h.actuatorCalls).toEqual(["converse:first", "converse:second"]);
  });

  test("threads the reply to the message it answers", async () => {
    let replyTarget: unknown;
    const h = harness(updateBody([{ updateId: 5, text: "hi", messageId: 42 }]));
    h.deps.fetchFn = async (url, init) => {
      if (String(url).includes("/sendMessage")) {
        replyTarget = (JSON.parse(String(init?.body)) as Record<string, unknown>)[
          "reply_to_message_id"
        ];
      }
      return h.baseFetch(url, init);
    };
    await runPollCycle(h.deps);
    expect(replyTarget).toBe(42);
  });
});

describe("runPollCycle — authorization", () => {
  test("refuses another chat, records it, and never reaches the actuator", async () => {
    const h = harness(updateBody([{ updateId: 5, text: "rm -rf /", chatId: "999" }]));
    const outcome = await runPollCycle(h.deps);

    expect(outcome).toEqual({ received: 1, handled: 0, rejected: 1 });
    expect(h.actuatorCalls).toEqual([]);
    expect(h.sentTexts).toEqual([]);
    expect(h.recorded[0]?.type).toBe("principal.message_rejected");
  });

  test("a refused message's text is not written to the audit log", async () => {
    const h = harness(updateBody([{ updateId: 5, text: "attacker content", chatId: "999" }]));
    await runPollCycle(h.deps);
    expect(h.recorded[0]?.payload.text).toBeUndefined();
    expect(h.recorded[0]?.payload.rejectionReason).toBe("chat-not-allowed");
  });

  test("still advances the cursor past a refused update", async () => {
    // Otherwise one unauthorized message wedges the channel permanently.
    const h = harness(updateBody([{ updateId: 5, text: "nope", chatId: "999" }]));
    await runPollCycle(h.deps);
    expect(h.cursorWrites).toEqual([5]);
  });
});

describe("runPollCycle — audit", () => {
  test("records the event BEFORE running the actuator", async () => {
    const h = harness(updateBody([{ updateId: 5, text: "go" }]));
    await runPollCycle(h.deps);
    expect(h.order).toEqual(["record", "act"]);
  });

  test("a recorder failure does not drop the message", async () => {
    // A Postgres blip must not make the channel unresponsive.
    const h = harness(updateBody([{ updateId: 5, text: "go" }]), { recordEventThrows: true });
    const outcome = await runPollCycle(h.deps);
    expect(outcome.handled).toBe(1);
    expect(h.sentTexts).toEqual(["answered: go"]);
  });

  test("carries the idempotency token so a replay is absorbable", async () => {
    const h = harness(updateBody([{ updateId: 5, text: "go" }]));
    await runPollCycle(h.deps);
    expect(h.recorded[0]?.payload.token).toBe("telegram:update:5");
  });
});

describe("runPollCycle — cursor", () => {
  test("asks Telegram for the update after the last one seen", async () => {
    let sentOffset: unknown;
    const h = harness(updateBody([]), { cursorStart: 41 });
    h.deps.fetchFn = async (url, init) => {
      if (String(url).includes("/getUpdates")) {
        sentOffset = (JSON.parse(String(init?.body)) as Record<string, unknown>)["offset"];
      }
      return h.baseFetch(url, init);
    };
    await runPollCycle(h.deps);
    expect(sentOffset).toBe(42);
  });

  test("omits the offset on a cold start", async () => {
    let body: Record<string, unknown> = {};
    const h = harness(updateBody([]));
    h.deps.fetchFn = async (url, init) => {
      if (String(url).includes("/getUpdates")) body = JSON.parse(String(init?.body));
      return h.baseFetch(url, init);
    };
    await runPollCycle(h.deps);
    expect("offset" in body).toBe(false);
  });

  test("advances past an update the parser skipped", async () => {
    // A cursor derived from PARSED messages would re-fetch the unparseable
    // update forever, wedging the channel behind it.
    const h = harness(
      updateBody([{ updateId: 5, text: "ok" }], [{ update_id: 6, edited_message: { id: 1 } }])
    );
    await runPollCycle(h.deps);
    expect(h.cursorWrites).toEqual([6]);
  });

  test("does not move the cursor when nothing arrived", async () => {
    const h = harness(updateBody([]));
    await runPollCycle(h.deps);
    expect(h.cursorWrites).toEqual([]);
  });
});

describe("runPollCycle — failure handling", () => {
  test("reports a poll failure without throwing", async () => {
    const h = harness(updateBody([]));
    h.deps.fetchFn = async () => new Response("boom", { status: 500 });
    const outcome = await runPollCycle(h.deps);
    expect(outcome.received).toBe(0);
    expect(outcome.error).toContain("500");
  });

  test("does not advance the cursor on a failed poll", async () => {
    const h = harness(updateBody([]));
    h.deps.fetchFn = async () => new Response("boom", { status: 500 });
    await runPollCycle(h.deps);
    expect(h.cursorWrites).toEqual([]);
  });

  test("tells the principal when the actuator fails, rather than going silent", async () => {
    const h = harness(updateBody([{ updateId: 5, text: "go" }]), {
      actuator: {
        converse: async () => {
          throw new Error("claude binary not found");
        },
      },
    });
    const outcome = await runPollCycle(h.deps);

    expect(outcome.handled).toBe(1);
    expect(h.sentTexts[0]).toContain("claude binary not found");
  });

  test("sends a placeholder rather than an empty message", async () => {
    const h = harness(updateBody([{ updateId: 5, text: "go" }]), {
      actuator: { converse: async () => "   " },
    });
    await runPollCycle(h.deps);
    expect(h.sentTexts).toEqual(["(no output)"]);
  });
});

describe("truncateReply", () => {
  test("leaves a short reply alone", () => {
    expect(truncateReply("short", 100)).toBe("short");
  });

  test("keeps the END of an over-long reply", () => {
    // An agent's answer puts its conclusion last.
    const text = `${"a".repeat(200)}THE ANSWER`;
    const result = truncateReply(text, 60);
    expect(result.length).toBeLessThanOrEqual(60);
    expect(result).toContain("THE ANSWER");
    expect(result).toStartWith("[...truncated...]");
  });
});
