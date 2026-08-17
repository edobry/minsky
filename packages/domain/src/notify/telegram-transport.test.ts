/**
 * Tests for the Telegram Bot API transport (mt#3228).
 *
 * The redaction cases are the load-bearing ones: the bot token rides in the
 * URL path, so a leak into a returned string becomes a leak into logs and the
 * transcript DB.
 */

import { describe, expect, test } from "bun:test";
import type { FetchFn } from "./telegram-transport";
import {
  classifyGetUpdatesFailure,
  fetchTelegramFile,
  getTelegramMe,
  getTelegramUpdates,
  highestUpdateIdOf,
  isThreadNotFoundError,
  parseInboundUpdates,
  redactSecret,
  editTelegramMessage,
  sendTelegramMessage,
  sendTelegramMessageWithThreadFallback,
  sendTelegramTypingAction,
} from "./telegram-transport";

const TOKEN = "123456:FAKE-TOKEN-VALUE";
const CHAT = "42";
/** Telegram's wire key for a topic thread — shared across many test bodies below. */
const THREAD_ID_KEY = "message_thread_id";
/** Telegram's wire key for a send that must not raise a notification (mt#3711). */
const DISABLE_NOTIFICATION_KEY = "disable_notification";
/** Telegram's rejection text for markup it cannot parse — shared across the parse-mode cases. */
const CANT_PARSE_ENTITIES = "can't parse entities";
/** A representative alert body — shared across the byte-for-byte regression cases. */
const SAMPLE_ALERT_TEXT = "circuit breaker tripped";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("redactSecret", () => {
  test("replaces every occurrence of the secret", () => {
    expect(redactSecret("abc", "x abc y abc z")).toBe("x ***REDACTED*** y ***REDACTED*** z");
  });

  test("returns the text unchanged when the secret is empty", () => {
    expect(redactSecret("", "nothing to redact")).toBe("nothing to redact");
  });
});

describe("sendTelegramMessage", () => {
  test("posts to the sendMessage endpoint and returns the message id", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const result = await sendTelegramMessage({
      token: TOKEN,
      chatId: CHAT,
      text: "hello",
      fetchFn: async (url, init) => {
        calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return jsonResponse({ ok: true, result: { message_id: 7 } });
      },
    });

    expect(result).toEqual({ ok: true, messageId: 7 });
    expect(calls[0]?.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(calls[0]?.body).toMatchObject({
      chat_id: CHAT,
      text: "hello",
      disable_web_page_preview: true,
    });
  });

  test("omits reply_to_message_id unless a reply target is given", async () => {
    let sent: Record<string, unknown> = {};
    await sendTelegramMessage({
      token: TOKEN,
      chatId: CHAT,
      text: "hi",
      fetchFn: async (_url, init) => {
        sent = JSON.parse(String(init?.body));
        return jsonResponse({ ok: true, result: { message_id: 1 } });
      },
    });
    expect("reply_to_message_id" in sent).toBe(false);
  });

  test("threads the message when a reply target is given", async () => {
    let sent: Record<string, unknown> = {};
    await sendTelegramMessage({
      token: TOKEN,
      chatId: CHAT,
      text: "hi",
      replyToMessageId: 99,
      fetchFn: async (_url, init) => {
        sent = JSON.parse(String(init?.body));
        return jsonResponse({ ok: true, result: { message_id: 1 } });
      },
    });
    expect(sent["reply_to_message_id"]).toBe(99);
  });

  test("redacts the token out of a network-error detail", async () => {
    const result = await sendTelegramMessage({
      token: TOKEN,
      chatId: CHAT,
      text: "hello",
      fetchFn: async () => {
        throw new Error(`connect failed for https://api.telegram.org/bot${TOKEN}/sendMessage`);
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).not.toContain(TOKEN);
    expect(result.detail).toContain("***REDACTED***");
  });

  test("redacts the token out of a non-2xx body echo", async () => {
    const result = await sendTelegramMessage({
      token: TOKEN,
      chatId: CHAT,
      text: "hello",
      fetchFn: async () =>
        new Response(`{"ok":false,"description":"bad token ${TOKEN}"}`, { status: 401 }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(401);
    expect(result.detail).not.toContain(TOKEN);
  });

  test("treats a 2xx without a message id as a failure", async () => {
    const result = await sendTelegramMessage({
      token: TOKEN,
      chatId: CHAT,
      text: "hello",
      fetchFn: async () => jsonResponse({ ok: true }),
    });
    expect(result.ok).toBe(false);
  });
});

/**
 * Formatted sends (mt#3465).
 *
 * The invariant these protect is the one the plain-text default was built on:
 * a delivery failure is worse than unstyled text. Adding a parse mode must not
 * trade that away, so a 400 has to degrade to a delivered plain message rather
 * than to silence.
 */
describe("sendTelegramMessage — parse mode", () => {
  function capture(): { bodies: Record<string, unknown>[]; fetchFn: FetchFn } {
    const bodies: Record<string, unknown>[] = [];
    const fetchFn: FetchFn = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return jsonResponse({ ok: true, result: { message_id: 7 } });
    };
    return { bodies, fetchFn };
  }

  test("omits parse_mode by default, preserving the alert-path contract", async () => {
    const { bodies, fetchFn } = capture();
    await sendTelegramMessage({ token: TOKEN, chatId: CHAT, text: "alert", fetchFn });
    expect("parse_mode" in (bodies[0] ?? {})).toBe(false);
  });

  test("sends parse_mode when the caller opts in", async () => {
    const { bodies, fetchFn } = capture();
    await sendTelegramMessage({
      token: TOKEN,
      chatId: CHAT,
      text: "<b>hi</b>",
      parseMode: "HTML",
      fetchFn,
    });
    expect(bodies[0]?.["parse_mode"]).toBe("HTML");
    expect(bodies[0]?.["text"]).toBe("<b>hi</b>");
  });

  test("retries as plain text when Telegram rejects the markup with 400", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchFn: FetchFn = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if (body["parse_mode"] !== undefined) {
        return jsonResponse({ ok: false, description: CANT_PARSE_ENTITIES }, 400);
      }
      return jsonResponse({ ok: true, result: { message_id: 9 } });
    };

    const result = await sendTelegramMessage({
      token: TOKEN,
      chatId: CHAT,
      text: "<b>broken",
      parseMode: "HTML",
      plainFallback: "**broken",
      fetchFn,
    });

    // Delivered, not lost — the whole point. And FLAGGED: a silent fallback
    // would make a systematically-broken converter look healthy, since every
    // message would still arrive (SC3 requires the parse error be logged).
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.messageId).toBe(9);
      expect(result.fellBackToPlain).toBe(true);
      expect(result.parseError).toContain("400");
    }
    expect(bodies).toHaveLength(2);
    expect(bodies[1]?.["text"]).toBe("**broken");
    expect("parse_mode" in (bodies[1] ?? {})).toBe(false);
  });

  test("does NOT retry on a non-400 failure", async () => {
    // 429/5xx are about the chat or the service; resending unstyled would not
    // help and would double the load on an already-failing endpoint.
    let calls = 0;
    const fetchFn: FetchFn = async () => {
      calls += 1;
      return jsonResponse({ ok: false, description: "Too Many Requests" }, 429);
    };

    const result = await sendTelegramMessage({
      token: TOKEN,
      chatId: CHAT,
      text: "<b>hi</b>",
      parseMode: "HTML",
      plainFallback: "hi",
      fetchFn,
    });

    expect(result.ok).toBe(false);
    expect(calls).toBe(1);
  });

  test("does not retry when the caller supplied no fallback", async () => {
    let calls = 0;
    const fetchFn: FetchFn = async () => {
      calls += 1;
      return jsonResponse({ ok: false, description: CANT_PARSE_ENTITIES }, 400);
    };

    const result = await sendTelegramMessage({
      token: TOKEN,
      chatId: CHAT,
      text: "<b>hi",
      parseMode: "HTML",
      fetchFn,
    });

    expect(result.ok).toBe(false);
    expect(calls).toBe(1);
  });
});

describe("sendTelegramTypingAction", () => {
  test("reports success on a 2xx", async () => {
    const ok = await sendTelegramTypingAction({
      token: TOKEN,
      chatId: CHAT,
      fetchFn: async () => jsonResponse({ ok: true, result: true }),
    });
    expect(ok).toBe(true);
  });

  test("swallows a throw rather than propagating it", async () => {
    const ok = await sendTelegramTypingAction({
      token: TOKEN,
      chatId: CHAT,
      fetchFn: async () => {
        throw new Error("offline");
      },
    });
    expect(ok).toBe(false);
  });
});

describe("parseInboundUpdates", () => {
  test("extracts the fields the router consumes", () => {
    const messages = parseInboundUpdates({
      ok: true,
      result: [
        {
          update_id: 10,
          message: {
            message_id: 5,
            date: 1700000000,
            chat: { id: -42, type: "private" },
            from: { id: 777, username: "principal" },
            text: "what is blocked?",
            reply_to_message: { message_id: 4 },
          },
        },
      ],
    });

    expect(messages).toEqual([
      {
        updateId: 10,
        messageId: 5,
        chatId: "-42",
        fromId: "777",
        text: "what is blocked?",
        date: 1700000000,
        replyToMessageId: 4,
        replyToText: undefined,
        attachments: [],
        unsupportedMedia: undefined,
        messageThreadId: undefined,
        isTopicMessage: false,
      },
    ]);
  });

  // mt#3243: the reply target's id alone tells the agent nothing it can use —
  // it cannot look a message id up. Carrying the quoted TEXT is what makes
  // Telegram's reply affordance mean anything on the receiving end.
  test("extracts the quoted message's text, not just its id", () => {
    const messages = parseInboundUpdates({
      ok: true,
      result: [
        {
          update_id: 11,
          message: {
            message_id: 6,
            chat: { id: -42, type: "private" },
            from: { id: 777 },
            text: "focus on that one",
            reply_to_message: { message_id: 4, text: "mt#3243 is the next task" },
          },
        },
      ],
    });

    expect(messages[0]?.replyToText).toBe("mt#3243 is the next task");
    expect(messages[0]?.replyToMessageId).toBe(4);
  });

  test("leaves replyToText undefined when the quoted message carries no text", () => {
    // A reply to a photo/sticker has a reply_to_message with no `text`.
    const messages = parseInboundUpdates({
      ok: true,
      result: [
        {
          update_id: 12,
          message: {
            message_id: 7,
            chat: { id: -42, type: "private" },
            text: "what is this?",
            reply_to_message: { message_id: 4, photo: [{ file_id: "abc" }] },
          },
        },
      ],
    });

    expect(messages[0]?.replyToText).toBeUndefined();
    expect(messages[0]?.replyToMessageId).toBe(4);
  });

  // PR #2352 R1 (BLOCKING): media carries its text in `caption`, not `text`.
  // The test above originally asserted undefined for a captioned photo, which
  // encoded the gap as correct behavior — replying to a captioned image is a
  // common shape and it silently lost the quote.
  test("falls back to the quoted message's caption when it has no text", () => {
    const messages = parseInboundUpdates({
      ok: true,
      result: [
        {
          update_id: 13,
          message: {
            message_id: 8,
            chat: { id: -42, type: "private" },
            text: "what does this show?",
            reply_to_message: {
              message_id: 4,
              photo: [{ file_id: "abc" }],
              caption: "the deploy graph after the fix",
            },
          },
        },
      ],
    });

    expect(messages[0]?.replyToText).toBe("the deploy graph after the fix");
    expect(messages[0]?.replyToMessageId).toBe(4);
  });

  test("prefers text over caption when a quoted message somehow has both", () => {
    const messages = parseInboundUpdates({
      ok: true,
      result: [
        {
          update_id: 14,
          message: {
            message_id: 9,
            chat: { id: -42, type: "private" },
            text: "which?",
            reply_to_message: { message_id: 4, text: "the text", caption: "the caption" },
          },
        },
      ],
    });

    expect(messages[0]?.replyToText).toBe("the text");
  });

  test("skips updates without usable text", () => {
    const messages = parseInboundUpdates({
      result: [
        { update_id: 1, message: { message_id: 1, chat: { id: 1 } } },
        { update_id: 2, message: { message_id: 2, chat: { id: 1 }, text: "   " } },
        { update_id: 3, message: { message_id: 3, chat: { id: 1 }, text: "real" } },
      ],
    });
    expect(messages.map((m) => m.updateId)).toEqual([3]);
  });

  test("tolerates non-object and empty bodies", () => {
    expect(parseInboundUpdates(null)).toEqual([]);
    expect(parseInboundUpdates("nope")).toEqual([]);
    expect(parseInboundUpdates({ result: "not-an-array" })).toEqual([]);
    expect(parseInboundUpdates({ result: [] })).toEqual([]);
  });
});

describe("highestUpdateIdOf", () => {
  test("counts updates the message parser skips", () => {
    // The cursor must clear an unparseable update, or the poll re-fetches it
    // forever.
    const body = {
      result: [
        { update_id: 8, message: { message_id: 1, chat: { id: 1 }, text: "ok" } },
        { update_id: 9, edited_message: { message_id: 2 } },
      ],
    };
    expect(parseInboundUpdates(body).map((m) => m.updateId)).toEqual([8]);
    expect(highestUpdateIdOf(body)).toBe(9);
  });

  test("is undefined when there are no updates", () => {
    expect(highestUpdateIdOf({ result: [] })).toBeUndefined();
  });
});

describe("getTelegramUpdates", () => {
  test("sends the offset, long-poll timeout, and update filter", async () => {
    let sent: Record<string, unknown> = {};
    await getTelegramUpdates({
      token: TOKEN,
      offset: 11,
      timeoutSec: 25,
      fetchFn: async (_url, init) => {
        sent = JSON.parse(String(init?.body));
        return jsonResponse({ ok: true, result: [] });
      },
    });

    expect(sent).toEqual({ offset: 11, timeout: 25, allowed_updates: ["message"] });
  });

  test("omits the offset on a cold start", async () => {
    let sent: Record<string, unknown> = {};
    await getTelegramUpdates({
      token: TOKEN,
      fetchFn: async (_url, init) => {
        sent = JSON.parse(String(init?.body));
        return jsonResponse({ ok: true, result: [] });
      },
    });
    expect("offset" in sent).toBe(false);
  });

  test("returns parsed messages and the cursor", async () => {
    const result = await getTelegramUpdates({
      token: TOKEN,
      fetchFn: async () =>
        jsonResponse({
          ok: true,
          result: [
            { update_id: 3, message: { message_id: 1, chat: { id: 1 }, text: "a" } },
            { update_id: 4, message: { message_id: 2, chat: { id: 1 }, text: "b" } },
          ],
        }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.messages.map((m) => m.text)).toEqual(["a", "b"]);
    expect(result.highestUpdateId).toBe(4);
  });

  test("redacts the token from a failure detail", async () => {
    const result = await getTelegramUpdates({
      token: TOKEN,
      fetchFn: async () => new Response(`unauthorized ${TOKEN}`, { status: 401 }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).not.toContain(TOKEN);
  });
});

describe("classifyGetUpdatesFailure", () => {
  test("names the webhook conflict for 409", () => {
    expect(classifyGetUpdatesFailure(409)).toContain("webhook");
  });

  test("names the token for 401", () => {
    expect(classifyGetUpdatesFailure(401)).toContain("token");
  });

  test("falls back to the status for anything else", () => {
    expect(classifyGetUpdatesFailure(500)).toContain("500");
  });
});

/**
 * Media ingest (mt#3235).
 *
 * The originating defect: `parseInboundUpdates` read only `message.text`, so a
 * photo — whose text lives in `caption` — produced no message at all. The poll
 * cursor still advanced past it, so the update was unrecoverable and the
 * principal got silence. These cases pin each shape that used to vanish.
 */
describe("parseInboundUpdates — media", () => {
  function photoUpdate(extra: Record<string, unknown> = {}): unknown {
    return {
      ok: true,
      result: [
        {
          update_id: 20,
          message: {
            message_id: 9,
            chat: { id: Number(CHAT), type: "private" },
            from: { id: 777 },
            photo: [
              { file_id: "small-id", file_size: 1024 },
              { file_id: "large-id", file_size: 90000 },
            ],
            ...extra,
          },
        },
      ],
    };
  }

  test("a photo with no caption is a message, not a dropped update", () => {
    const [message] = parseInboundUpdates(photoUpdate());
    expect(message).toBeDefined();
    expect(message?.text).toBe("");
    expect(message?.attachments).toEqual([
      { fileId: "large-id", mediaType: "image/jpeg", fileName: undefined },
    ]);
  });

  test("picks the largest photo variant, not the first", () => {
    const [message] = parseInboundUpdates(photoUpdate());
    expect(message?.attachments[0]?.fileId).toBe("large-id");
  });

  test("a photo's caption becomes the message text", () => {
    const [message] = parseInboundUpdates(photoUpdate({ caption: "why does this render wrong?" }));
    expect(message?.text).toBe("why does this render wrong?");
    expect(message?.attachments).toHaveLength(1);
  });

  test("an image sent as a document is ingested with its own media type", () => {
    const [message] = parseInboundUpdates({
      ok: true,
      result: [
        {
          update_id: 21,
          message: {
            message_id: 10,
            chat: { id: Number(CHAT), type: "private" },
            document: { file_id: "doc-id", file_name: "shot.png", mime_type: "image/png" },
          },
        },
      ],
    });
    expect(message?.attachments).toEqual([
      { fileId: "doc-id", mediaType: "image/png", fileName: "shot.png" },
    ]);
    expect(message?.unsupportedMedia).toBeUndefined();
  });

  test("a non-image document is surfaced as unsupported rather than ingested", () => {
    const [message] = parseInboundUpdates({
      ok: true,
      result: [
        {
          update_id: 22,
          message: {
            message_id: 11,
            chat: { id: Number(CHAT), type: "private" },
            document: { file_id: "pdf-id", file_name: "spec.pdf", mime_type: "application/pdf" },
          },
        },
      ],
    });
    expect(message?.attachments).toEqual([]);
    expect(message?.unsupportedMedia).toContain("spec.pdf");
  });

  test("a voice note becomes a message so the channel can say it cannot read it", () => {
    const [message] = parseInboundUpdates({
      ok: true,
      result: [
        {
          update_id: 23,
          message: {
            message_id: 12,
            chat: { id: Number(CHAT), type: "private" },
            voice: { file_id: "voice-id", duration: 3 },
          },
        },
      ],
    });
    expect(message).toBeDefined();
    expect(message?.unsupportedMedia).toBe("a voice message");
    expect(message?.attachments).toEqual([]);
  });

  test("regression: a text-only message still parses with no media", () => {
    const [message] = parseInboundUpdates({
      ok: true,
      result: [
        {
          update_id: 24,
          message: {
            message_id: 13,
            chat: { id: Number(CHAT), type: "private" },
            text: "still plain text",
          },
        },
      ],
    });
    expect(message?.text).toBe("still plain text");
    expect(message?.attachments).toEqual([]);
    expect(message?.unsupportedMedia).toBeUndefined();
  });

  test("regression: an update carrying nothing actionable is still skipped", () => {
    expect(
      parseInboundUpdates({
        ok: true,
        result: [
          {
            update_id: 25,
            message: { message_id: 14, chat: { id: Number(CHAT), type: "private" } },
          },
        ],
      })
    ).toEqual([]);
  });

  test("regression: an empty update array parses to nothing", () => {
    expect(parseInboundUpdates({ ok: true, result: [] })).toEqual([]);
  });
});

describe("fetchTelegramFile", () => {
  const REF = { fileId: "large-id", mediaType: "image/png" as const, fileName: undefined };

  test("resolves the file path then downloads the bytes as base64", async () => {
    const urls: string[] = [];
    const result = await fetchTelegramFile({
      token: TOKEN,
      ref: REF,
      fetchFn: async (url) => {
        urls.push(String(url));
        if (String(url).includes("getFile")) {
          return jsonResponse({ ok: true, result: { file_path: "photos/a.jpg", file_size: 3 } });
        }
        return new Response(new Uint8Array([1, 2, 3]));
      },
    });

    // "AQID" is base64 for the bytes 0x01 0x02 0x03 — spelled out rather than
    // recomputed, so the test pins the encoding instead of restating it.
    expect(result).toEqual({ ok: true, base64: "AQID", mediaType: "image/png" });
    // The bytes live on a different path than the API methods — a single-call
    // implementation would silently fetch JSON metadata instead of an image.
    expect(urls[1]).toContain("/file/bot");
    expect(urls[1]).toContain("photos/a.jpg");
  });

  test("reports a getFile failure without leaking the token", async () => {
    const result = await fetchTelegramFile({
      token: TOKEN,
      ref: REF,
      fetchFn: async () => jsonResponse({ ok: false, description: "file is too big" }, 400),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.detail).toContain("400");
      expect(result.detail).not.toContain(TOKEN);
    }
  });

  test("refuses a file over the size limit before downloading it", async () => {
    let downloadAttempted = false;
    const result = await fetchTelegramFile({
      token: TOKEN,
      ref: REF,
      maxEncodedBytes: 10,
      fetchFn: async (url) => {
        if (String(url).includes("getFile")) {
          return jsonResponse({ ok: true, result: { file_path: "photos/big.jpg", file_size: 99 } });
        }
        downloadAttempted = true;
        return new Response(new Uint8Array(99));
      },
    });

    expect(result.ok).toBe(false);
    expect(downloadAttempted).toBe(false);
  });

  test("still refuses an oversized body when Telegram omitted file_size", async () => {
    const result = await fetchTelegramFile({
      token: TOKEN,
      ref: REF,
      maxEncodedBytes: 10,
      fetchFn: async (url) =>
        String(url).includes("getFile")
          ? jsonResponse({ ok: true, result: { file_path: "photos/big.jpg" } })
          : new Response(new Uint8Array(99)),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toContain("over the");
  });

  // PR #2483 R1: the API's ceiling is on the BASE64 payload, which is 4/3 the
  // raw size. A limit enforced on raw bytes admits files ~33% over the real
  // ceiling, which then fail downstream instead of here.
  test("the limit is measured on the encoded payload, not the raw bytes", async () => {
    // 74 raw bytes clears the derived raw guard (floor(99/4*3) = 74) but
    // encodes to 100 bytes, over the 99-byte encoded ceiling.
    const result = await fetchTelegramFile({
      token: TOKEN,
      ref: REF,
      maxEncodedBytes: 99,
      fetchFn: async (url) =>
        String(url).includes("getFile")
          ? jsonResponse({ ok: true, result: { file_path: "photos/edge.jpg" } })
          : new Response(new Uint8Array(74)),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toContain("base64-encoded");
  });

  test("the DEFAULT budget refuses a file whose encoded form would exceed 5 MB", async () => {
    // 4 MB raw encodes to ~5.33 MB — under a naive 5 MB raw cap, over the real
    // encoded ceiling. This is the case the previous implementation let through.
    const fourMegabytes = 4 * 1024 * 1024;
    const result = await fetchTelegramFile({
      token: TOKEN,
      ref: REF,
      fetchFn: async (url) =>
        String(url).includes("getFile")
          ? jsonResponse({
              ok: true,
              result: { file_path: "photos/4mb.jpg", file_size: fourMegabytes },
            })
          : new Response(new Uint8Array(fourMegabytes)),
    });

    expect(result.ok).toBe(false);
  });

  // PR #2483 R2: encoding is chunked because `String.fromCharCode(...bytes)`
  // spreads each byte as an argument. A realistic screenshot is ~1 MB, well
  // past any single-call argument ceiling, so this exercises the chunk seam
  // rather than trusting it — a stack overflow here would crash the daemon.
  test("encodes a megabyte-scale image correctly, not just a 3-byte one", async () => {
    const size = 1_000_000;
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i += 1) bytes[i] = i % 256;

    const result = await fetchTelegramFile({
      token: TOKEN,
      ref: REF,
      fetchFn: async (url) =>
        String(url).includes("getFile")
          ? jsonResponse({ ok: true, result: { file_path: "photos/big.png" } })
          : new Response(bytes),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Decode back and compare, so the assertion pins the CONTENT rather than
      // merely that some string came out.
      const decoded = Uint8Array.from(atob(result.base64), (c) => c.charCodeAt(0));
      expect(decoded.length).toBe(size);
      expect(decoded[0]).toBe(0);
      expect(decoded[size - 1]).toBe((size - 1) % 256);
      // A boundary interior to a chunk seam (0x2000 = 8192).
      expect(decoded[8192]).toBe(8192 % 256);
    }
  });

  test("a comfortably-sized image still succeeds under the default budget", async () => {
    // Guards against over-correcting the limit into rejecting normal photos.
    const result = await fetchTelegramFile({
      token: TOKEN,
      ref: REF,
      fetchFn: async (url) =>
        String(url).includes("getFile")
          ? jsonResponse({ ok: true, result: { file_path: "photos/ok.jpg", file_size: 900_000 } })
          : new Response(new Uint8Array(900_000)),
    });

    expect(result.ok).toBe(true);
  });
});

/**
 * Telegram topic-mode support (mt#3505, parent mt#3500).
 *
 * These cases carry the byte-identical regression the spec calls for: the
 * reviewer's alert sink and `notifyPrincipal` never pass `messageThreadId`, so
 * their wire payload must be unchanged.
 */
describe("parseInboundUpdates — topics (mt#3505)", () => {
  test("captures message_thread_id and is_topic_message on a topic message", () => {
    const messages = parseInboundUpdates({
      ok: true,
      result: [
        {
          update_id: 20,
          message: {
            message_id: 8,
            chat: { id: CHAT, type: "private" },
            from: { id: 777 },
            text: "hello from the topic",
            message_thread_id: 749667,
            is_topic_message: true,
          },
        },
      ],
    });

    expect(messages[0]?.messageThreadId).toBe(749667);
    expect(messages[0]?.isTopicMessage).toBe(true);
  });

  test("leaves messageThreadId undefined and isTopicMessage false on a non-topic message", () => {
    const messages = parseInboundUpdates({
      ok: true,
      result: [
        {
          update_id: 21,
          message: {
            message_id: 9,
            chat: { id: CHAT, type: "private" },
            from: { id: 777 },
            text: "hello, no topic",
          },
        },
      ],
    });

    expect(messages[0]?.messageThreadId).toBeUndefined();
    expect(messages[0]?.isTopicMessage).toBe(false);
  });
});

describe("editTelegramMessage (mt#3542)", () => {
  const BASE = { token: TOKEN, chatId: CHAT, messageId: 42, text: "updated" };

  test("reports success when the envelope says ok", async () => {
    const result = await editTelegramMessage({
      ...BASE,
      fetchFn: async () => jsonResponse({ ok: true, result: { message_id: 42 } }),
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.notModified).toBe(false);
  });

  test("accepts a bare `true` result, which is what an inline message returns", async () => {
    const result = await editTelegramMessage({
      ...BASE,
      fetchFn: async () => jsonResponse({ ok: true, result: true }),
    });

    expect(result.ok).toBe(true);
  });

  test("PR #2538 R1 — a 200 carrying `ok: false` is a FAILURE, not a success", async () => {
    // HTTP 2xx is not the Bot API's success signal; the envelope's `ok` flag
    // is. Trusting the status would report a failed edit as applied, and the
    // streaming caller would then advance its state and skip the fallback that
    // guarantees the reply is delivered at all.
    const result = await editTelegramMessage({
      ...BASE,
      fetchFn: async () =>
        jsonResponse({ ok: false, description: "Bad Request: something went wrong" }),
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.detail).toContain("something went wrong");
  });

  test("treats 'message is not modified' as success, however it is reported", async () => {
    // Streaming re-sends identical text whenever a turn pauses, so a no-op edit
    // is an expected steady state — not a delivery fault.
    for (const status of [200, 400]) {
      const result = await editTelegramMessage({
        ...BASE,
        fetchFn: async () =>
          jsonResponse({ ok: false, description: "Bad Request: message is not modified" }, status),
      });

      expect(result.ok).toBe(true);
      expect(result.ok && result.notModified).toBe(true);
    }
  });

  test("retries unstyled when the formatted attempt is rejected", async () => {
    const attempts: Array<Record<string, unknown>> = [];
    const result = await editTelegramMessage({
      ...BASE,
      text: "<b>bold</b>",
      parseMode: "HTML",
      plainFallback: "**bold**",
      fetchFn: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        attempts.push(body);
        return attempts.length === 1
          ? jsonResponse({ ok: false, description: "can't parse entities" }, 400)
          : jsonResponse({ ok: true, result: true });
      },
    });

    expect(result.ok && result.fellBackToPlain).toBe(true);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]?.["text"]).toBe("**bold**");
    // The retry drops parse_mode — resending it would fail the same way.
    expect(attempts[1]?.["parse_mode"]).toBeUndefined();
  });

  test("carries no thread parameter — a message is already in its topic", async () => {
    let sent: Record<string, unknown> = {};
    await editTelegramMessage({
      ...BASE,
      fetchFn: async (_url, init) => {
        sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({ ok: true, result: true });
      },
    });

    expect(THREAD_ID_KEY in sent).toBe(false);
    expect(sent["message_id"]).toBe(42);
  });

  test("a network error is reported, not thrown", async () => {
    const result = await editTelegramMessage({
      ...BASE,
      fetchFn: async () => {
        throw new Error("connection reset");
      },
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.detail).toContain("connection reset");
  });
});

describe("sendTelegramMessage — topics (mt#3505)", () => {
  test("forwards messageThreadId as message_thread_id", async () => {
    let sent: Record<string, unknown> = {};
    await sendTelegramMessage({
      token: TOKEN,
      chatId: CHAT,
      text: "hi",
      messageThreadId: 749667,
      fetchFn: async (_url, init) => {
        sent = JSON.parse(String(init?.body));
        return jsonResponse({ ok: true, result: { message_id: 1 } });
      },
    });
    expect(sent[THREAD_ID_KEY]).toBe(749667);
  });

  test("omits message_thread_id when not given", async () => {
    let sent: Record<string, unknown> = {};
    await sendTelegramMessage({
      token: TOKEN,
      chatId: CHAT,
      text: "hi",
      fetchFn: async (_url, init) => {
        sent = JSON.parse(String(init?.body));
        return jsonResponse({ ok: true, result: { message_id: 1 } });
      },
    });
    expect(THREAD_ID_KEY in sent).toBe(false);
  });

  // The regression the spec's own acceptance criteria call out by name: the
  // reviewer's TelegramAlertSink and notifyPrincipal never pass a thread id,
  // so their wire body must be byte-for-byte unchanged by this feature.
  test("regression: omitting messageThreadId reproduces today's wire payload byte-for-byte", async () => {
    let rawBody = "";
    await sendTelegramMessage({
      token: TOKEN,
      chatId: CHAT,
      text: SAMPLE_ALERT_TEXT,
      replyToMessageId: 12,
      fetchFn: async (_url, init) => {
        rawBody = String(init?.body);
        return jsonResponse({ ok: true, result: { message_id: 1 } });
      },
    });

    expect(rawBody).toBe(
      JSON.stringify({
        chat_id: CHAT,
        text: SAMPLE_ALERT_TEXT,
        disable_web_page_preview: true,
        reply_to_message_id: 12,
      })
    );
  });
});

/**
 * Silent sends (mt#3711).
 *
 * The reply stream edits ONE message in place because "separate message" was
 * read as inseparable from "notification". `disable_notification` is what
 * separates them, so a turn can render as successive chat messages while the
 * phone still buzzes once.
 *
 * These pin the WIRE CONTRACT only. Whether Telegram honours the field is a
 * property of Telegram, not of this code, and a stubbed fetch cannot observe
 * it — `scripts/principal-channel/verify-silent-send.ts` exists for that half
 * and its verdict is the operator's. What is testable here is that the field
 * reaches the wire on every path that can carry a message, including the two
 * RETRY paths, where losing it means the message the principal actually
 * receives is the one that buzzes.
 */
describe("sendTelegramMessage — silent sends (mt#3711)", () => {
  test("forwards disableNotification as disable_notification", async () => {
    let sent: Record<string, unknown> = {};
    await sendTelegramMessage({
      token: TOKEN,
      chatId: CHAT,
      text: "hi",
      disableNotification: true,
      fetchFn: async (_url, init) => {
        sent = JSON.parse(String(init?.body));
        return jsonResponse({ ok: true, result: { message_id: 1 } });
      },
    });
    expect(sent[DISABLE_NOTIFICATION_KEY]).toBe(true);
  });

  // An explicit `false` is not the same as omission, and a truthiness check
  // would collapse them. It survives because the transport tests
  // `=== undefined`; this pins that choice so a later `if (disableNotification)`
  // refactor fails here rather than in the chat.
  test("forwards an explicit false rather than dropping it", async () => {
    let sent: Record<string, unknown> = {};
    await sendTelegramMessage({
      token: TOKEN,
      chatId: CHAT,
      text: "hi",
      disableNotification: false,
      fetchFn: async (_url, init) => {
        sent = JSON.parse(String(init?.body));
        return jsonResponse({ ok: true, result: { message_id: 1 } });
      },
    });
    expect(sent[DISABLE_NOTIFICATION_KEY]).toBe(false);
  });

  test("omits disable_notification when not given", async () => {
    let sent: Record<string, unknown> = {};
    await sendTelegramMessage({
      token: TOKEN,
      chatId: CHAT,
      text: "hi",
      fetchFn: async (_url, init) => {
        sent = JSON.parse(String(init?.body));
        return jsonResponse({ ok: true, result: { message_id: 1 } });
      },
    });
    expect(DISABLE_NOTIFICATION_KEY in sent).toBe(false);
  });

  // The retry is the message that actually lands, so a silenced send whose
  // markup Telegram rejects would buzz — the failure mode is invisible in the
  // first request's body, which is why this asserts on the SECOND.
  test("the plain-text retry after a parse failure stays silent", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchFn: FetchFn = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if (body["parse_mode"] !== undefined) {
        return jsonResponse({ ok: false, description: CANT_PARSE_ENTITIES }, 400);
      }
      return jsonResponse({ ok: true, result: { message_id: 9 } });
    };

    const result = await sendTelegramMessage({
      token: TOKEN,
      chatId: CHAT,
      text: "<b>broken",
      parseMode: "HTML",
      plainFallback: "**broken",
      disableNotification: true,
      fetchFn,
    });

    expect(result.ok).toBe(true);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]?.[DISABLE_NOTIFICATION_KEY]).toBe(true);
  });

  // Same argument one layer up: the dead-topic fallback resends via a spread
  // of the original options, and a spread is exactly the shape a refactor
  // drops a field from without any type error.
  test("the dead-topic fallback send stays silent", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchFn: FetchFn = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if (body[THREAD_ID_KEY] !== undefined) {
        return jsonResponse(
          { ok: false, description: "Bad Request: message thread not found" },
          400
        );
      }
      return jsonResponse({ ok: true, result: { message_id: 7 } });
    };

    const result = await sendTelegramMessageWithThreadFallback({
      token: TOKEN,
      chatId: CHAT,
      text: "hi",
      messageThreadId: 749667,
      disableNotification: true,
      fetchFn,
    });

    expect(result.ok).toBe(true);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]?.[THREAD_ID_KEY]).toBeUndefined();
    expect(bodies[1]?.[DISABLE_NOTIFICATION_KEY]).toBe(true);
  });
});

/**
 * Drift reconciliation (mt#3507) — the exact HTTP 400 / description signal
 * measured live at mt#3500 Phase 0, and the fallback that keeps a
 * notification from being silently lost to a stale mapping.
 */
describe("isThreadNotFoundError (mt#3507)", () => {
  function failed(status: number, detail: string): ReturnType<typeof failedResult> {
    return failedResult(status, detail);
  }
  function failedResult(status: number, detail: string) {
    return { ok: false as const, status, detail };
  }

  test("matches the exact measured signal", () => {
    expect(
      isThreadNotFoundError(
        failed(400, 'HTTP 400: {"ok":false,"description":"Bad Request: message thread not found"}')
      )
    ).toBe(true);
  });

  test("does not match an unrelated 400 (e.g. bad markup)", () => {
    expect(
      isThreadNotFoundError(failed(400, "HTTP 400: can't parse entities: unexpected tag"))
    ).toBe(false);
  });

  test("does not match a non-400 status carrying similar text", () => {
    expect(isThreadNotFoundError(failed(403, "message thread not found"))).toBe(false);
  });

  test("does not match a successful result", () => {
    expect(isThreadNotFoundError({ ok: true, messageId: 1 })).toBe(false);
  });
});

describe("sendTelegramMessageWithThreadFallback (mt#3507)", () => {
  const THREAD_NOT_FOUND_BODY = JSON.stringify({
    ok: false,
    error_code: 400,
    description: "Bad Request: message thread not found",
  });

  test("a message with no messageThreadId is a single plain send — unaffected", async () => {
    let calls = 0;
    const result = await sendTelegramMessageWithThreadFallback({
      token: TOKEN,
      chatId: CHAT,
      text: "hi",
      fetchFn: async () => {
        calls += 1;
        return jsonResponse({ ok: true, result: { message_id: 1 } });
      },
    });
    expect(calls).toBe(1);
    expect(result).toEqual({ ok: true, messageId: 1 });
  });

  test("regression: omitting messageThreadId reproduces today's wire payload byte-for-byte", async () => {
    // The exact regression the spec calls for: a notify/reply with no topic
    // in play must produce an unchanged request body.
    let rawBody = "";
    await sendTelegramMessageWithThreadFallback({
      token: TOKEN,
      chatId: CHAT,
      text: SAMPLE_ALERT_TEXT,
      replyToMessageId: 12,
      fetchFn: async (_url, init) => {
        rawBody = String(init?.body);
        return jsonResponse({ ok: true, result: { message_id: 1 } });
      },
    });
    expect(rawBody).toBe(
      JSON.stringify({
        chat_id: CHAT,
        text: SAMPLE_ALERT_TEXT,
        disable_web_page_preview: true,
        reply_to_message_id: 12,
      })
    );
  });

  test("on the measured thread-not-found signal, falls back to the standing conversation with a note", async () => {
    const sentBodies: Record<string, unknown>[] = [];
    const result = await sendTelegramMessageWithThreadFallback({
      token: TOKEN,
      chatId: CHAT,
      text: "your PR is up",
      messageThreadId: 749667,
      fetchFn: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        sentBodies.push(body);
        if (body[THREAD_ID_KEY] !== undefined) {
          return new Response(THREAD_NOT_FOUND_BODY, { status: 400 });
        }
        return jsonResponse({ ok: true, result: { message_id: 99 } });
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fellBackFromDeadTopic).toBe(true);
    // Two attempts: the doomed topic send, then the standing-conversation retry.
    expect(sentBodies).toHaveLength(2);
    expect(sentBodies[0]?.[THREAD_ID_KEY]).toBe(749667);
    expect(THREAD_ID_KEY in (sentBodies[1] ?? {})).toBe(false);
    expect(String(sentBodies[1]?.["text"])).toContain("your PR is up");
    expect(String(sentBodies[1]?.["text"])).toContain("could not be found");
  });

  test("calls onThreadNotFound with the dead thread id before the fallback send", async () => {
    const notified: number[] = [];
    await sendTelegramMessageWithThreadFallback({
      token: TOKEN,
      chatId: CHAT,
      text: "hi",
      messageThreadId: 500,
      onThreadNotFound: (threadId) => {
        notified.push(threadId);
      },
      fetchFn: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        if (body[THREAD_ID_KEY] !== undefined) {
          return new Response(THREAD_NOT_FOUND_BODY, { status: 400 });
        }
        return jsonResponse({ ok: true, result: { message_id: 1 } });
      },
    });
    expect(notified).toEqual([500]);
  });

  test("an unrelated 400 (bad markup) does NOT trigger the thread fallback", async () => {
    // Distinguishing the two 400s is the whole point of matching on the
    // description, not just the status — a markup rejection must keep going
    // through the EXISTING plain-text retry (plainFallback), not this one.
    let calls = 0;
    const result = await sendTelegramMessageWithThreadFallback({
      token: TOKEN,
      chatId: CHAT,
      text: "<b>bold</b>",
      parseMode: "HTML",
      plainFallback: "bold",
      messageThreadId: 749667,
      fetchFn: async (_url, init) => {
        calls += 1;
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        if (body["parse_mode"] !== undefined) {
          return new Response(JSON.stringify({ ok: false, description: CANT_PARSE_ENTITIES }), {
            status: 400,
          });
        }
        return jsonResponse({ ok: true, result: { message_id: 2 } });
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fellBackFromDeadTopic).toBeUndefined();
    expect(result.fellBackToPlain).toBe(true);
    // The markup retry (still threaded) plus the pre-existing formatted
    // attempt — no third, thread-fallback call.
    expect(calls).toBe(2);
  });

  test("a genuinely dead thread that ALSO never recovers is surfaced, not silently dropped", async () => {
    // "A notification must never be lost to a stale mapping" — if even the
    // fallback send fails, the caller must see a failure, not a swallowed one.
    const result = await sendTelegramMessageWithThreadFallback({
      token: TOKEN,
      chatId: CHAT,
      text: "hi",
      messageThreadId: 749667,
      fetchFn: async () => new Response("service unavailable", { status: 503 }),
    });
    // The FIRST attempt with a thread id gets a 503, not the 400 signal —
    // so this never even reaches the fallback branch, and the caller sees
    // the real failure directly.
    expect(result.ok).toBe(false);
  });
});

describe("getTelegramMe (mt#3505)", () => {
  test("reports has_topics_enabled and allows_users_to_create_topics on success", async () => {
    const result = await getTelegramMe({
      token: TOKEN,
      fetchFn: async () =>
        jsonResponse({
          ok: true,
          result: {
            id: 8913559862,
            username: "edobry_minsky_bot",
            has_topics_enabled: true,
            allows_users_to_create_topics: true,
          },
        }),
    });

    expect(result).toEqual({
      ok: true,
      hasTopicsEnabled: true,
      allowsUsersToCreateTopics: true,
    });
  });

  test("reports both flags false when Telegram returns them false", () => {
    return getTelegramMe({
      token: TOKEN,
      fetchFn: async () =>
        jsonResponse({
          ok: true,
          result: { id: 1, username: "bot", has_topics_enabled: false },
        }),
    }).then((result) => {
      expect(result).toEqual({
        ok: true,
        hasTopicsEnabled: false,
        allowsUsersToCreateTopics: false,
      });
    });
  });

  test("redacts the token out of a failure detail", async () => {
    const result = await getTelegramMe({
      token: TOKEN,
      fetchFn: async () =>
        new Response(`{"ok":false,"description":"unauthorized ${TOKEN}"}`, { status: 401 }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).not.toContain(TOKEN);
    expect(result.status).toBe(401);
  });

  test("reports a network error without throwing", async () => {
    const result = await getTelegramMe({
      token: TOKEN,
      fetchFn: async () => {
        throw new Error("connect refused");
      },
    });
    expect(result.ok).toBe(false);
  });
});
