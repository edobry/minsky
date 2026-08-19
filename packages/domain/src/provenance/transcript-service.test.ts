/**
 * Tests for correction counting across BOTH stored transcript shapes (mt#4225).
 *
 * `countCorrections` has two callers with different inputs, and the distinction is the whole
 * point of the fix:
 *
 * - `ingestTranscript` passes freshly-parsed JSONL lines, which carry flat `content`.
 * - `computeMessageStats` passes stored rows, which carry nested `message.content`.
 *
 * It read `msg.content` for both, so the stored path counted 0 corrections for every
 * transcript regardless of what the operator actually said. These tests pin both directions —
 * a fix that repaired the stored path by breaking the ingest path would pass a one-sided test.
 */

import { describe, test, expect } from "bun:test";
import { __TEST_ONLY } from "./transcript-service";
import type { TranscriptMessage } from "./transcript-service";

const { countCorrections } = __TEST_ONLY;

/** The live stored shape: raw harness JSONL, text nested under `message`. */
function storedMessage(type: "user" | "assistant", content: unknown): TranscriptMessage {
  return { type, role: type, content: undefined, message: { role: type, content } };
}

/** The legacy / freshly-parsed shape: text flattened onto the message. */
function legacyMessage(type: "user" | "assistant", content: unknown): TranscriptMessage {
  return { type, role: type, content };
}

/**
 * A correction is counted only for a user message FOLLOWING an assistant message, so every
 * fixture below needs that pairing — a bare user message would count zero for reasons that
 * have nothing to do with content resolution.
 */
function conversation(
  make: (type: "user" | "assistant", content: unknown) => TranscriptMessage,
  userReply: string
): TranscriptMessage[] {
  return [make("assistant", "I used a Redis queue."), make("user", userReply)];
}

describe("countCorrections resolves both transcript shapes (mt#4225)", () => {
  test("counts a correction in a STORED-shape transcript", () => {
    // The path that returned 0 for every stored transcript before this fix.
    expect(countCorrections(conversation(storedMessage, "no, use Postgres instead"))).toBe(1);
  });

  test("counts a correction in a LEGACY flat-shape transcript, unchanged", () => {
    // `ingestTranscript`'s path — must not regress while fixing the stored one.
    expect(countCorrections(conversation(legacyMessage, "no, use Postgres instead"))).toBe(1);
  });

  test("counts nothing when the user message carries no correction signal", () => {
    // Guards against a fix that counts every user message and looks like success.
    expect(countCorrections(conversation(storedMessage, "sounds good, thanks"))).toBe(0);
  });

  test("counts a correction in a stored-shape block array", () => {
    const messages = [
      storedMessage("assistant", [{ type: "text", text: "I used a Redis queue." }]),
      storedMessage("user", [
        { type: "text", text: "actually" },
        { type: "tool_result", content: "irrelevant" },
        { type: "text", text: "use Postgres" },
      ]),
    ];
    expect(countCorrections(messages)).toBe(1);
  });

  test("counts nothing when neither shape carries content", () => {
    // The pre-fix reading of a stored row: no text, so no signal — correctly zero, and
    // indistinguishable from a clean session, which is why the count alone never surfaced this.
    expect(countCorrections(conversation(legacyMessage, undefined as unknown as string))).toBe(0);
  });
});
