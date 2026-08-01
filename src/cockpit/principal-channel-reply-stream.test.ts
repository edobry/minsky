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
  /** Every editMessageText body, in order. */
  edits: Array<{ messageId: number; text: string }>;
}

function harness(
  opts: { throttleMs?: number; editStatus?: number; sendFails?: boolean } = {}
): Harness {
  const sends: string[] = [];
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
      send: async (text: string) => {
        sends.push(text);
        if (opts.sendFails) return undefined;
        nextMessageId += 1;
        return nextMessageId;
      },
    },
  });

  return { stream, sends, edits };
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

  test("settles on the resolved text, which can differ from what streamed", async () => {
    const { stream, edits } = harness({ throttleMs: 5 });

    stream.push("thinking out loud");
    await settle();
    await stream.finish("the actual answer");

    // The turn's resolved value is authoritative — a tool-use round streams
    // text that is not part of the final reply.
    expect(edits.at(-1)?.text).toBe("the actual answer");
  });

  test("a turn that never streams leaves the chat untouched", async () => {
    const { stream, sends, edits } = harness({ throttleMs: 5 });

    const settled = await stream.finish("the whole reply");

    // `undefined` is the caller's signal to send normally — no placeholder was
    // ever created, so there is nothing to edit and nothing to clean up.
    expect(settled).toBeUndefined();
    expect(sends).toEqual([]);
    expect(edits).toEqual([]);
  });

  test("a placeholder that never lands degrades to an ordinary send", async () => {
    const { stream, edits } = harness({ throttleMs: 5, sendFails: true });

    stream.push("some progress");
    await settle();
    const settled = await stream.finish("the whole reply");

    expect(settled).toBeUndefined();
    // No edit is attempted against a message id that does not exist.
    expect(edits).toEqual([]);
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
