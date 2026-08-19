/**
 * Tests for correction counting across BOTH stored transcript shapes (mt#4225).
 *
 * `countCorrections` has two callers with different inputs, and the distinction is the whole
 * point of the fix:
 *
 * - `ingestTranscript` passes freshly-parsed JSONL lines, which carry flat `content`.
 * - `computeMessageStats` passes stored rows, which carry nested `message.content`.
 *
 * It read `msg.content` for both, so the stored path counted 0 corrections for every transcript
 * regardless of what the operator actually said.
 *
 * These exercise `computeMessageStats` itself — the method the success criterion names — rather
 * than the private helper beneath it. The seam is `getTranscript`, a public method the class
 * already exposes and the production caller already goes through: overriding it in a subclass
 * supplies the stored rows without stubbing a drizzle query chain, which would couple the test to
 * the shape of a query this task does not touch. (PR #3129 R1: an earlier version reached
 * `countCorrections` through a `__TEST_ONLY` export and tested one level below the criterion.)
 */

import { describe, test, expect } from "bun:test";
import { AgentTranscriptService } from "./transcript-service";
import type { TranscriptMessage } from "./transcript-service";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { AgentSessionId } from "../transcripts/transcript-source";

/** The live stored shape: raw harness JSONL, text nested under `message`. */
function storedMessage(type: "user" | "assistant", content: unknown): TranscriptMessage {
  return { type, role: type, content: undefined, message: { role: type, content } };
}

/** The legacy / freshly-parsed shape: text flattened onto the message. */
function legacyMessage(type: "user" | "assistant", content: unknown): TranscriptMessage {
  return { type, role: type, content };
}

/**
 * A correction counts only for a user message FOLLOWING an assistant message, so every fixture
 * needs that pairing — a bare user message would count zero for reasons unrelated to resolution.
 */
function conversation(
  make: (type: "user" | "assistant", content: unknown) => TranscriptMessage,
  userReply: unknown
): TranscriptMessage[] {
  return [make("assistant", "I used a Redis queue."), make("user", userReply)];
}

/**
 * The real service with its one DB read replaced.
 *
 * `computeMessageStats` reaches the database ONLY through `getTranscript` (verified against the
 * implementation), so everything under test here — the stats arithmetic and the correction
 * counting — is the production code path. The `db` handle is never touched.
 */
class StubbedTranscriptService extends AgentTranscriptService {
  /** The id `computeMessageStats` actually threaded through, for the pass-through assertion. */
  receivedSessionId: AgentSessionId | null = null;

  constructor(private readonly fixture: TranscriptMessage[] | null) {
    super({} as PostgresJsDatabase);
  }

  // Takes the parameter rather than ignoring it (PR #3129 R2). Dropping it would make the stub
  // accept any id silently — and passing the WRONG id space to this exact method is not a
  // hypothetical: it is mt#3066, where a Minsky workspace id was looked up against the
  // conversation keyspace and every call returned null.
  override async getTranscript(sessionId: AgentSessionId): Promise<TranscriptMessage[] | null> {
    this.receivedSessionId = sessionId;
    return this.fixture;
  }
}

const SESSION = "conversation-under-test" as AgentSessionId;

/** The one correction phrase every positive case uses, so they cannot drift apart. */
const CORRECTION_REPLY = "no, use Postgres instead";

function statsFor(messages: TranscriptMessage[] | null) {
  return new StubbedTranscriptService(messages).computeMessageStats(SESSION);
}

describe("computeMessageStats resolves both transcript shapes (mt#4225)", () => {
  test("counts a correction in a STORED-shape transcript", async () => {
    // The path that returned 0 for every stored transcript before this fix.
    const stats = await statsFor(conversation(storedMessage, CORRECTION_REPLY));
    expect(stats?.corrections).toBe(1);
  });

  test("counts a correction in a LEGACY flat-shape transcript, unchanged", async () => {
    // `ingestTranscript`'s shape — must not regress while fixing the stored one.
    const stats = await statsFor(conversation(legacyMessage, CORRECTION_REPLY));
    expect(stats?.corrections).toBe(1);
  });

  test("counts nothing when the user message carries no correction signal", async () => {
    // Guards against a fix that counts every user message and looks like success.
    const stats = await statsFor(conversation(storedMessage, "sounds good, thanks"));
    expect(stats?.corrections).toBe(0);
  });

  test("counts a correction in a stored-shape block array", async () => {
    const stats = await statsFor([
      storedMessage("assistant", [{ type: "text", text: "I used a Redis queue." }]),
      storedMessage("user", [
        { type: "text", text: "actually" },
        { type: "tool_result", content: "irrelevant" },
        { type: "text", text: "use Postgres" },
      ]),
    ]);
    expect(stats?.corrections).toBe(1);
  });

  test("counts nothing when neither shape carries content", async () => {
    // The pre-fix reading of a stored row: no text, so no signal — correctly zero, and
    // indistinguishable from a clean session, which is why the count alone never surfaced this.
    const stats = await statsFor(conversation(legacyMessage, undefined));
    expect(stats?.corrections).toBe(0);
  });

  test("still reports the surrounding message counts", async () => {
    // The criterion is about `corrections`, but a resolution change must not disturb the rest of
    // the record the method returns.
    const stats = await statsFor(conversation(storedMessage, CORRECTION_REPLY));
    expect(stats?.totalMessages).toBe(2);
    expect(stats?.humanMessages).toBe(1);
    expect(stats?.assistantMessages).toBe(1);
  });

  test("returns null when no transcript is stored", async () => {
    expect(await statsFor(null)).toBeNull();
  });

  test("threads the session id through to the transcript lookup unchanged", async () => {
    // mt#3066 was exactly this going wrong on this method — a workspace id looked up against the
    // conversation keyspace, which returns null and is indistinguishable from an absent transcript.
    const service = new StubbedTranscriptService(conversation(storedMessage, CORRECTION_REPLY));
    await service.computeMessageStats(SESSION);
    expect(service.receivedSessionId).toBe(SESSION);
  });
});
