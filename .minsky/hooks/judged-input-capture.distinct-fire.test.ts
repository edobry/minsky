/**
 * mt#3866 AT1 — the distinct-fire identifier, at the write side.
 *
 * The criterion: *"Two records produced from the same judged text carry the same
 * text identifier; two records from different text do not."*
 *
 * These exercise `captureFields` rather than `hashJudgedText` directly, because
 * the defect this task fixes was not a missing hash function — that shipped with
 * mt#3607 — but a writer able to stamp the CAPTURE MARKER without any identity.
 * So the property worth pinning is the COUPLING: you cannot get the marker out
 * of this helper without the digest coming with it.
 */
import { describe, test, expect } from "bun:test";

import {
  CAPTURE_SCHEMA_FIELD,
  CAPTURE_SCHEMA_VERSION,
  JUDGED_TEXT_HASH_FIELD,
  captureFields,
  getJudgedTextHash,
  hashJudgedText,
} from "./judged-input-capture";

describe("mt#3866 AT1 — same text yields the same identifier", () => {
  test("two records from the same judged text carry the same digest", () => {
    const text = "**Your call:** whether to accept the cadence or build stall detection.";
    const first = captureFields(text);
    const second = captureFields(text);

    expect(getJudgedTextHash(first)).toBeDefined();
    expect(getJudgedTextHash(second)).toBe(getJudgedTextHash(first) as string);
  });

  test("two records from DIFFERENT text do not", () => {
    // Differ by one character, to pin that the digest is over the text rather
    // than something coarser (a length, a first sentence) that would collide.
    const a = captureFields("re-attempting it unprompted is your call.");
    const b = captureFields("re-attempting it unprompted is your calls.");

    expect(getJudgedTextHash(a)).not.toBe(getJudgedTextHash(b) as string);
  });

  test("the digest is `hashJudgedText`'s value, not a second convention", () => {
    const text = "needs your call on what the Workspace panel should say.";
    expect(captureFields(text)[JUDGED_TEXT_HASH_FIELD]).toBe(hashJudgedText(text));
  });
});

describe("mt#3866 — the marker and the identity are inseparable", () => {
  test("captureFields stamps BOTH, which is the whole point of the helper", () => {
    const fields = captureFields("some judged text");

    // The failure this replaces: a writer stamping the marker alone. All 58
    // records in the measured `ask-routing-deferral` window looked like the
    // marker half of this assertion and nothing else.
    expect(fields[CAPTURE_SCHEMA_FIELD]).toBe(CAPTURE_SCHEMA_VERSION);
    expect(typeof fields[JUDGED_TEXT_HASH_FIELD]).toBe("string");
  });

  test("empty judged text still yields a digest, so a writer cannot opt out by passing nothing", () => {
    // A degenerate input is a real case — `extractAssistantText` returns "" for
    // a turn with no assistant prose — and returning `undefined` there would
    // reintroduce un-groupable records through the back door.
    const fields = captureFields("");
    expect(getJudgedTextHash(fields)).toBe(hashJudgedText(""));
  });
});

describe("mt#3866 AT4 — absence reads as UN-GROUPABLE, never as distinct", () => {
  test("a pre-mt#3866 record shape yields undefined rather than a fabricated id", () => {
    // The exact top-level key set measured on the live log before this change.
    const legacyRecord: Record<string, unknown> = {
      timestamp: "2026-09-04T16:57:19.553Z",
      session_id: "abc",
      injection_enabled: true,
      [CAPTURE_SCHEMA_FIELD]: CAPTURE_SCHEMA_VERSION,
      matches: [],
      suppressionReasons: [],
    };

    expect(getJudgedTextHash(legacyRecord)).toBeUndefined();
  });

  test("a present-but-empty digest is also undefined, not a grouping key", () => {
    // An empty string would otherwise group every such record together — a
    // silent under-count, which is the opposite error from the one this task
    // fixes and just as unfounded.
    expect(getJudgedTextHash({ [JUDGED_TEXT_HASH_FIELD]: "" })).toBeUndefined();
    expect(getJudgedTextHash({ [JUDGED_TEXT_HASH_FIELD]: 42 })).toBeUndefined();
  });
});
