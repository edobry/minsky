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
    /** Update ids the recorder reports as already-recorded replays. */
    duplicateUpdateIds?: number[];
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
      return overrides.duplicateUpdateIds?.includes(payload.updateId) ? "duplicate" : "recorded";
    },
    fetchFn: baseFetch,
  };

  return { deps, recorded, sentTexts, actuatorCalls, cursorWrites, order, baseFetch };
}

describe("runPollCycle — happy path", () => {
  test("routes free text to the channel agent and replies with its output", async () => {
    const h = harness(updateBody([{ updateId: 5, text: "what is blocked?" }]));
    const outcome = await runPollCycle(h.deps);

    expect(outcome).toEqual({ received: 1, handled: 1, failed: 0, rejected: 0, duplicates: 0 });
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

    expect(outcome).toEqual({ received: 1, handled: 0, failed: 0, rejected: 1, duplicates: 0 });
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

describe("runPollCycle — replay dedupe (PR #2324 R1)", () => {
  test("a duplicate is NOT acted on", async () => {
    // The regression this whole branch exists for: the recorder used to signal
    // a replay by throwing, which landed in the same catch as a DB failure —
    // so the poller logged it and executed the replay anyway.
    const h = harness(updateBody([{ updateId: 5, text: "deploy everything" }]), {
      duplicateUpdateIds: [5],
    });
    const outcome = await runPollCycle(h.deps);

    expect(outcome).toEqual({ received: 1, handled: 0, failed: 0, rejected: 0, duplicates: 1 });
    expect(h.actuatorCalls).toEqual([]);
    expect(h.sentTexts).toEqual([]);
  });

  test("a duplicate does not block the fresh messages beside it", async () => {
    const h = harness(
      updateBody([
        { updateId: 5, text: "old" },
        { updateId: 6, text: "new" },
      ]),
      { duplicateUpdateIds: [5] }
    );
    const outcome = await runPollCycle(h.deps);

    expect(h.actuatorCalls).toEqual(["converse:new"]);
    expect(outcome.duplicates).toBe(1);
    expect(outcome.handled).toBe(1);
  });

  test("a duplicate still advances the cursor", async () => {
    const h = harness(updateBody([{ updateId: 5, text: "old" }]), { duplicateUpdateIds: [5] });
    await runPollCycle(h.deps);
    expect(h.cursorWrites).toEqual([5]);
  });

  test("a recorder ERROR is not treated as a duplicate", async () => {
    // The two must stay distinguishable: a DB outage means "proceed anyway",
    // a duplicate means "stop". Collapsing them is what caused the bug.
    const h = harness(updateBody([{ updateId: 5, text: "go" }]), { recordEventThrows: true });
    const outcome = await runPollCycle(h.deps);

    expect(outcome.duplicates).toBe(0);
    expect(outcome.handled).toBe(1);
    expect(h.actuatorCalls).toEqual(["converse:go"]);
  });
});

describe("runPollCycle — failure outcome (PR #2324 R1)", () => {
  const failing = { converse: async (): Promise<string> => Promise.reject(new Error("no binary")) };

  test("a failed actuator counts as failed, not handled", async () => {
    const h = harness(updateBody([{ updateId: 5, text: "go" }]), { actuator: failing });
    const outcome = await runPollCycle(h.deps);

    expect(outcome.handled).toBe(0);
    expect(outcome.failed).toBe(1);
  });

  test("records a failure outcome event so the log says whether it worked", async () => {
    const h = harness(updateBody([{ updateId: 5, text: "go" }]), { actuator: failing });
    await runPollCycle(h.deps);

    const failure = h.recorded.find((r) => r.type === "principal.message_failed");
    expect(failure).toBeDefined();
    expect(failure?.payload.failureDetail).toContain("no binary");
  });

  test("the failure row's token differs from the pre-action row's", async () => {
    // Otherwise the recorder's own dedupe would reject it as a replay of the
    // row written moments earlier for the same update.
    const h = harness(updateBody([{ updateId: 5, text: "go" }]), { actuator: failing });
    await runPollCycle(h.deps);

    const tokens = h.recorded.map((r) => r.payload.token);
    expect(new Set(tokens).size).toBe(tokens.length);
    expect(tokens).toContain("telegram:update:5");
    expect(tokens).toContain("telegram:update:5:failed");
  });

  test("the principal is still told, despite the failure being recorded", async () => {
    const h = harness(updateBody([{ updateId: 5, text: "go" }]), { actuator: failing });
    await runPollCycle(h.deps);
    expect(h.sentTexts[0]).toContain("no binary");
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

    // Counted as failed, not handled — the message WAS acted on, but the
    // action did not succeed, and the two must stay distinguishable.
    expect(outcome.handled).toBe(0);
    expect(outcome.failed).toBe(1);
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

/**
 * Media handling end-to-end through the poll cycle (mt#3235).
 *
 * The defect these cover: an image produced no message at all, so the cursor
 * advanced past it and the principal got silence. Every case here asserts the
 * channel SAYS something — the silence is what made the bug expensive.
 */
describe("runPollCycle — media", () => {
  function mediaBody(message: Record<string, unknown>): unknown {
    return {
      ok: true,
      result: [
        {
          update_id: 30,
          message: {
            message_id: 30,
            date: 1700000000,
            chat: { id: CHAT, type: "private" },
            from: { id: 777 },
            ...message,
          },
        },
      ],
    };
  }

  const PHOTO = { photo: [{ file_id: "big", file_size: 5000 }] };

  /** Wrap the harness fetch so getFile and the file download resolve. */
  function withFileFetch(h: Harness, opts: { failFetch?: boolean } = {}): void {
    const inner = h.baseFetch;
    h.deps.fetchFn = async (url, init) => {
      const target = String(url);
      if (target.includes("getFile")) {
        if (opts.failFetch) return new Response("gone", { status: 404 });
        return new Response(JSON.stringify({ ok: true, result: { file_path: "p/a.jpg" } }));
      }
      if (target.includes("/file/bot")) return new Response(new Uint8Array([1, 2, 3]));
      return inner(url, init);
    };
  }

  test("forwards a captioned photo's bytes to the channel agent", async () => {
    let seenImages: unknown;
    const h = harness(mediaBody({ ...PHOTO, caption: "why is this blank?" }), {
      actuator: {
        converse: async (text, _replyToText, images) => {
          seenImages = images;
          return `saw: ${text}`;
        },
      },
    });
    withFileFetch(h);

    const outcome = await runPollCycle(h.deps);

    expect(outcome.handled).toBe(1);
    expect(seenImages).toEqual([{ base64: "AQID", mediaType: "image/jpeg" }]);
    expect(h.sentTexts).toEqual(["saw: why is this blank?"]);
  });

  test("a caption-less photo is still delivered, with empty text", async () => {
    let seenImages: unknown;
    const h = harness(mediaBody(PHOTO), {
      actuator: {
        converse: async (_text, _replyToText, images) => {
          seenImages = images;
          return "looked at it";
        },
      },
    });
    withFileFetch(h);

    const outcome = await runPollCycle(h.deps);

    expect(outcome.handled).toBe(1);
    expect(seenImages).toHaveLength(1);
  });

  test("a failed download degrades to a note instead of failing the turn", async () => {
    // The caption is usually the substance. Answering "I couldn't load your
    // image" beats answering nothing — and the agent must be TOLD, or it will
    // answer a question about a screenshot it never received.
    let seenText = "";
    const h = harness(mediaBody({ ...PHOTO, caption: "look at this" }), {
      actuator: {
        converse: async (text) => {
          seenText = text;
          return "ok";
        },
      },
    });
    withFileFetch(h, { failFetch: true });

    const outcome = await runPollCycle(h.deps);

    expect(outcome.handled).toBe(1);
    expect(seenText).toContain("look at this");
    expect(seenText).toContain("channel note");
    expect(seenText).toContain("could not be loaded");
  });

  test("a voice note is answered without spending an agent turn", async () => {
    const h = harness(mediaBody({ voice: { file_id: "v1", duration: 4 } }));

    const outcome = await runPollCycle(h.deps);

    expect(outcome.handled).toBe(1);
    expect(h.actuatorCalls).toEqual([]);
    expect(h.sentTexts[0]).toContain("a voice message");
    expect(h.sentTexts[0]).toContain("can't read that yet");
  });

  test("the unreadable-media reply is still recorded in the audit log", async () => {
    const h = harness(mediaBody({ voice: { file_id: "v1", duration: 4 } }));

    await runPollCycle(h.deps);

    expect(h.recorded).toHaveLength(1);
    expect(h.recorded[0]?.payload.route).toBe("unsupported-media");
  });

  test("regression: the cursor still advances past a media update", async () => {
    // The original failure mode was unrecoverable precisely because the cursor
    // advanced while the message vanished. It must still advance — the message
    // must simply no longer vanish.
    const h = harness(mediaBody({ voice: { file_id: "v1", duration: 4 } }));

    await runPollCycle(h.deps);

    expect(h.cursorWrites).toEqual([30]);
  });
});

/**
 * Reply formatting through the poll cycle (mt#3465).
 *
 * The principal reported reading literal `**bold**` on their phone, twice. The
 * unit tests for the converter prove the CONVERSION; these prove the poller
 * actually applies it on the path a real reply takes.
 */
describe("runPollCycle — reply formatting", () => {
  /** Capture the sendMessage payloads rather than just their text. */
  function harnessCapturingSends(reply: string): {
    h: Harness;
    sends: Record<string, unknown>[];
  } {
    const sends: Record<string, unknown>[] = [];
    const h = harness(updateBody([{ updateId: 40, text: "go" }]), {
      actuator: { converse: async () => reply },
    });
    const inner = h.baseFetch;
    h.deps.fetchFn = async (url, init) => {
      if (String(url).includes(SEND_MESSAGE)) {
        sends.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
      }
      return inner(url, init);
    };
    return { h, sends };
  }

  test("sends the reply as Telegram HTML, not as literal Markdown", async () => {
    const { h, sends } = harnessCapturingSends("**bold** and `code`");
    await runPollCycle(h.deps);

    expect(sends[0]?.["parse_mode"]).toBe("HTML");
    expect(sends[0]?.["text"]).toBe("<b>bold</b> and <code>code</code>");
  });

  test("a rejected markup send still delivers the reply, unstyled", async () => {
    // The invariant the plain-text default was built on: a delivery failure is
    // worse than unstyled text. Simulate Telegram refusing the markup and
    // assert the principal still receives the answer.
    const sends: Record<string, unknown>[] = [];
    const h = harness(updateBody([{ updateId: 41, text: "go" }]), {
      actuator: { converse: async () => "**bold**" },
    });
    const inner = h.baseFetch;
    h.deps.fetchFn = async (url, init) => {
      if (String(url).includes(SEND_MESSAGE)) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        sends.push(body);
        if (body["parse_mode"] !== undefined) {
          return new Response(JSON.stringify({ ok: false, description: "can't parse entities" }), {
            status: 400,
          });
        }
        return new Response(JSON.stringify({ ok: true, result: { message_id: 2 } }));
      }
      return inner(url, init);
    };

    const outcome = await runPollCycle(h.deps);

    expect(outcome.handled).toBe(1);
    expect(sends).toHaveLength(2);
    expect(sends[1]?.["text"]).toBe("**bold**");
    expect("parse_mode" in (sends[1] ?? {})).toBe(false);
  });

  test("escapes agent output that contains angle brackets", async () => {
    const { h, sends } = harnessCapturingSends("returns Promise<string> when a<b");
    await runPollCycle(h.deps);

    expect(sends[0]?.["text"]).toBe("returns Promise&lt;string&gt; when a&lt;b");
  });

  test("leaves snake_case identifiers intact end-to-end", async () => {
    const { h, sends } = harnessCapturingSends("set parse_mode on send_message");
    await runPollCycle(h.deps);

    expect(sends[0]?.["text"]).toBe("set parse_mode on send_message");
  });

  test("falls back to unstyled when the rendered form exceeds Telegram's ceiling", async () => {
    // Tag overhead can push a reply inside the markdown budget past the 4096
    // wire limit; sending it formatted would be an outright rejection.
    const heavy = Array.from({ length: 400 }, (_, i) => `**b${i}**`).join(" ");
    const { h, sends } = harnessCapturingSends(heavy);
    await runPollCycle(h.deps);

    expect(sends).toHaveLength(1);
    expect("parse_mode" in (sends[0] ?? {})).toBe(false);
    expect(String(sends[0]?.["text"])).toContain("**b0**");
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
