import { describe, expect, test } from "bun:test";

import { decideDisplay, type MessageDisplayInput } from "./linkify-message-display";
import { parseFireLog, summarizeFireLog } from "./linkify-liveness";
import { emptyCounts, type ShortIdMap } from "./entity-linkify";

const MAP: ShortIdMap = {
  memory: { "623": "1aa78e4a-5148-461c-b3a0-e7bba039d704" },
  ask: { "8640": "a2ecf405-6ede-4370-9a58-be8f68e55478" },
};

const AT = "2026-08-16T12:00:00.000Z";
const now = () => AT;

function delta(text: string, over: Partial<MessageDisplayInput> = {}): MessageDisplayInput {
  return {
    hook_event_name: "MessageDisplay",
    message_id: "msg-1",
    delta: text,
    ...over,
  } as MessageDisplayInput;
}

/**
 * Drive a whole message through `decideDisplay` the way the hook does — carrying
 * state forward delta by delta — and return the flush record the last one
 * produced. This mirrors `main`'s loop rather than asserting on one call,
 * because the tally's whole job is to survive ACROSS deltas.
 */
function runMessage(
  deltas: { text: string; final?: boolean }[],
  shortIdMap?: ShortIdMap,
  messageId?: string
): ReturnType<typeof decideDisplay> {
  let stored: Parameters<typeof decideDisplay>[1] = null;
  let last!: ReturnType<typeof decideDisplay>;
  for (const d of deltas) {
    const over: Partial<MessageDisplayInput> = { final: d.final === true };
    if (messageId !== undefined) over.message_id = messageId;
    last = decideDisplay(delta(d.text, over), stored, shortIdMap, now);
    stored = last.nextState;
  }
  return last;
}

describe("AT1 — a message carrying a task ref records a task rewrite", () => {
  test("single final delta with mt#1545 flushes a record counting one task link", () => {
    const { flush, display } = runMessage([{ text: "see mt#1545 for detail\n", final: true }]);

    expect(display).toContain("[mt#1545](minsky://task/mt%231545)");
    expect(flush).not.toBeNull();
    expect(flush?.totals.task).toBe(1);
    expect(flush?.deltas).toBe(1);
    expect(flush?.at).toBe(AT);
  });

  test("the tally accumulates across deltas, not just the last one", () => {
    const { flush } = runMessage([
      { text: "first mt#1\n" },
      { text: "second mt#2 and PR #7\n" },
      { text: "third mt#3\n", final: true },
    ]);

    expect(flush?.totals.task).toBe(3);
    expect(flush?.totals.changeset).toBe(1);
    expect(flush?.deltas).toBe(3);
  });

  test("short ids resolved through the map are counted under their own class", () => {
    const { flush } = runMessage([{ text: "mem#623 and ask#8640\n", final: true }], MAP);

    expect(flush?.totals.memory).toBe(1);
    expect(flush?.totals.ask).toBe(1);
    expect(flush?.totals.shortIdUnresolved).toBe(0);
  });

  test("a ref inside a code fence is neither linked nor counted", () => {
    const { flush } = runMessage([{ text: "```\nmt#1545\n```\n", final: true }]);

    expect(flush?.totals.task).toBe(0);
  });
});

describe("AT3 — 'ran, nothing to rewrite' is distinguishable from 'never ran'", () => {
  test("a ref-free message still flushes a record, with deltas > 0", () => {
    const { flush } = runMessage([{ text: "no entity refs at all here\n", final: true }]);

    // The record's EXISTENCE is the evidence of running; the zero totals are the
    // separate fact that there was nothing to do.
    expect(flush).not.toBeNull();
    expect(flush?.deltas).toBe(1);
    expect(flush?.totals).toEqual(emptyCounts());
  });

  test("summarize reads that as ran-idle, not as absence", () => {
    const summary = summarizeFireLog(
      [{ at: AT, messageId: "m", deltas: 4, totals: emptyCounts() }],
      { nowMs: Date.parse(AT) + 60_000 }
    );

    expect(summary.verdict).toBe("ran-idle");
    expect(summary.messages).toBe(1);
    expect(summary.deltas).toBe(4);
    expect(summary.headline).toContain("RAN but rewrote 0 refs");
    expect(summary.headline).toContain("NOT the same as not running");
  });

  test("no records at all is never-ran — a different verdict entirely", () => {
    const summary = summarizeFireLog([], { nowMs: Date.parse(AT) });

    expect(summary.verdict).toBe("never-ran");
    expect(summary.headline).toContain("no fire log exists");
  });

  test("records exist but all fall outside the window — no-evidence, and it says so", () => {
    const summary = summarizeFireLog(
      [{ at: "2026-08-01T00:00:00.000Z", messageId: "m", deltas: 2, totals: emptyCounts() }],
      { nowMs: Date.parse(AT), windowHours: 24 }
    );

    expect(summary.verdict).toBe("no-evidence");
    expect(summary.messagesAllTime).toBe(1);
    expect(summary.messages).toBe(0);
    // The negative is bounded to the channel actually read (claim-confidence).
    expect(summary.headline).toContain("bounded to the fire log");
  });

  test("a message that ends WITHOUT its final delta leaves in-flight state, and that is not never-ran", () => {
    // Gate (l) named this: the flush rides the harness's `final` signal, so a
    // crashed or interrupted stream never flushes. The leftover fence state is
    // what keeps that from reading as 'the hook has never run'.
    const summary = summarizeFireLog([], {
      nowMs: Date.parse(AT),
      inFlightStatePresent: true,
    });

    expect(summary.verdict).not.toBe("never-ran");
    expect(summary.verdict).toBe("no-evidence");
    expect(summary.headline).toContain("in-flight message state IS present");
  });

  test("a rewrite inside the window is live", () => {
    const summary = summarizeFireLog(
      [{ at: AT, messageId: "m", deltas: 2, totals: { ...emptyCounts(), task: 3 } }],
      { nowMs: Date.parse(AT) + 60_000 }
    );

    expect(summary.verdict).toBe("live");
    expect(summary.linked).toBe(3);
    expect(summary.headline).toContain("LIVE");
  });
});

describe("AT4 — an unresolvable short id records a class-level miss", () => {
  test("with NO map at all, a mem# ref is counted as unresolved rather than ignored", () => {
    const { flush, display } = runMessage([{ text: "see mem#623 please\n", final: true }]);

    // It stays bare — that part is pre-existing, correct behavior.
    expect(display).toBeNull();
    // The point of AT4: the miss is RECORDED, so an absent map is not silent.
    expect(flush?.totals.shortIdUnresolved).toBe(1);
    expect(flush?.totals.memory).toBe(0);
  });

  test("with a map present but missing the entry, the miss is still recorded", () => {
    const { flush } = runMessage([{ text: "see mem#999999 please\n", final: true }], MAP);

    expect(flush?.totals.shortIdUnresolved).toBe(1);
    expect(flush?.totals.memory).toBe(0);
  });

  test("an unresolved-only window is ran-idle, and the headline names the bare ids", () => {
    const summary = summarizeFireLog(
      [{ at: AT, messageId: "m", deltas: 1, totals: { ...emptyCounts(), shortIdUnresolved: 2 } }],
      { nowMs: Date.parse(AT) + 60_000 }
    );

    // No LINK was produced, so this is not `live` — `shortIdUnresolved` is
    // deliberately excluded from the linked count.
    expect(summary.verdict).toBe("ran-idle");
    expect(summary.linked).toBe(0);
    expect(summary.headline).toContain("2 short ids stayed bare");
  });
});

describe("fire-log parsing degrades rather than discarding", () => {
  test("a torn trailing line does not lose the records before it", () => {
    const raw =
      `${JSON.stringify({ at: AT, messageId: "a", deltas: 1, totals: emptyCounts() })}\n` +
      `{"at":"2026-08-16T12:01:00.000Z","messageId":"b","delt`;

    const records = parseFireLog(raw);

    expect(records).toHaveLength(1);
    expect(records[0]?.messageId).toBe("a");
  });

  test("a record written before the totals field existed reads as zeros, not as a parse failure", () => {
    const records = parseFireLog(`${JSON.stringify({ at: AT, messageId: "old", deltas: 3 })}\n`);

    expect(records).toHaveLength(1);
    expect(records[0]?.totals).toEqual(emptyCounts());
  });
});

describe("PR #3026 R1 — a message with no id is recorded, not dropped and not blank", () => {
  test("the record carries a sentinel plus an explicit flag", () => {
    const { flush } = runMessage(
      [{ text: "mt#9\n", final: true }].map((d) => d),
      undefined,
      ""
    );

    // Option (b) of the review's two suggestions: keep the evidence that the
    // hook RAN — this channel's primary signal — while making the anomaly
    // legible rather than emitting an empty string that reads as a real id.
    expect(flush?.messageId).toBe("(unknown)");
    expect(flush?.messageIdMissing).toBe(true);
    expect(flush?.totals.task).toBe(1);
  });

  test("an ordinary message carries no anomaly flag at all", () => {
    const { flush } = runMessage([{ text: "mt#9\n", final: true }]);

    expect(flush?.messageId).toBe("msg-1");
    expect(flush?.messageIdMissing).toBeUndefined();
  });
});

describe("the flush fires exactly once per message", () => {
  test("non-final deltas produce no record", () => {
    const first = decideDisplay(delta("mt#1\n"), null, undefined, now);

    expect(first.flush).toBeNull();
    expect(first.nextState).not.toBeNull();
  });

  test("an empty final delta still flushes the tally accumulated by earlier deltas", () => {
    // The common shape: the message ends on a newline, so the final flush
    // carries an empty delta. The tally must survive it.
    const { flush } = runMessage([{ text: "mt#1 and mt#2\n" }, { text: "", final: true }]);

    expect(flush).not.toBeNull();
    expect(flush?.totals.task).toBe(2);
    expect(flush?.deltas).toBe(1);
  });

  test("a carried record written before mt#4145 (no totals field) does not throw", () => {
    // The rollout case: a state file from an older build is on disk, possibly
    // mid-stream. The display path must degrade to a zero tally, never throw —
    // a crash here costs the message, which is the one thing this hook's whole
    // contract forbids.
    const stored = { messageId: "msg-1", inFence: false } as Parameters<typeof decideDisplay>[1];

    const result = decideDisplay(delta("mt#7\n", { final: true }), stored, undefined, now);

    expect(result.flush?.totals.task).toBe(1);
    expect(result.flush?.deltas).toBe(1);
  });

  test("a new message_id resets the tally rather than inheriting the previous message's", () => {
    const first = decideDisplay(delta("mt#1\n"), null, undefined, now);
    const second = decideDisplay(
      delta("mt#2\n", { message_id: "msg-2", final: true }),
      first.nextState,
      undefined,
      now
    );

    expect(second.flush?.totals.task).toBe(1);
    expect(second.flush?.messageId).toBe("msg-2");
  });
});
