/**
 * Tests for the Telegram Bot API transport (mt#3228).
 *
 * The redaction cases are the load-bearing ones: the bot token rides in the
 * URL path, so a leak into a returned string becomes a leak into logs and the
 * transcript DB.
 */

import { describe, expect, test } from "bun:test";
import {
  classifyGetUpdatesFailure,
  fetchTelegramFile,
  getTelegramUpdates,
  highestUpdateIdOf,
  parseInboundUpdates,
  redactSecret,
  sendTelegramMessage,
  sendTelegramTypingAction,
} from "./telegram-transport";

const TOKEN = "123456:FAKE-TOKEN-VALUE";
const CHAT = "42";

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
      maxBytes: 10,
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
      maxBytes: 10,
      fetchFn: async (url) =>
        String(url).includes("getFile")
          ? jsonResponse({ ok: true, result: { file_path: "photos/big.jpg" } })
          : new Response(new Uint8Array(99)),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toContain("over the");
  });
});
