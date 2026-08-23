/**
 * Tests for the inbound principal-channel poll cycle (mt#3228).
 *
 * Everything is injected — no network, no DB, no spawned `claude`. The cases
 * that matter most are the ones a live test could not reliably produce: the
 * audit-before-action ordering, cursor advancement past unparseable updates,
 * and the promise that a session driver failure still reaches the principal.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  runPollCycle,
  startPrincipalChannelPoller,
  truncateReply,
  type BindTopicOutcome,
  type ChannelDriver,
  type PollCursor,
  type PollCycleDeps,
  startTypingLoop,
  PRINCIPAL_CHANNEL_SWEEP_NAME,
  PRINCIPAL_CHANNEL_PROGRESS_BUDGET_MS,
} from "./principal-channel-poller";
import {
  getSweepLivenessSnapshot,
  startSweepMetaWatchdog,
  _resetSweepLivenessRegistryForTest,
  type SweepLivenessSnapshot,
} from "./sweepers";
import { DEFAULT_READY_TIMEOUT_MS, DEFAULT_TURN_TIMEOUT_MS } from "./principal-channel-driver";
import { DeadlineExceededError } from "@minsky/domain/utils/deadline";
import type { PrincipalMessageEventPayload } from "@minsky/domain/notify/principal-inbound";
import type { FetchFn } from "@minsky/domain/notify/telegram-transport";
import {
  REACTION_DONE,
  REACTION_ERROR,
  REACTION_RECEIVED,
} from "@minsky/domain/notify/principal-reactions";

const TOKEN = "tok";
const CHAT = "167346572";
const GET_UPDATES = "/getUpdates";
const SEND_MESSAGE = "/sendMessage";
/** Telegram's wire key for a topic thread — shared across many test bodies below. */
const THREAD_ID_KEY = "message_thread_id";

interface Recorded {
  type: string;
  payload: PrincipalMessageEventPayload;
}

/** Poll `condition` until it is true, or throw after `timeoutMs` (mt#4185). */
async function waitForCondition(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  // eslint-disable-next-line custom/no-real-fs-in-tests -- Date.now() is used for timing, not path creation; the rule's regex fires on the call pattern but there is no filesystem interaction here
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    // eslint-disable-next-line custom/no-real-fs-in-tests -- same: timing, not path creation
    if (Date.now() > deadline) throw new Error("waitForCondition timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

interface Harness {
  deps: PollCycleDeps;
  recorded: Recorded[];
  sentTexts: string[];
  driverCalls: string[];
  cursorWrites: number[];
  order: string[];
  /** The harness's own fetch, so a test can wrap it to inspect one request. */
  baseFetch: FetchFn;
}

function updateBody(
  messages: Array<{
    updateId: number;
    text: string;
    chatId?: string;
    messageId?: number;
    /** mt#3505 — omitted by default so every pre-existing call keeps producing today's payload. */
    messageThreadId?: number;
  }>,
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
          ...(m.messageThreadId === undefined
            ? {}
            : { message_thread_id: m.messageThreadId, is_topic_message: true }),
        },
      })),
      ...extraUpdates,
    ],
  };
}

function harness(
  body: unknown,
  overrides: {
    sessionDriver?: Partial<ChannelDriver>;
    cursorStart?: number;
    recordEventThrows?: boolean;
    /** Update ids the recorder reports as already-recorded replays. */
    duplicateUpdateIds?: number[];
    /** mt#3505 — resolves the session driver for a message carrying a thread id. */
    resolveTopicDriver?: PollCycleDeps["resolveTopicDriver"];
    /** mt#3507 — carries out a `/bind`. */
    bindTopic?: PollCycleDeps["bindTopic"];
    /** mt#3507 — records a topic mapping as dead after drift reconciliation. */
    markTopicDead?: PollCycleDeps["markTopicDead"];
  } = {}
): Harness {
  const recorded: Recorded[] = [];
  const sentTexts: string[] = [];
  const driverCalls: string[] = [];
  const cursorWrites: number[] = [];
  const order: string[] = [];

  const sessionDriver: ChannelDriver = {
    converse: async (text) => {
      driverCalls.push(`converse:${text}`);
      order.push("act");
      return `answered: ${text}`;
    },
    interrupt: async () => {
      driverCalls.push("interrupt");
      order.push("act");
      return "stopped";
    },
    reset: async () => {
      driverCalls.push("reset");
      order.push("act");
      return "fresh conversation";
    },
    answerAsk: async (ref, text) => {
      driverCalls.push(`answerAsk:${ref}:${text}`);
      order.push("act");
      return `ask ${ref} answered`;
    },
    ...overrides.sessionDriver,
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
    sessionDriver,
    cursor,
    recordEvent: async (type, payload) => {
      order.push("record");
      if (overrides.recordEventThrows) throw new Error("db down");
      recorded.push({ type, payload });
      return overrides.duplicateUpdateIds?.includes(payload.updateId) ? "duplicate" : "recorded";
    },
    fetchFn: baseFetch,
    ...(overrides.resolveTopicDriver ? { resolveTopicDriver: overrides.resolveTopicDriver } : {}),
    ...(overrides.bindTopic ? { bindTopic: overrides.bindTopic } : {}),
    ...(overrides.markTopicDead ? { markTopicDead: overrides.markTopicDead } : {}),
  };

  return { deps, recorded, sentTexts, driverCalls, cursorWrites, order, baseFetch };
}

describe("runPollCycle — happy path", () => {
  test("routes free text to the channel agent and replies with its output", async () => {
    const h = harness(updateBody([{ updateId: 5, text: "what is blocked?" }]));
    const outcome = await runPollCycle(h.deps);

    expect(outcome).toEqual({ received: 1, handled: 1, failed: 0, rejected: 0, duplicates: 0 });
    expect(h.driverCalls).toEqual(["converse:what is blocked?"]);
    expect(h.sentTexts).toEqual(["answered: what is blocked?"]);
  });

  test("routes /answer straight to the ask, with no agent turn", async () => {
    const h = harness(updateBody([{ updateId: 5, text: "/answer abc123 yes do it" }]));
    await runPollCycle(h.deps);
    expect(h.driverCalls).toEqual(["answerAsk:abc123:yes do it"]);
  });

  test("routes /stop to interrupt", async () => {
    const h = harness(updateBody([{ updateId: 5, text: "/stop" }]));
    await runPollCycle(h.deps);
    expect(h.driverCalls).toEqual(["interrupt"]);
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
    expect(h.driverCalls).toEqual(["converse:first", "converse:second"]);
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
  test("refuses another chat, records it, and never reaches the session driver", async () => {
    const h = harness(updateBody([{ updateId: 5, text: "rm -rf /", chatId: "999" }]));
    const outcome = await runPollCycle(h.deps);

    expect(outcome).toEqual({ received: 1, handled: 0, failed: 0, rejected: 1, duplicates: 0 });
    expect(h.driverCalls).toEqual([]);
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
  test("records the event BEFORE running the session driver", async () => {
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
    expect(h.driverCalls).toEqual([]);
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

    expect(h.driverCalls).toEqual(["converse:new"]);
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
    expect(h.driverCalls).toEqual(["converse:go"]);
  });
});

describe("runPollCycle — failure outcome (PR #2324 R1)", () => {
  const failing = { converse: async (): Promise<string> => Promise.reject(new Error("no binary")) };

  test("a failed session driver counts as failed, not handled", async () => {
    const h = harness(updateBody([{ updateId: 5, text: "go" }]), { sessionDriver: failing });
    const outcome = await runPollCycle(h.deps);

    expect(outcome.handled).toBe(0);
    expect(outcome.failed).toBe(1);
  });

  test("records a failure outcome event so the log says whether it worked", async () => {
    const h = harness(updateBody([{ updateId: 5, text: "go" }]), { sessionDriver: failing });
    await runPollCycle(h.deps);

    const failure = h.recorded.find((r) => r.type === "principal.message_failed");
    expect(failure).toBeDefined();
    expect(failure?.payload.failureDetail).toContain("no binary");
  });

  test("the failure row's token differs from the pre-action row's", async () => {
    // Otherwise the recorder's own dedupe would reject it as a replay of the
    // row written moments earlier for the same update.
    const h = harness(updateBody([{ updateId: 5, text: "go" }]), { sessionDriver: failing });
    await runPollCycle(h.deps);

    const tokens = h.recorded.map((r) => r.payload.token);
    expect(new Set(tokens).size).toBe(tokens.length);
    expect(tokens).toContain("telegram:update:5");
    expect(tokens).toContain("telegram:update:5:failed");
  });

  test("the principal is still told, despite the failure being recorded", async () => {
    const h = harness(updateBody([{ updateId: 5, text: "go" }]), { sessionDriver: failing });
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

  test("tells the principal when the session driver fails, rather than going silent", async () => {
    const h = harness(updateBody([{ updateId: 5, text: "go" }]), {
      sessionDriver: {
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
      sessionDriver: { converse: async () => "   " },
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
      sessionDriver: {
        converse: async (text, opts) => {
          seenImages = opts?.images;
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
      sessionDriver: {
        converse: async (_text, opts) => {
          seenImages = opts?.images;
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
      sessionDriver: {
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
    expect(h.driverCalls).toEqual([]);
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
      sessionDriver: { converse: async () => reply },
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
      sessionDriver: { converse: async () => "**bold**" },
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

/**
 * Per-topic routing and concurrency (mt#3505, parent mt#3500).
 *
 * `converse` is documented as NOT concurrency-safe (principal-channel-driver
 * docblock), and the poller has historically enforced that by handling every
 * message strictly sequentially, globally. Phase 1 generalizes to one
 * conversation PER topic while preserving that safety property: serialize
 * per-topic, run different topics concurrently.
 */
describe("runPollCycle — per-topic routing and concurrency (mt#3505)", () => {
  test("a message with no thread id still uses the standing session driver, unchanged", async () => {
    // AT: "Send a message with no topic at all: answered in the standing
    // conversation, exactly as before." resolveTopicDriver must never be
    // consulted for this case.
    const h = harness(updateBody([{ updateId: 50, text: "hi" }]), {
      resolveTopicDriver: async () => {
        throw new Error("must not be called for a message with no thread id");
      },
    });
    const outcome = await runPollCycle(h.deps);
    expect(outcome.handled).toBe(1);
    expect(h.driverCalls).toEqual(["converse:hi"]);
  });

  test("a message carrying a thread id is routed through resolveTopicDriver", async () => {
    const seenThreadIds: number[] = [];
    const h = harness(
      updateBody([{ updateId: 51, text: "topic message", messageThreadId: 749667 }]),
      {
        resolveTopicDriver: async (threadId) => {
          seenThreadIds.push(threadId);
          return {
            converse: async (text) => `topic-answer:${text}`,
            interrupt: async () => "stopped",
            reset: async () => "fresh",
            answerAsk: async () => "answered",
          };
        },
      }
    );
    const outcome = await runPollCycle(h.deps);

    expect(outcome.handled).toBe(1);
    expect(seenThreadIds).toEqual([749667]);
    expect(h.sentTexts).toEqual(["topic-answer:topic message"]);
  });

  test("the reply to a topic message carries message_thread_id on the wire", async () => {
    let sentBody: Record<string, unknown> = {};
    const h = harness(updateBody([{ updateId: 52, text: "go", messageThreadId: 749667 }]), {
      resolveTopicDriver: async () => ({
        converse: async () => "ok",
        interrupt: async () => "stopped",
        reset: async () => "fresh",
        answerAsk: async () => "answered",
      }),
    });
    const inner = h.baseFetch;
    h.deps.fetchFn = async (url, init) => {
      if (String(url).includes(SEND_MESSAGE)) {
        sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      }
      return inner(url, init);
    };

    await runPollCycle(h.deps);
    expect(sentBody[THREAD_ID_KEY]).toBe(749667);
  });

  test("two messages in the SAME topic remain strictly ordered", async () => {
    const order: string[] = [];
    const h = harness(
      updateBody([
        { updateId: 60, text: "first", messageThreadId: 100 },
        { updateId: 61, text: "second", messageThreadId: 100 },
      ]),
      {
        resolveTopicDriver: async () => ({
          converse: async (text) => {
            order.push(`start:${text}`);
            await Promise.resolve();
            order.push(`end:${text}`);
            return `ok:${text}`;
          },
          interrupt: async () => "stopped",
          reset: async () => "fresh",
          answerAsk: async () => "answered",
        }),
      }
    );

    await runPollCycle(h.deps);

    expect(order).toEqual(["start:first", "end:first", "start:second", "end:second"]);
  });

  test("two messages in DIFFERENT topics are handled concurrently — a slow topic does not block a fast one", async () => {
    const order: string[] = [];
    let releaseSlow: () => void = () => {};
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });

    const driverFor = (threadId: number): ChannelDriver => ({
      converse: async (text) => {
        order.push(`${threadId}-start`);
        if (threadId === 100) await slowGate;
        order.push(`${threadId}-end`);
        return `${threadId}:${text}`;
      },
      interrupt: async () => "stopped",
      reset: async () => "fresh",
      answerAsk: async () => "answered",
    });

    const h = harness(
      updateBody([
        { updateId: 70, text: "slow one", messageThreadId: 100 },
        { updateId: 71, text: "fast one", messageThreadId: 200 },
      ]),
      { resolveTopicDriver: async (threadId) => driverFor(threadId) }
    );

    const cyclePromise = runPollCycle(h.deps);
    // Give the fast (unblocked) topic a chance to run to completion while the
    // slow topic is still gated — proves the two ran CONCURRENTLY, not that
    // the loop merely doesn't throw when run sequentially.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual(["100-start", "200-start", "200-end"]);

    releaseSlow();
    const outcome = await cyclePromise;

    expect(order).toEqual(["100-start", "200-start", "200-end", "100-end"]);
    expect(outcome.handled).toBe(2);
  });

  test("/stop inside a topic interrupts THAT topic's session driver, not the standing one", async () => {
    const standingInterrupted: string[] = [];
    const topicInterrupted: string[] = [];
    const h = harness(updateBody([{ updateId: 80, text: "/stop", messageThreadId: 100 }]), {
      sessionDriver: {
        interrupt: async () => {
          standingInterrupted.push("standing");
          return "stopped";
        },
      },
      resolveTopicDriver: async () => ({
        converse: async (text) => text,
        interrupt: async () => {
          topicInterrupted.push("topic");
          return "stopped";
        },
        reset: async () => "fresh",
        answerAsk: async () => "answered",
      }),
    });

    await runPollCycle(h.deps);

    expect(topicInterrupted).toEqual(["topic"]);
    expect(standingInterrupted).toEqual([]);
  });
});

/**
 * Ask replies land in the topic they arrived in (mt#3507 success criterion).
 *
 * Already true structurally as of mt#3505 — `sendReply` threads
 * `message.messageThreadId` for EVERY route, `/answer` included. This locks
 * the behavior in explicitly rather than leaving it as an inference from the
 * generic per-topic tests above.
 */
describe("runPollCycle — /answer replies land in the topic it was asked in (mt#3507)", () => {
  test("/answer inside a topic is answered in that same topic", async () => {
    let sentThreadId: unknown;
    const h = harness(
      updateBody([
        { updateId: 97, text: "/answer abc123 go with option B", messageThreadId: 749667 },
      ]),
      {
        resolveTopicDriver: async () => ({
          converse: async (text) => text,
          interrupt: async () => "stopped",
          reset: async () => "fresh",
          answerAsk: async (ref, text) => `ask ${ref} answered: ${text}`,
        }),
      }
    );
    const inner = h.baseFetch;
    h.deps.fetchFn = async (url, init) => {
      if (String(url).includes(SEND_MESSAGE)) {
        sentThreadId = (JSON.parse(String(init?.body)) as Record<string, unknown>)[THREAD_ID_KEY];
      }
      return inner(url, init);
    };

    await runPollCycle(h.deps);
    expect(sentThreadId).toBe(749667);
  });
});

/**
 * `/bind` handling (mt#3507).
 *
 * No session driver is ever consulted here — binding writes a mapping row, it does
 * not run a conversational turn, so every case below asserts `bindTopic`
 * (or its absence) drives the reply, not `converse`.
 */
describe("runPollCycle — /bind (mt#3507)", () => {
  test("in the standing conversation (no thread id), refuses without calling bindTopic", async () => {
    let called = false;
    const h = harness(updateBody([{ updateId: 90, text: "/bind mt#3507" }]), {
      bindTopic: async () => {
        called = true;
        return { kind: "bound", taskId: "mt#3507" };
      },
    });
    const outcome = await runPollCycle(h.deps);

    expect(outcome.handled).toBe(1);
    expect(called).toBe(false);
    expect(h.sentTexts[0]).toContain("standing conversation");
    expect(h.driverCalls).toEqual([]);
  });

  test("with no bindTopic dep wired at all, answers that binding isn't available", async () => {
    const h = harness(
      updateBody([{ updateId: 91, text: "/bind mt#3507", messageThreadId: 100 }])
      // no bindTopic override — mirrors a poller launched without topic support
    );
    await runPollCycle(h.deps);
    expect(h.sentTexts[0]).toContain("isn't available");
  });

  test("inside a topic, calls bindTopic with the thread id and task ref", async () => {
    const seen: Array<[number, string]> = [];
    const h = harness(
      updateBody([{ updateId: 92, text: "/bind mt#3507", messageThreadId: 749667 }]),
      {
        bindTopic: async (threadId, taskRef) => {
          seen.push([threadId, taskRef]);
          return { kind: "bound", taskId: "mt#3507" };
        },
      }
    );
    const outcome = await runPollCycle(h.deps);

    expect(seen).toEqual([[749667, "mt#3507"]]);
    expect(outcome.handled).toBe(1);
    expect(h.sentTexts[0]).toContain("mt#3507");
    expect(h.sentTexts[0]).toContain("Bound");
  });

  test("a malformed or nonexistent task id is refused, with the reason from bindTopic", async () => {
    const h = harness(
      updateBody([{ updateId: 93, text: "/bind not-a-task", messageThreadId: 749667 }]),
      {
        bindTopic: async (): Promise<BindTopicOutcome> => ({
          kind: "invalid-task",
          detail: '"not-a-task" isn\'t a task id I recognize (expected e.g. mt#123).',
        }),
      }
    );
    await runPollCycle(h.deps);
    expect(h.sentTexts[0]).toContain("Could not bind");
    expect(h.sentTexts[0]).toContain("isn't a task id I recognize");
  });

  test("never dispatches to the conversation session driver", async () => {
    // Regression against the failure mode "bind quietly became a chat turn":
    // no route to converse/answerAsk/etc for a bind route, ever.
    const h = harness(
      updateBody([{ updateId: 94, text: "/bind mt#3507", messageThreadId: 749667 }]),
      {
        bindTopic: async () => ({ kind: "bound", taskId: "mt#3507" }),
        resolveTopicDriver: async () => {
          throw new Error("must not be called for a bind route");
        },
      }
    );
    const outcome = await runPollCycle(h.deps);
    expect(outcome.handled).toBe(1);
  });

  test("a /bind reply is recorded in the audit log with route 'bind'", async () => {
    const h = harness(
      updateBody([{ updateId: 95, text: "/bind mt#3507", messageThreadId: 749667 }]),
      { bindTopic: async () => ({ kind: "bound", taskId: "mt#3507" }) }
    );
    await runPollCycle(h.deps);
    expect(h.recorded[0]?.payload.route).toBe("bind");
  });
});

/**
 * Reply-time drift reconciliation (mt#3507) — a reply INTO a topic whose
 * thread Telegram no longer recognizes must not be lost.
 */
describe("runPollCycle — reply drift reconciliation (mt#3507)", () => {
  function harnessWithThreadNotFound(messageThreadId: number): {
    h: Harness;
    sentBodies: Record<string, unknown>[];
  } {
    const sentBodies: Record<string, unknown>[] = [];
    const h = harness(updateBody([{ updateId: 96, text: "go", messageThreadId }]), {
      resolveTopicDriver: async () => ({
        converse: async () => "the answer",
        interrupt: async () => "stopped",
        reset: async () => "fresh",
        answerAsk: async () => "answered",
      }),
    });
    const inner = h.baseFetch;
    h.deps.fetchFn = async (url, init) => {
      if (String(url).includes(SEND_MESSAGE)) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        sentBodies.push(body);
        if (body[THREAD_ID_KEY] !== undefined) {
          return new Response(
            JSON.stringify({ ok: false, description: "Bad Request: message thread not found" }),
            { status: 400 }
          );
        }
        return new Response(JSON.stringify({ ok: true, result: { message_id: 2 } }));
      }
      return inner(url, init);
    };
    return { h, sentBodies };
  }

  test("a reply into a dead topic falls back to the standing conversation with a note", async () => {
    const { h, sentBodies } = harnessWithThreadNotFound(749667);
    const outcome = await runPollCycle(h.deps);

    expect(outcome.handled).toBe(1);
    // The reply is short enough to attempt formatted (HTML) first, so
    // sendTelegramMessage's OWN pre-existing markup-retry fires once against
    // the (still dead) thread before this wrapper's outer fallback finally
    // drops the thread id — every attempt up to the last carries the topic's
    // thread id; only the FINAL, successful one does not.
    const last = sentBodies[sentBodies.length - 1];
    expect(sentBodies.length).toBeGreaterThanOrEqual(2);
    expect(sentBodies[0]?.[THREAD_ID_KEY]).toBe(749667);
    expect(THREAD_ID_KEY in (last ?? {})).toBe(false);
    expect(String(last?.["text"])).toContain("could not be found");
  });

  test("calls markTopicDead with the chat and the dead thread id", async () => {
    const deadCalls: Array<[string, number]> = [];
    const { h } = harnessWithThreadNotFound(749667);
    h.deps.markTopicDead = async (chatId, messageThreadId) => {
      deadCalls.push([chatId, messageThreadId]);
    };

    await runPollCycle(h.deps);
    expect(deadCalls).toEqual([[CHAT, 749667]]);
  });

  test("with no markTopicDead dep wired, the reply still falls back (just isn't recorded)", async () => {
    const { h, sentBodies } = harnessWithThreadNotFound(749667);
    // No markTopicDead override — mirrors a poller launched without it wired.
    const outcome = await runPollCycle(h.deps);
    expect(outcome.handled).toBe(1);
    const last = sentBodies[sentBodies.length - 1];
    expect(THREAD_ID_KEY in (last ?? {})).toBe(false);
  });
});

/**
 * Pipeline-state acks (mt#3486).
 *
 * The principal asked for "some kind of acknowledgement that it's received."
 * Telegram's checkmarks cannot supply it — a bot can neither read nor set them
 * — so reactions on the inbound message are the only mechanism that marks a
 * SPECIFIC message as having reached a stage.
 */
/** Bot API method fragments matched against the stubbed fetch URL. */
const SET_REACTION = "setMessageReaction";
const CHAT_ACTION = "sendChatAction";
/** The forum-topic field, as it appears on the wire. */
const THREAD_FIELD = "message_thread_id";

describe("runPollCycle — receipt acks", () => {
  /** Capture reaction + chat-action calls alongside the normal harness. */
  function ackHarness(opts: { fail?: boolean; threadId?: number } = {}): {
    h: Harness;
    reactions: Array<{ messageId: number; emoji: string }>;
    typing: Array<Record<string, unknown>>;
  } {
    const reactions: Array<{ messageId: number; emoji: string }> = [];
    const typing: Array<Record<string, unknown>> = [];

    const body = {
      ok: true,
      result: [
        {
          update_id: 60,
          message: {
            message_id: 60,
            date: 1700000000,
            chat: { id: CHAT, type: "private" },
            from: { id: 777 },
            text: "go",
            ...(opts.threadId === undefined
              ? {}
              : { message_thread_id: opts.threadId, is_topic_message: true }),
          },
        },
      ],
    };

    const h = harness(body, {
      sessionDriver: {
        converse: async () => {
          if (opts.fail) throw new Error("boom");
          return "done";
        },
      },
    });

    const inner = h.baseFetch;
    h.deps.fetchFn = async (url, init) => {
      const target = String(url);
      const parsed = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      if (target.includes(SET_REACTION)) {
        const list = parsed["reaction"] as Array<{ emoji: string }> | undefined;
        reactions.push({
          messageId: Number(parsed["message_id"]),
          emoji: list && list.length > 0 ? (list[0]?.emoji ?? "") : "",
        });
        return new Response(JSON.stringify({ ok: true, result: true }));
      }
      if (target.includes(CHAT_ACTION)) {
        typing.push(parsed);
        return new Response(JSON.stringify({ ok: true, result: true }));
      }
      return inner(url, init);
    };

    return { h, reactions, typing };
  }

  test("marks the message as picked up, then as done", async () => {
    const { h, reactions } = ackHarness();
    await runPollCycle(h.deps);

    // Both target the PRINCIPAL's message, not the reply — the point is to
    // mark which inbound message reached which stage.
    expect(reactions.map((r) => r.emoji)).toEqual([REACTION_RECEIVED, REACTION_DONE]);
    expect(reactions.every((r) => r.messageId === 60)).toBe(true);
  });

  test("marks a failed turn with the error reaction, not the done one", async () => {
    const { h, reactions } = ackHarness({ fail: true });
    await runPollCycle(h.deps);

    expect(reactions.map((r) => r.emoji)).toEqual([REACTION_RECEIVED, REACTION_ERROR]);
  });

  test("marks a turn whose reply never got delivered with the error reaction", async () => {
    // The session driver succeeds, but Telegram rejects the reply. The principal is
    // left with no answer, so 👌 would assert delivery of something they never
    // received — and here the reaction is the ONLY signal they get, because the
    // reply itself is what went missing.
    const { h, reactions } = ackHarness();
    const withAcks = h.deps.fetchFn ?? h.baseFetch;
    h.deps.fetchFn = async (url, init) => {
      if (String(url).includes(SEND_MESSAGE)) {
        return new Response(JSON.stringify({ ok: false, description: "Bad Request" }), {
          status: 400,
        });
      }
      return withAcks(url, init);
    };

    await runPollCycle(h.deps);

    expect(reactions.map((r) => r.emoji)).toEqual([REACTION_RECEIVED, REACTION_ERROR]);
  });

  test("a reaction failure never affects the reply", async () => {
    // Fire-and-forget by contract: the ack reports on the pipeline, so it must
    // never be able to break the thing it reports on.
    const { h } = ackHarness();
    const withAcks = h.deps.fetchFn ?? h.baseFetch;
    h.deps.fetchFn = async (url, init) => {
      if (String(url).includes(SET_REACTION)) {
        return new Response(JSON.stringify({ ok: false, description: "REACTION_INVALID" }), {
          status: 400,
        });
      }
      return withAcks(url, init);
    };

    const outcome = await runPollCycle(h.deps);

    expect(outcome.handled).toBe(1);
    expect(h.sentTexts).toEqual(["done"]);
  });

  test("shows the typing indicator, and targets the message's topic", async () => {
    // Without the thread id the cue appears in General while the reply lands in
    // the topic — a latency signal pointing at the wrong conversation.
    const { h, typing } = ackHarness({ threadId: 42 });
    await runPollCycle(h.deps);

    expect(typing.length).toBeGreaterThan(0);
    expect(typing[0]?.["action"]).toBe("typing");
    expect(typing[0]?.[THREAD_FIELD]).toBe(42);
  });

  test("omits the thread id outside a topic", async () => {
    const { h, typing } = ackHarness();
    await runPollCycle(h.deps);

    expect(typing.length).toBeGreaterThan(0);
    expect(THREAD_FIELD in (typing[0] ?? {})).toBe(false);
  });
});

/**
 * The typing loop's lifetime (PR #2525 R2).
 *
 * Exercised DIRECTLY with a short refresh rather than through `runPollCycle`.
 * At the 4-second production cadence a poll-cycle test finishes before a single
 * refresh fires, so an assertion about stopping would pass whether or not
 * stopping worked — the can't-fail shape mem#704 warns about. Driving the loop
 * itself is what makes these discriminating.
 */
/**
 * Streaming wiring at the poll-cycle level (mt#3542).
 *
 * The stream's own mechanics are covered in
 * `principal-channel-reply-stream.test.ts`; these pin that the poller actually
 * HANDS it to the session driver and settles it — the production-wiring direction,
 * which a stream unit test cannot see.
 */
describe("runPollCycle — streamed replies (mt#3542)", () => {
  const EDIT = "editMessageText";
  /** A resolved answer that is NOT a continuation of anything streamed (mt#3711). */
  const DIVERGENT_FINAL = "an unrelated final answer";

  function streamHarness(
    opts: { threadId?: number; sealAfterPartial?: boolean; finalText?: string } = {}
  ): {
    h: Harness;
    edits: Array<Record<string, unknown>>;
    sends: Array<Record<string, unknown>>;
    sawOnPartial: () => boolean;
  } {
    const edits: Array<Record<string, unknown>> = [];
    const sends: Array<Record<string, unknown>> = [];
    let onPartialSeen = false;

    const body = {
      ok: true,
      result: [
        {
          update_id: 70,
          message: {
            message_id: 70,
            date: 1700000000,
            chat: { id: CHAT, type: "private" },
            from: { id: 777 },
            text: "explain it",
            ...(opts.threadId === undefined
              ? {}
              : { message_thread_id: opts.threadId, is_topic_message: true }),
          },
        },
      ],
    };

    const h = harness(body, {
      sessionDriver: {
        converse: async (_text, converseOpts) => {
          // Drive the seam the way a real turn does: emit progress, then
          // resolve with the authoritative answer.
          if (converseOpts?.onPartial) {
            onPartialSeen = true;
            converseOpts.onPartial("partial ");
            converseOpts.onPartial("partial answer");
            if (opts.sealAfterPartial === true) {
              converseOpts.onBlockEnd?.();
              converseOpts.onPartial("partial answerand a second block");
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 5));
          // Defaults to a text that EXTENDS what streamed, which is the
          // ordinary case: the deltas and the resolved result agree, and the
          // settle is an edit. A caller that wants the DIVERGING case — the
          // tool-heavy turn where `result` is not a continuation — passes it.
          return opts.finalText ?? "partial answer, settled";
        },
      },
    });

    const inner = h.baseFetch;
    h.deps.fetchFn = async (url, init) => {
      const target = String(url);
      const parsed = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      if (target.includes(EDIT)) {
        edits.push(parsed);
        return new Response(JSON.stringify({ ok: true, result: true }));
      }
      if (target.includes(SEND_MESSAGE)) sends.push(parsed);
      return inner(url, init);
    };

    return { h, edits, sends, sawOnPartial: () => onPartialSeen };
  }

  test("settles additively — a resolved text that continues the stream is an EDIT", async () => {
    const { h, edits, sawOnPartial } = streamHarness();

    const outcome = await runPollCycle(h.deps);

    expect(outcome.handled).toBe(1);
    expect(sawOnPartial()).toBe(true);
    // The placeholder carries the streamed progress...
    expect(h.sentTexts[0]).toContain("partial");
    // ...and the resolved answer, which continues it, is edited in rather than
    // sent as a second message.
    expect(String(edits.at(-1)?.["text"])).toContain("settled");
  });

  /**
   * mt#3711 R2. The resolved text on a tool-heavy turn is NOT a continuation
   * of what streamed — `result` carries the final answer while the deltas
   * carried interstitial prose. Overwriting the open message with it is what
   * made the reply visibly shrink at the end of a turn, so it now arrives as
   * its own message and the streamed prose is left standing.
   */
  test("a resolved text that continues nothing on screen is a NEW message, not an overwrite", async () => {
    const { h, edits, sends } = streamHarness({ finalText: DIVERGENT_FINAL });

    await runPollCycle(h.deps);

    expect(sends.some((p) => String(p["text"]).includes(DIVERGENT_FINAL))).toBe(true);
    // Nothing was rewritten to it — the streamed text is still what it was.
    for (const edit of edits) {
      expect(String(edit["text"])).not.toBe(DIVERGENT_FINAL);
    }
    expect(h.sentTexts[0]).toContain("partial");
  });

  test("a tool call splits the turn into a second message, and only the first notifies", async () => {
    const { h, sends } = streamHarness({ sealAfterPartial: true });

    await runPollCycle(h.deps);

    const first = sends.find((p) => String(p["text"]).includes("partial answer"));
    const second = sends.find((p) => String(p["text"]).includes("and a second block"));
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    // SC2, at the poller seam: the phone buzzes once per turn however many
    // blocks the turn has. Telegram omits the field entirely when it is not
    // asked for, so the first message carries no `disable_notification` key.
    expect("disable_notification" in (first ?? {})).toBe(false);
    expect(second?.["disable_notification"]).toBe(true);
  });

  test("AT5 — the placeholder lands in the topic the message came from", async () => {
    const { h, edits, sends } = streamHarness({ threadId: 42 });

    await runPollCycle(h.deps);

    // Without the thread id the progress would appear in General while the
    // conversation it belongs to sits in the topic.
    const placeholder = sends.find((p) => String(p["text"]).includes("partial"));
    expect(placeholder).toBeDefined();
    expect(placeholder?.[THREAD_FIELD]).toBe(42);

    // `editMessageText` has no thread parameter — the message is already in the
    // topic it was sent to, so the edit addresses chat + message id only.
    expect(edits.length).toBeGreaterThan(0);
    expect(THREAD_FIELD in (edits[0] ?? {})).toBe(false);
    expect(edits[0]?.["chat_id"]).toBe(CHAT);
  });

  test("a turn that streams nothing still delivers, with no placeholder", async () => {
    // The non-streaming path must be untouched: SC6 says streaming is an
    // enhancement, never a new way to lose a reply.
    const h = harness(
      {
        ok: true,
        result: [
          {
            update_id: 71,
            message: {
              message_id: 71,
              date: 1700000000,
              chat: { id: CHAT, type: "private" },
              from: { id: 777 },
              text: "quick one",
            },
          },
        ],
      },
      { sessionDriver: { converse: async () => "answered without streaming" } }
    );

    const outcome = await runPollCycle(h.deps);

    expect(outcome.handled).toBe(1);
    expect(h.sentTexts).toEqual(["answered without streaming"]);
  });
});

describe("startTypingLoop", () => {
  function collector(): { calls: number[]; fetchFn: FetchFn } {
    const calls: number[] = [];
    const fetchFn: FetchFn = async () => {
      calls.push(Date.now());
      return new Response(JSON.stringify({ ok: true, result: true }));
    };
    return { calls, fetchFn };
  }

  const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  test("keeps refreshing for as long as it runs", async () => {
    // The property the whole change exists for: one call is not enough,
    // because Telegram expires the action after ~5s.
    const { calls, fetchFn } = collector();
    const loop = startTypingLoop({ token: "t", chatId: "c", refreshMs: 5, fetchFn });

    await settle(40);
    loop.stop();

    expect(calls.length).toBeGreaterThan(2);
  });

  test("stop() ends the refreshes", async () => {
    const { calls, fetchFn } = collector();
    const loop = startTypingLoop({ token: "t", chatId: "c", refreshMs: 5, fetchFn });

    await settle(25);
    loop.stop();
    const atStop = calls.length;
    await settle(30);

    expect(calls.length).toBe(atStop);
  });

  test("aborting the poller's signal stops it, without stop() being called", async () => {
    // Per-turn teardown is not sufficient: the poller aborts on shutdown while
    // an in-flight turn keeps awaiting its session driver, so without this binding
    // the interval outlives the poller it belongs to.
    const controller = new AbortController();
    const { calls, fetchFn } = collector();
    startTypingLoop({
      token: "t",
      chatId: "c",
      refreshMs: 5,
      signal: controller.signal,
      fetchFn,
    });

    await settle(25);
    controller.abort();
    const atAbort = calls.length;
    await settle(30);

    expect(atAbort).toBeGreaterThan(1);
    expect(calls.length).toBe(atAbort);
  });

  test("an already-aborted signal never starts the interval", async () => {
    // A turn can begin on the same tick a stop lands; subscribing to a future
    // event would miss it.
    const controller = new AbortController();
    controller.abort();
    const { calls, fetchFn } = collector();
    startTypingLoop({
      token: "t",
      chatId: "c",
      refreshMs: 5,
      signal: controller.signal,
      fetchFn,
    });

    await settle(30);

    expect(calls.length).toBe(0);
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

describe("poller sweep-liveness registration (mt#4185)", () => {
  afterEach(() => {
    _resetSweepLivenessRegistryForTest();
  });

  /** The poller's entry in the public `/api/sweeps` payload, or undefined. */
  function pollerEntry(): SweepLivenessSnapshot | undefined {
    return getSweepLivenessSnapshot().find((e) => e.name === PRINCIPAL_CHANNEL_SWEEP_NAME);
  }

  /**
   * A `fetchFn` for the long poll that parks forever, optionally honouring the
   * abort signal. This is the seam ADR-036 rule 2 requires be used instead of
   * patching the `runPollCycle` module export — `PollCycleDeps.fetchFn` already
   * exists, so a stub belongs here.
   */
  function parkingFetch(opts: { honourAbort: boolean }): FetchFn {
    return (url, init) => {
      const target = String(url);
      if (!target.includes(GET_UPDATES)) {
        return Promise.resolve(new Response(JSON.stringify({ ok: true, result: true })));
      }
      return new Promise<Response>((_resolve, reject) => {
        if (!opts.honourAbort) return;
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    };
  }

  test("AT2: a poller parked on the long poll appears in /api/sweeps with a stale lastAttemptAt", async () => {
    const h = harness(updateBody([]));
    const poller = startPrincipalChannelPoller(
      { ...h.deps, fetchFn: parkingFetch({ honourAbort: false }) },
      { errorBackoffMs: 5, progressBudgetMs: 50 }
    );
    try {
      // The cycle stamps progress once (after the cursor read) and then parks
      // on the long poll — exactly the 2026-08-16 shape.
      await waitForCondition(() => pollerEntry()?.lastAttemptAt != null);

      const entry = pollerEntry();
      expect(entry).toBeDefined();
      expect(entry?.selfScheduled).toBe(true);
      expect(entry?.intervalMs).toBe(50);

      const parkedAt = entry?.lastAttemptAt;
      await new Promise((r) => setTimeout(r, 60));
      // Stale: the loop is alive as a process and has stopped advancing, which
      // is the distinction the whole registry exists to make.
      expect(pollerEntry()?.lastAttemptAt).toBe(parkedAt as string);
    } finally {
      poller.stop();
    }
  });

  test("the meta-watchdog clears a park in an await that observes the abort signal", async () => {
    const h = harness(updateBody([]));
    const poller = startPrincipalChannelPoller(
      { ...h.deps, fetchFn: parkingFetch({ honourAbort: true }) },
      { errorBackoffMs: 5, progressBudgetMs: 20 }
    );
    const stopWatchdog = startSweepMetaWatchdog(15);
    try {
      await waitForCondition(() => pollerEntry()?.lastAttemptAt != null);
      const parkedAt = pollerEntry()?.lastAttemptAt;

      // The watchdog aborts the parked cycle; the loop starts a fresh one, and
      // its cursor read stamps progress again.
      await waitForCondition(() => pollerEntry()?.lastAttemptAt !== parkedAt, 3000);
      expect(pollerEntry()?.metaRestarts).toBeGreaterThanOrEqual(1);
    } finally {
      stopWatchdog();
      poller.stop();
    }
  });

  test("stop() deregisters, so a restarted daemon does not collide with its own previous poller", async () => {
    const h = harness(updateBody([]));
    const poller = startPrincipalChannelPoller(
      { ...h.deps, fetchFn: parkingFetch({ honourAbort: false }) },
      { errorBackoffMs: 5 }
    );
    await waitForCondition(() => pollerEntry() !== undefined);
    poller.stop();
    expect(pollerEntry()).toBeUndefined();

    // The name is free again — registering a second poller must not throw.
    const second = startPrincipalChannelPoller(
      { ...h.deps, fetchFn: parkingFetch({ honourAbort: false }) },
      { errorBackoffMs: 5 }
    );
    try {
      await waitForCondition(() => pollerEntry() !== undefined);
      expect(pollerEntry()).toBeDefined();
    } finally {
      second.stop();
    }
  });

  test("AT3: a long poll that never resolves ends the cycle at the bound instead of parking", async () => {
    const h = harness(updateBody([]));
    const started = Date.now();
    // `longPollSec: 0.05` → a 100ms client deadline (2x the server value).
    // Before mt#4183 there was no client deadline at all and this awaited forever.
    await expect(
      runPollCycle({
        ...h.deps,
        longPollSec: 0.05,
        fetchFn: () => new Promise<Response>(() => {}),
      })
    ).rejects.toThrow(DeadlineExceededError);
    // Bounded, not merely eventually — the whole point is a wall-clock guarantee.
    // eslint-disable-next-line custom/no-real-fs-in-tests -- Date.now() measures elapsed time, not path creation; no filesystem interaction here
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("AT4: an audit write that never resolves ends the cycle at the bound too", async () => {
    const h = harness(updateBody([{ updateId: 9, text: "hello" }]));
    const started = Date.now();
    await expect(
      runPollCycle({
        ...h.deps,
        dbStepDeadlineMs: 100,
        recordEvent: () => new Promise<"recorded">(() => {}),
      })
    ).rejects.toThrow(DeadlineExceededError);
    // eslint-disable-next-line custom/no-real-fs-in-tests -- same: elapsed-time measurement, not path creation
    expect(Date.now() - started).toBeLessThan(2_000);
    // The cursor never advanced, so the batch is re-fetched next cycle rather
    // than skipped — the property that makes aborting mid-batch safe.
    expect(h.cursorWrites).toEqual([]);
  });

  test("a cursor read that never resolves ends the cycle at the bound", async () => {
    const h = harness(updateBody([]));
    await expect(
      runPollCycle({
        ...h.deps,
        dbStepDeadlineMs: 100,
        cursor: { read: () => new Promise<number>(() => {}), write: async () => {} },
      })
    ).rejects.toThrow(DeadlineExceededError);
  });

  test("the loop SURVIVES a wedged long poll — it backs off and cycles again", async () => {
    const h = harness(updateBody([]));
    const poller = startPrincipalChannelPoller(
      {
        ...h.deps,
        longPollSec: 0.05,
        fetchFn: () => new Promise<Response>(() => {}),
      },
      { errorBackoffMs: 5, progressBudgetMs: 60_000 }
    );
    try {
      // Progress must keep advancing: each cycle deadlines, the catch converts
      // it to an error outcome, the loop backs off and starts another. Before
      // mt#4183 the first cycle parked and nothing ever advanced again.
      await waitForCondition(() => pollerEntry()?.lastAttemptAt != null);
      const first = pollerEntry()?.lastAttemptAt;
      await waitForCondition(() => pollerEntry()?.lastAttemptAt !== first, 4000);
      expect(pollerEntry()?.consecutiveFailures).toBeGreaterThanOrEqual(1);
    } finally {
      poller.stop();
    }
  });

  test("the default progress budget is derived from the session driver's enforced ceilings", () => {
    // Guards the derivation, not the number: if either session driver timeout moves,
    // this budget must move with it or a legitimately slow turn gets restarted.
    expect(PRINCIPAL_CHANNEL_PROGRESS_BUDGET_MS).toBe(
      DEFAULT_READY_TIMEOUT_MS + DEFAULT_TURN_TIMEOUT_MS
    );
    expect(PRINCIPAL_CHANNEL_PROGRESS_BUDGET_MS).toBeGreaterThan(DEFAULT_TURN_TIMEOUT_MS);
  });
});
