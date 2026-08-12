/**
 * Recovery of judged input for `retrospective-trigger` records (mt#3821).
 *
 * The lines come from an injected resolver, not from `~/.claude` — a test that
 * had to write into the operator's real transcript root to exercise this would
 * be testing the filesystem, and could not run twice.
 */

import { describe, expect, test } from "bun:test";
import { hashJudgedText } from "../.minsky/hooks/judged-input-capture";
import { elideQuotedAndCodeContexts } from "../.minsky/hooks/elision";
import type { TranscriptLine } from "../.minsky/hooks/transcript";
import { recover, turnCandidates } from "./replay-retrospective-trigger-calibration";

const prompt = (text: string, timestamp: string): TranscriptLine => ({
  type: "user",
  message: { role: "user", content: text },
  timestamp,
});

const assistant = (text: string, timestamp: string): TranscriptLine => ({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "text", text }] },
  timestamp,
});

/**
 * The shape that broke the first implementation: the prompt at 12:00:05 is
 * `isMeta`, so a later reader does not see a turn boundary there and reads one
 * merged turn ending at 12:00:06 — past the record it needs to explain.
 */
const JUDGED_MESSAGE = "Checked both. The junk call holds up.";

const MERGED_TURN: TranscriptLine[] = [
  prompt("do the thing", "2026-08-12T12:00:00.000Z"),
  assistant(JUDGED_MESSAGE, "2026-08-12T12:00:02.000Z"),
  { ...prompt("continue", "2026-08-12T12:00:05.000Z"), isMeta: true },
  assistant("The flagged phrase is a false positive.", "2026-08-12T12:00:06.000Z"),
];

describe("turnCandidates", () => {
  test("emits the prefix at each assistant line, not just the whole turn", () => {
    const candidates = turnCandidates(MERGED_TURN);
    expect(candidates).toHaveLength(2);
    expect(candidates[0]?.text).toBe(elideQuotedAndCodeContexts(JUDGED_MESSAGE));
    expect(candidates[0]?.endsAt).toBe("2026-08-12T12:00:02.000Z");
    expect(candidates[1]?.text).toContain("false positive");
  });

  test("deduplicates a single-message turn against its own prefix", () => {
    const candidates = turnCandidates([
      prompt("go", "2026-08-12T12:00:00.000Z"),
      assistant("one message only", "2026-08-12T12:00:01.000Z"),
    ]);
    expect(candidates).toHaveLength(1);
  });
});

describe("recover", () => {
  const resolveLines = () => MERGED_TURN;
  const judged = elideQuotedAndCodeContexts(JUDGED_MESSAGE);

  test("a recorded hash selects the exact judged prefix", () => {
    const result = recover(
      {
        timestamp: "2026-08-12T12:00:04.000Z",
        session_id: "s1",
        captureSchema: 1,
        judged_text_hash: hashJudgedText(judged),
      },
      { resolveLines }
    );

    expect(result.verdict).toBe("recovered-verified");
    expect(result.judgedText).toBe(judged);
  });

  test("a hash matching nothing reports mismatch rather than the nearest turn", () => {
    const result = recover(
      {
        timestamp: "2026-08-12T12:00:04.000Z",
        session_id: "s1",
        captureSchema: 1,
        judged_text_hash: "ffffffffffffffff",
      },
      { resolveLines }
    );

    expect(result.verdict).toBe("hash-mismatch");
    expect(result.judgedText).toBeUndefined();
  });

  test("a hashless record is corroborated by its own matched phrase", () => {
    const result = recover(
      {
        timestamp: "2026-08-12T12:00:04.000Z",
        session_id: "s1",
        matches: [{ family: "R1", phrase: "Checked both." }],
      },
      { resolveLines }
    );

    expect(result.verdict).toBe("recovered-corroborated");
    expect(result.corroboratedBy).toBe("matched_phrase");
    expect(result.judgedText).toContain("Checked both.");
  });

  test("a hashless record with nothing to corroborate falls back to proximity", () => {
    const result = recover(
      { timestamp: "2026-08-12T12:00:04.000Z", session_id: "s1" },
      { resolveLines }
    );

    expect(result.verdict).toBe("recovered-unverified");
    expect(result.judgedText).toBe(judged);
  });

  test("a missing transcript is unreplayable, never a pass", () => {
    const result = recover(
      { timestamp: "2026-08-12T12:00:04.000Z", session_id: "gone" },
      { resolveLines: () => null }
    );

    expect(result.verdict).toBe("unreplayable");
    expect(result.reason).toContain("no transcript file");
  });

  test("a record with no session id is unreplayable", () => {
    const result = recover({ timestamp: "2026-08-12T12:00:04.000Z" }, { resolveLines });
    expect(result.verdict).toBe("unreplayable");
  });
});
