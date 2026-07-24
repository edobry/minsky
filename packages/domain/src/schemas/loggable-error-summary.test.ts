/**
 * Tests for the bounded error-logging helpers (mt#2903).
 *
 * The bug these exist to prevent: `DrizzleQueryError.message` is built as
 * `Failed query: <sql>\nparams: <params>` — the bound params are INSIDE the
 * message. For the `agent_transcripts` upsert those params are an entire
 * ingested transcript, so a single failed insert logged a multi-megabyte line;
 * retried every sweep tick, that grew `~/.local/state/minsky/logs/` to 4.7 GB.
 *
 * The subtle part these tests pin: the useful diagnostic (the real Postgres
 * error) lives on `.cause`, AFTER the giant wrapper message. Truncating the
 * JOINED string would discard exactly the part worth keeping — so each cause
 * level must be bounded independently.
 */
import { describe, test, expect } from "bun:test";
import { truncateForLog, getLoggableErrorSummary, MAX_LOGGED_ERROR_CHARS } from "./error";

/** A DrizzleQueryError-shaped error: huge message, real cause underneath. */
function makeDrizzleLikeError(paramsSize: number): Error {
  const params = "x".repeat(paramsSize);
  const err = new Error(
    `Failed query: insert into "agent_transcripts" ("agent_session_id", "transcript") values ($1, $2)\nparams: ${params}`
  );
  (err as Error & { cause?: unknown }).cause = new Error(
    'invalid input syntax for type bigint: "not-a-number"'
  );
  return err;
}

describe("truncateForLog", () => {
  test("leaves short text untouched", () => {
    expect(truncateForLog("short message")).toBe("short message");
  });

  test("truncates past the cap and reports the ORIGINAL length", () => {
    const out = truncateForLog("y".repeat(5000), 100);
    expect(out.length).toBeLessThan(200);
    // The original size is itself diagnostic — an unexpectedly enormous
    // message is the signal that something is dumping a payload.
    expect(out).toContain("5000 chars total");
  });

  test("respects an explicit cap", () => {
    expect(truncateForLog("z".repeat(100), 10).startsWith("z".repeat(10))).toBe(true);
  });

  test("does not truncate at exactly the cap", () => {
    const exact = "a".repeat(50);
    expect(truncateForLog(exact, 50)).toBe(exact);
  });
});

describe("truncateForLog — surrogate safety", () => {
  /**
   * Transcripts routinely contain emoji, so the truncation boundary can land
   * between the halves of a UTF-16 surrogate pair. A raw `.slice()` would emit a
   * lone surrogate and corrupt the log line's encoding.
   */
  test("never emits a lone surrogate when cutting mid-emoji", () => {
    // "😀" is a surrogate pair, so each emoji is 2 UTF-16 code units. An odd
    // cap therefore lands mid-pair.
    const emoji = "😀".repeat(100);
    const out = truncateForLog(emoji, 51);

    for (const ch of out) {
      const code = ch.charCodeAt(0);
      const isLoneHigh = code >= 0xd800 && code <= 0xdbff && ch.length === 1;
      const isLoneLow = code >= 0xdc00 && code <= 0xdfff;
      expect(isLoneHigh || isLoneLow).toBe(false);
    }
  });

  test("still truncates when the cut lands mid-pair", () => {
    const out = truncateForLog("😀".repeat(100), 51);
    expect(out).toContain("truncated");
    expect(out.length).toBeLessThan(120);
  });

  test("leaves emoji intact below the cap", () => {
    const emoji = "😀😀😀";
    expect(truncateForLog(emoji, 100)).toBe(emoji);
  });
});

describe("getLoggableErrorSummary — the 4.7GB regression", () => {
  /**
   * The core guarantee: a ~6 MB drizzle message must not reach a log field.
   * Sized to match a real observed line (5.87 MB).
   */
  test("bounds a multi-megabyte drizzle-style message", () => {
    const err = makeDrizzleLikeError(6_000_000);
    expect(err.message.length).toBeGreaterThan(5_000_000);

    const summary = getLoggableErrorSummary(err);

    // Two levels, each capped, plus the joiner and truncation notices.
    expect(summary.length).toBeLessThan(MAX_LOGGED_ERROR_CHARS * 2 + 500);
  });

  /**
   * The reason per-level truncation is required: the Postgres cause comes
   * AFTER the giant message. A naive truncate of the joined string would
   * drop it — losing the only field that explains the failure.
   */
  test("preserves the underlying cause even when the wrapper message is huge", () => {
    const summary = getLoggableErrorSummary(makeDrizzleLikeError(6_000_000));
    expect(summary).toContain("invalid input syntax for type bigint");
  });

  test("does not leak the bound params", () => {
    // 200k 'x' params: the summary must not carry them through.
    const summary = getLoggableErrorSummary(makeDrizzleLikeError(200_000));
    expect(summary).not.toContain("x".repeat(3000));
  });

  test("still shows the head of the failing query for diagnosis", () => {
    const summary = getLoggableErrorSummary(makeDrizzleLikeError(6_000_000));
    expect(summary).toContain('insert into "agent_transcripts"');
  });

  test("marks that truncation happened", () => {
    expect(getLoggableErrorSummary(makeDrizzleLikeError(6_000_000))).toContain("truncated");
  });
});

describe("getLoggableErrorSummary — ordinary errors", () => {
  test("passes a small error through unchanged", () => {
    expect(getLoggableErrorSummary(new Error("connection refused"))).toBe("connection refused");
  });

  test("joins a cause chain", () => {
    const inner = new Error("ECONNRESET");
    const outer = new Error("query failed");
    (outer as Error & { cause?: unknown }).cause = inner;
    expect(getLoggableErrorSummary(outer)).toBe("query failed — caused by: ECONNRESET");
  });

  test("handles non-Error values", () => {
    expect(getLoggableErrorSummary("plain string")).toBe("plain string");
    expect(getLoggableErrorSummary(undefined)).toBe("undefined");
    expect(getLoggableErrorSummary(null)).toBe("null");
  });

  test("terminates on a cyclic cause chain", () => {
    const a = new Error("a");
    const b = new Error("b");
    (a as Error & { cause?: unknown }).cause = b;
    (b as Error & { cause?: unknown }).cause = a;
    const summary = getLoggableErrorSummary(a);
    expect(summary).toContain("a");
    expect(summary).toContain("b");
    expect(summary.length).toBeLessThan(1000);
  });
});
