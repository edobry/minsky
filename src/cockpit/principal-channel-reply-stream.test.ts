/**
 * Streamed replies (mt#3542).
 *
 * Covers the task's acceptance tests that do not need a live `claude` turn:
 * AT2 (throttle), AT3 (chunk split), AT4 (a failed edit still delivers).
 * AT1/AT6 need a real turn and a real chat — `scripts/principal-channel/verify-streaming.ts`.
 */

import { describe, expect, test } from "bun:test";
import {
  createReplyStream,
  findChunkBreak,
  renderTelegramPayload,
  type ReplyStream,
} from "./principal-channel-reply-stream";

const TOKEN = "test-token";
const CHAT = "12345";
const MAX = 200;
const MAX_RENDERED = 4096;

interface Harness {
  stream: ReplyStream;
  /** Text of every NEW message sent, in order. */
  sends: string[];
  /** Whether each corresponding {@link sends} entry asked to be silent (mt#3711). */
  sendSilent: boolean[];
  /** Every editMessageText body, in order. */
  edits: Array<{ messageId: number; text: string }>;
}

function harness(
  opts: {
    throttleMs?: number;
    editStatus?: number;
    sendFails?: boolean;
    editOkFalse?: boolean;
  } = {}
): Harness {
  const sends: string[] = [];
  const sendSilent: boolean[] = [];
  const edits: Array<{ messageId: number; text: string }> = [];
  let nextMessageId = 100;

  const fetchFn = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const parsed = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (String(url).includes("editMessageText")) {
      edits.push({
        messageId: Number(parsed["message_id"]),
        text: String(parsed["text"]),
      });
      if (opts.editStatus !== undefined) {
        return new Response(JSON.stringify({ ok: false, description: "Bad Request" }), {
          status: opts.editStatus,
        });
      }
      if (opts.editOkFalse) {
        // HTTP 200 with an `ok: false` envelope — the shape that looks like
        // success to anything reading only the status code.
        return new Response(JSON.stringify({ ok: false, description: "Bad Request: nope" }));
      }
      return new Response(JSON.stringify({ ok: true, result: true }));
    }
    return new Response(JSON.stringify({ ok: true, result: {} }));
  };

  const stream = createReplyStream({
    token: TOKEN,
    chatId: CHAT,
    maxChars: MAX,
    maxRenderedChars: MAX_RENDERED,
    fetchFn: fetchFn as unknown as typeof fetch,
    ...(opts.throttleMs === undefined ? {} : { throttleMs: opts.throttleMs }),
    transport: {
      send: async (text: string, sendOpts?: { silent?: boolean }) => {
        sends.push(text);
        // Parallel to `sends` rather than folded into it: the existing cases
        // assert on `sends` by value, and widening its element type would
        // rewrite tests that have nothing to do with notifications.
        sendSilent.push(sendOpts?.silent === true);
        if (opts.sendFails) return undefined;
        nextMessageId += 1;
        return nextMessageId;
      },
    },
  });

  return { stream, sends, sendSilent, edits };
}

/** Let the stream's timer fire and its in-flight write settle. */
async function settle(ms = 30): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("renderTelegramPayload", () => {
  test("renders markdown as HTML and keeps the plain text as a fallback", () => {
    const payload = renderTelegramPayload("**bold** and `code`", MAX_RENDERED);

    expect(payload.parseMode).toBe("HTML");
    expect(payload.text).toBe("<b>bold</b> and <code>code</code>");
    expect(payload.plainFallback).toBe("**bold** and `code`");
  });

  test("falls back to unstyled when the RENDERED payload would exceed the ceiling", () => {
    // Markdown inside the budget can still render past it — tags inflate.
    const markdown = "**x**".repeat(40);
    const payload = renderTelegramPayload(markdown, 100);

    expect(payload.parseMode).toBeUndefined();
    expect(payload.text).toBe(markdown);
  });
});

describe("findChunkBreak", () => {
  test("returns the whole length when it already fits", () => {
    expect(findChunkBreak("short", 100)).toBe(5);
  });

  test("prefers a paragraph break over a bare space", () => {
    const text = `${"a".repeat(80)}\n\n${"b".repeat(80)}`;
    expect(findChunkBreak(text, 100)).toBe(82);
  });

  test("hard-cuts when the window holds no break at all", () => {
    // One unbroken token longer than the budget — nothing better is available.
    expect(findChunkBreak("z".repeat(300), 100)).toBe(100);
  });

  test("never severs an emoji's surrogate pair at a hard cut", () => {
    // Each 🔍 is TWO UTF-16 code units. A cut at an odd offset inside the run
    // would emit a lone surrogate, which downstream JSON re-parsers reject.
    const at = findChunkBreak("🔍".repeat(50), 25);

    expect(at % 2).toBe(0);
    expect(at).toBe(24);
  });

  test("never cuts before the last quarter of the window", () => {
    // A break at index 5 would waste 95% of the message.
    const text = `abc ${"z".repeat(300)}`;
    expect(findChunkBreak(text, 100)).toBe(100);
  });
});

describe("createReplyStream", () => {
  test("AT2 — a token stream faster than the throttle does not produce a write per chunk", async () => {
    // Pushes are SPACED IN TIME on purpose. A synchronous burst collapses into
    // one flush no matter what the throttle does (every push lands in the same
    // macrotask, and the dedupe drops the repeats), so a tight loop would pass
    // with the throttle removed — it would measure batching, not throttling.
    //
    // 12 distinct chunks over ~120ms against a 60ms window: throttled that is a
    // small number of writes, unthrottled it is one per chunk.
    const { stream, sends, edits } = harness({ throttleMs: 60 });

    let accumulated = "";
    for (let i = 0; i < 12; i += 1) {
      accumulated += `chunk${i} `;
      stream.push(accumulated);
      await settle(10);
    }
    await settle(80);

    const writes = sends.length + edits.length;
    expect(writes).toBeGreaterThan(0);
    expect(writes).toBeLessThanOrEqual(5);

    // The placeholder still goes out immediately — throttling must not make the
    // principal wait a full window before anything at all appears.
    expect(sends.length).toBe(1);
  });

  test("SC2 — a mid-tag markdown prefix still renders as balanced HTML", async () => {
    // The failure this guards against: slicing RENDERED html can cut through a
    // tag ("<b>bo") and Telegram 400s the edit. Converting from the accumulated
    // MARKDOWN instead means a half-written "**bo" is just literal text.
    //
    // A stream necessarily renders mid-token states — every delta boundary is
    // one — so this is the steady state, not an edge case.
    const { stream, sends, edits } = harness({ throttleMs: 5 });

    for (const prefix of ["**bo", "**bold** and `co", "**bold** and `code` [link](htt"]) {
      stream.push(prefix);
      await settle();
    }
    await stream.finish("**bold** and `code` [link](https://example.com)");
    await settle();

    for (const text of [...sends, ...edits.map((e) => e.text)]) {
      const opens = (text.match(/<(b|i|code|pre|a|s|u|blockquote)\b/g) ?? []).length;
      const closes = (text.match(/<\/(b|i|code|pre|a|s|u|blockquote)>/g) ?? []).length;
      expect(opens).toBe(closes);
      // A lone "<" from a severed tag would be the tell.
      expect(text).not.toContain("<b>bo<");
    }

    // And the settled message is the fully formed thing.
    expect(edits.at(-1)?.text).toContain("<b>bold</b>");
    expect(edits.at(-1)?.text).toContain('href="https://example.com"');
  });

  test("only the placeholder is a new message; later updates are edits", async () => {
    const { stream, sends, edits } = harness({ throttleMs: 5 });

    stream.push("one");
    await settle();
    stream.push("one two");
    await settle();
    stream.push("one two three");
    await settle();

    expect(sends).toEqual(["one"]);
    expect(edits.map((e) => e.text)).toContain("one two three");
    // Every edit targets the placeholder — a second message would notify the phone.
    expect(new Set(edits.map((e) => e.messageId)).size).toBe(1);
  });

  test("AT3 — content crossing the per-message budget opens a second message", async () => {
    const { stream, sends } = harness({ throttleMs: 5 });

    const first = "alpha ".repeat(30); // ~180 chars, inside MAX
    const overflow = `${first}\n\n${"beta ".repeat(40)}`; // pushes past MAX
    stream.push(first);
    await settle();
    stream.push(overflow);
    await settle();
    await stream.finish(overflow);
    await settle();

    expect(sends.length).toBe(2);
    expect(sends[0]?.length).toBeLessThanOrEqual(MAX);
    // The split lands ON the paragraph break, which is consumed by the cut — a
    // message must not open with a blank line. So the halves do not concatenate
    // back byte-for-byte; what must hold is that no CONTENT was lost and
    // nothing was cut mid-word.
    expect(overflow.startsWith(sends[0] ?? "")).toBe(true);
    expect(overflow.endsWith(sends[1] ?? "")).toBe(true);
    expect(sends[1]?.startsWith("beta")).toBe(true);
  });

  test("AT4 — an edit that 400s still delivers the complete final reply", async () => {
    const { stream, sends, edits } = harness({ throttleMs: 5, editStatus: 400 });

    stream.push("partial");
    await settle();
    stream.push("partial and more");
    await settle();

    const settled = await stream.finish("the complete final answer");

    // The edit was attempted and refused...
    expect(edits.length).toBeGreaterThan(0);
    // ...and the reply is still delivered, by falling back to an ordinary send.
    expect(settled).toBeUndefined();
    expect(sends).toEqual(["partial"]);
  });

  test("PR #2538 R1 — an edit answering 200 with `ok: false` does not count as delivered", async () => {
    // The dangerous shape: a failure that looks like success to anything
    // reading only the status code. If it were accepted, the stream would
    // advance its state, `finish()` would hand back a message id, and the
    // poller would count a stale placeholder as the delivered reply — the
    // principal never sees the answer.
    const { stream, sends, edits } = harness({ throttleMs: 5, editOkFalse: true });

    stream.push("partial");
    await settle();
    stream.push("partial and more");
    await settle();

    const settled = await stream.finish("the complete final answer");

    expect(edits.length).toBeGreaterThan(0);
    expect(settled).toBeUndefined();
    expect(sends).toEqual(["partial"]);
  });

  test("the settle EXTENDS what streamed rather than replacing it", async () => {
    const { stream, edits } = harness({ throttleMs: 5 });

    stream.push("the answer is");
    await settle();
    await stream.finish("the answer is 42");

    // Pure growth: the resolved text continues what the reader already sees,
    // so it is written straight into the open message.
    expect(edits.at(-1)?.text).toBe("the answer is 42");
  });

  /**
   * mt#3711 R2, in the principal's own words: *"you were streaming output and
   * you were editing your message and then when you were done you overwrote
   * everything you previously wrote and the message shrank back down."*
   *
   * This is the exact shape of a tool-heavy turn: the deltas carry
   * interstitial prose around each tool round, and `result` carries only the
   * final answer, which is SHORTER. The old `finish` set `pending = finalText`
   * and rewrote the open message to it, so text the principal had already read
   * disappeared at the moment the turn completed.
   */
  test("the settle never takes back text the reader has already seen", async () => {
    const { stream, sends, edits } = harness({ throttleMs: 5 });

    stream.push("Looking at the auth module now. Nothing obviously wrong there.");
    await settle();

    await stream.finish("Nothing obviously wrong there.");

    // The resolved answer is already on screen — it is a suffix of what
    // streamed — so nothing is written and, crucially, nothing is removed.
    const delivered = [...sends, ...edits.map((e) => e.text)];
    expect(delivered.some((t) => t.includes("Looking at the auth module now."))).toBe(true);
    expect(delivered.at(-1)).not.toBe("Nothing obviously wrong there.");
  });

  test("a resolved text that continues nothing on screen arrives as its OWN message", async () => {
    const { stream, sends } = harness({ throttleMs: 5 });

    stream.push("still working on it");
    await settle();

    // The timeout notice: authoritative, and not a continuation of anything
    // streamed. Appending it keeps the streamed prose AND delivers the answer.
    await stream.finish("Still working on that — it is taking longer than expected.");
    await settle();

    expect(sends).toHaveLength(2);
    expect(sends[0]).toBe("still working on it");
    expect(sends[1]).toBe("Still working on that — it is taking longer than expected.");
  });

  test("push after finish is ignored", async () => {
    const { stream, edits } = harness({ throttleMs: 5 });

    stream.push("a");
    await settle();
    await stream.finish("final");
    const afterFinish = edits.length;

    stream.push("a late straggler that must not reopen the stream");
    await settle();

    expect(edits.length).toBe(afterFinish);
  });
});

/**
 * Semantic-block segmentation (mt#3711).
 *
 * The unit of a message is a run of prose between tool calls, not a char-budget
 * overflow. `sealBlock()` is the boundary the session driver reports when a tool call
 * starts.
 */
describe("createReplyStream — semantic blocks (mt#3711)", () => {
  test("three prose blocks separated by tool calls produce three messages, and only the first notifies", async () => {
    const { stream, sendSilent, sends } = harness({ throttleMs: 5 });

    stream.push("first, I will look at the config.");
    await settle();
    stream.sealBlock();
    stream.push("first, I will look at the config.now reading the handler.");
    await settle();
    stream.sealBlock();
    stream.push("first, I will look at the config.now reading the handler.here is what I found.");
    await settle();

    expect(sends).toEqual([
      "first, I will look at the config.",
      "now reading the handler.",
      "here is what I found.",
    ]);
    // SC2: one notification per turn regardless of block count.
    expect(sendSilent).toEqual([false, true, true]);
  });

  test("a single-block turn is still ONE message, edited rather than re-sent", async () => {
    const { stream, sends, edits } = harness({ throttleMs: 5 });

    stream.push("thinking");
    await settle();
    stream.push("thinking about it");
    await settle();
    stream.push("thinking about it carefully");
    await settle();

    // SC3: within-block streaming is unchanged — mt#3542's property must not
    // regress just because block boundaries now exist.
    expect(sends).toEqual(["thinking"]);
    expect(edits.length).toBeGreaterThan(0);
    expect(edits.at(-1)?.text).toBe("thinking about it carefully");
  });

  test("back-to-back tool calls with nothing said between them open no empty message", async () => {
    const { stream, sends } = harness({ throttleMs: 5 });

    stream.push("checking a few things");
    await settle();
    stream.sealBlock();
    stream.sealBlock();
    stream.sealBlock();
    await settle();
    stream.push("checking a few thingsdone.");
    await settle();

    expect(sends).toEqual(["checking a few things", "done."]);
  });

  test("a block longer than the char budget still splits within itself at a line break", async () => {
    const { stream, sends, sendSilent } = harness({ throttleMs: 5 });

    // One block, no seal — the split below is the char budget's doing, not a
    // semantic boundary, and both mechanisms have to keep working together.
    const firstLine = "x".repeat(MAX - 10);
    stream.push(`${firstLine}\nand the tail that overflows`);
    await settle();

    expect(sends.length).toBeGreaterThan(1);
    // `findChunkBreak` returns an index PAST the separator, so the newline
    // stays on the first chunk and the second does not open with a blank line.
    expect(sends[0]).toBe(`${firstLine}\n`);
    expect(sends[1]).toBe("and the tail that overflows");
    // Still exactly one notification, even though this split was not semantic:
    // a budget overflow must not cost the principal an extra buzz either.
    expect(sendSilent).toEqual([false, true]);
  });

  test("a seal recorded mid-flight keeps later text out of the block before it", async () => {
    const { stream, sends } = harness({ throttleMs: 1_000 });

    // Nothing has flushed yet: the seal must bind to the text seen NOW, not to
    // whatever `pending` holds when the timer eventually fires.
    stream.push("before the tool call");
    stream.sealBlock();
    stream.push("before the tool calland after it");
    await settle(1_200);

    expect(sends).toEqual(["before the tool call", "and after it"]);
  });

  /**
   * SC4, invariant 3 — the one the spec warns gets HARDER here.
   *
   * Under edit-in-place a flush produced one write, so the throttle alone kept
   * the cadence legal. A flush can now find several blocks queued and would
   * emit a SEND for each, back to back, inside a single window — and a send is
   * far more likely than an edit to count against Telegram's ~1/sec ceiling.
   *
   * Eight blocks are queued here BEFORE any flush runs, which is the shape a
   * fast alternation of prose and tool calls produces. Unpaced, the first flush
   * would send all eight.
   */
  test("SC4 — blocks queued in one window do not burst as one send each", async () => {
    const { stream, sends } = harness({ throttleMs: 60 });

    let accumulated = "";
    for (let i = 0; i < 8; i += 1) {
      accumulated += `block ${i}. `;
      stream.push(accumulated);
      stream.sealBlock();
    }
    // Exactly one window, so at most one message may have been opened in it
    // beyond the placeholder that goes out immediately.
    await settle(70);

    expect(sends.length).toBeGreaterThan(0);
    expect(sends.length).toBeLessThanOrEqual(2);

    // The deferred blocks are not dropped — they arrive over later windows.
    await settle(700);
    expect(sends.length).toBe(8);
  });

  /**
   * The bug pacing introduced, and the reason `finish` flushes before it
   * settles.
   *
   * Pacing defers queued blocks to the next window; `finish` cancels that
   * window. The settle's append branch advances `offset` to `pending.length`
   * on the premise that everything before it is already on screen — which
   * pacing makes false, so a deferred block was silently skipped and the
   * principal never saw it.
   */
  test("finish delivers blocks the pacing deferred rather than skipping them", async () => {
    const { stream, sends } = harness({ throttleMs: 40 });

    stream.push("first block");
    stream.sealBlock();
    stream.push("first blocksecond block");
    stream.sealBlock();
    stream.push("first blocksecond blockthird block");
    // One window only: the later blocks are still queued when finish lands.
    await settle(50);

    await stream.finish("an unrelated resolved answer");

    const delivered = sends.join("|");
    expect(delivered).toContain("first block");
    expect(delivered).toContain("second block");
    expect(delivered).toContain("third block");
    expect(delivered).toContain("an unrelated resolved answer");
  });

  /**
   * PR #3039 review, NON-BLOCKING finding: the "already on screen" check
   * matched against the whole accumulation.
   *
   * A short resolved answer can appear in an EARLIER block by coincidence —
   * "Done." is the obvious one — and matching the whole turn would then
   * conclude the reader has already seen the final answer and deliver nothing
   * at all. The check is scoped to the open message instead. The failure
   * directions are asymmetric: matching too widely loses the answer, matching
   * too narrowly repeats a line, and only one of those is a lost reply.
   */
  test("a short resolved answer echoing an EARLIER block is still delivered", async () => {
    const { stream, sends } = harness({ throttleMs: 5 });

    stream.push("Done. Now checking the handler.");
    await settle();
    stream.sealBlock();
    stream.push("Done. Now checking the handler.The handler looks fine.");
    await settle();

    // "Done." sits in the MIDDLE of what was delivered, not at its end.
    // Suppressing on a bare `includes` would mean the turn's answer never
    // reaches the chat.
    await stream.finish("Done.");
    await settle();

    expect(sends.at(-1)).toBe("Done.");
  });

  /**
   * mt#4240 — the settle must not re-send text that is already on screen just
   * because the message carrying it was CLOSED.
   *
   * `finish` used to ask "is the resolved text inside `pending.slice(offset)`?"
   * — the OPEN message's share of the accumulation. Both tests below construct
   * a turn where the answer is fully delivered and that slice cannot see it, so
   * the check fell through to the new-message branch and sent the whole answer
   * a second time. Measured on 12 of 41 real turns across the channel's seven
   * conversations before the fix.
   */
  test("a turn ENDING on a tool call does not re-send its final prose", async () => {
    const { stream, sends } = harness({ throttleMs: 5 });

    const b1 = "Reading the config. ";
    const b2 = "Checking the wiring. ";
    const b3 = "Notion MCP is connected.";

    stream.push(b1);
    await settle();
    stream.sealBlock();
    stream.push(b1 + b2);
    await settle();
    stream.sealBlock();
    stream.push(b1 + b2 + b3);
    await settle();
    // The turn's LAST event is a tool call, so the block carrying the answer is
    // sealed shut and `offset` lands exactly at `pending.length`.
    stream.sealBlock();
    await settle();

    await stream.finish(b3);
    await settle();

    expect(sends).toEqual([b1, b2, b3]);
  });

  test("a final answer longer than the per-message budget is delivered once, not twice", async () => {
    const { stream, sends } = harness({ throttleMs: 5 });

    const intro = "Looking into it. ";
    // Comfortably past MAX (200), so `drain` splits it across messages and
    // advances `offset` into the MIDDLE of the answer.
    const answer = `ANSWERSTART ${"filler ".repeat(60)}ANSWEREND`;

    stream.push(intro);
    await settle();
    stream.sealBlock();
    stream.push(intro + answer);
    await settle(120);

    await stream.finish(answer);
    await settle(120);

    // Sentinels rather than a length comparison: a split consumes the
    // whitespace it cuts on, so the delivered text does not concatenate back
    // byte-for-byte and an exact total would be brittle. Each sentinel appearing
    // once is the precise statement of "delivered once".
    const all = sends.join(" ");
    expect(all.split("ANSWERSTART").length - 1).toBe(1);
    expect(all.split("ANSWEREND").length - 1).toBe(1);
    // Control: it was delivered at all, and it did split — so the assertions
    // above are about de-duplication and not about an empty stream.
    expect(sends.length).toBeGreaterThan(2);
  });

  test("a resolved text differing only by trailing whitespace is neither re-sent nor shrunk", async () => {
    const { stream, sends, edits } = harness({ throttleMs: 5 });

    // The deltas and `result` are different fields of the same turn and drift
    // by a trailing newline routinely; an exact compare would treat that as a
    // divergence and re-send the whole answer.
    stream.push("All set.\n");
    await settle();

    const editsBeforeSettle = edits.length;
    await stream.finish("All set.");
    await settle();

    // Not re-sent (invariant 2).
    expect(sends).toEqual(["All set.\n"]);

    // Not SHRUNK either (invariant 4) — PR #3091 R1. Asserting only `sends`
    // leaves the settle free to EDIT the message down to the untrailing-newline
    // value, which takes back a character the reader was already given and is
    // invisible to a send-only assertion. The edit count is what makes the
    // difference observable.
    expect(edits.length).toBe(editsBeforeSettle);
    expect([...sends, ...edits.map((e) => e.text)].at(-1)).toBe("All set.\n");
  });
});
