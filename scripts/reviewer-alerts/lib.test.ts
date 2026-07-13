/**
 * Tests for the reviewer-alerts pure helpers (mt#2419). Hermetic — no
 * subprocesses, no network.
 */

import { describe, test, expect } from "bun:test";
import { extractChats, redactSecret, classifyGetUpdatesFailure } from "./lib";

describe("extractChats (mt#2419)", () => {
  test("extracts a private chat with username label", () => {
    const body = {
      ok: true,
      result: [
        { update_id: 1, message: { chat: { id: 12345, type: "private", username: "eugene" } } },
      ],
    };
    expect(extractChats(body)).toEqual([{ chatId: "12345", type: "private", label: "eugene" }]);
  });

  test("dedupes repeated chats and tolerates non-message updates", () => {
    const body = {
      ok: true,
      result: [
        { update_id: 1, message: { chat: { id: 7, type: "private", first_name: "E" } } },
        { update_id: 2, message: { chat: { id: 7, type: "private", first_name: "E" } } },
        { update_id: 3, edited_message: { chat: { id: 9 } } }, // no `message` — skipped
        { update_id: 4 },
      ],
    };
    const chats = extractChats(body);
    expect(chats).toHaveLength(1);
    expect(chats[0]?.chatId).toBe("7");
    expect(chats[0]?.label).toBe("E");
  });

  test("empty result → empty list (the 'message your bot first' case)", () => {
    expect(extractChats({ ok: true, result: [] })).toEqual([]);
    expect(extractChats({})).toEqual([]);
    expect(extractChats(null)).toEqual([]);
  });

  test("negative (group) ids survive as strings", () => {
    const body = {
      result: [{ message: { chat: { id: -100123, type: "supergroup", title: "ops" } } }],
    };
    expect(extractChats(body)[0]).toEqual({ chatId: "-100123", type: "supergroup", label: "ops" });
  });
});

describe("redactSecret (mt#2419)", () => {
  test("redacts every occurrence, including inside URLs", () => {
    const tok = "123:ABC-def";
    const input = `fetch failed for https://api.telegram.org/bot${tok}/getUpdates (token ${tok})`;
    const out = redactSecret(tok, input);
    expect(out).not.toContain(tok);
    expect(out).toContain("***REDACTED***");
  });

  test("empty secret is a no-op (no infinite split)", () => {
    expect(redactSecret("", "hello")).toBe("hello");
  });
});

describe("classifyGetUpdatesFailure (mt#2419)", () => {
  test("401 → bad-token guidance", () => {
    expect(classifyGetUpdatesFailure(401)).toContain("401");
  });
  test("409 → webhook-set guidance (verified Telegram constraint)", () => {
    expect(classifyGetUpdatesFailure(409)).toContain("webhook");
  });
  test("other → generic with description", () => {
    expect(classifyGetUpdatesFailure(500, "boom")).toContain("boom");
  });
});
