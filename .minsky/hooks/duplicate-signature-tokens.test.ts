// Tests for the duplicate-signature functional core (mt#3722).
//
// The fixtures are VERBATIM excerpts from the two real specs in the originating
// incident (R4 in mem#819) — mt#3719, the duplicate that was filed, and
// mt#3575, the task it duplicated. Synthetic fixtures would have let the token
// rules be shaped to whatever they needed to match; these cannot, because the
// prose was written before the rules existed.

import { describe, test, expect } from "bun:test";
import {
  extractSignatureTokens,
  parseDuplicateCheckRecord,
  concedesOverlap,
  MAX_TOKENS,
  MIN_TOKEN_LENGTH,
  type Reconciliation,
} from "./duplicate-signature-tokens";

/**
 * The verdict under test throughout this file — the one that ASSERTS no overlap
 * and is therefore the one a token match contradicts. Bound to `Reconciliation`
 * so a rename of the union member fails here at compile time rather than
 * silently turning these assertions into comparisons against a dead string.
 *
 * Note the fixtures below also contain this word in their PROSE; that is the
 * spec text under test and is deliberately left as literal text.
 */
const CONFIRM_ORTHOGONAL: Reconciliation = "confirm-orthogonal";

/** Verbatim from mt#3719's spec (the duplicate that was filed 2026-08-04). */
const MT3719_TITLE =
  "GET /api/sweeps transcriptCoverage test asserts null but reaches the real database on any machine with one";

const MT3719_SPEC = `## Summary

\`src/cockpit/routes/sweeps.test.ts:104\` asserts that the route's \`transcriptCoverage\` block is
null:

The parenthetical is the defect. There is no harness — the test's \`makeHarness()\` calls
\`mountSweepRoutes(app)\`, which takes no dependencies, and the route calls
\`getTranscriptCoverage()\` (\`src/cockpit/transcript-coverage.ts:35\`), which resolves persistence
entirely internally.

## Observed failure (main, 2026-08-04)

(fail) GET /api/sweeps > carries a transcriptCoverage block — output, not just liveness (mt#3441)

## Context

Duplicate check: three \`tasks_search\` passes this session. Nearest candidates:
mt#3609 (confirm-orthogonal: same class, different module), mt#3538 (confirm-orthogonal: same
class, principal.notify tests), mt#1024 (confirm-orthogonal: same class, scoped to the task
facade), mt#3501 (confirm-orthogonal: the other failure in the same gated run, genuinely
timing-dependent), mt#3237 (confirm-orthogonal: CORS/NetworkError failures, a different
mechanism). No task covers this route or this assertion.
`;

/** Verbatim from mt#3575's spec — the task mt#3719 actually duplicated. */
const MT3575_SPEC = `## Evidence there is a population, not a defect list

| Run | Failing cluster |
| --- | --- |
| baseline (1.3.14) | 5x \`startTranscriptSweepBackstop\`, \`GET /api/sweeps\`, 2x \`principal.notify\`, \`collapseToMaximalClusters\` |
| after 3 files fixed | \`GET /api/sweeps\`, \`handleOctokitError\` rate-limit |

- The load-sensitive failures in mt#3501 / mt#3494. Note \`GET /api/sweeps\` appears in both lists —
  determine which class it actually belongs to before fixing it here.
`;

describe("extractSignatureTokens", () => {
  test("R4 replay: extracts the token that links mt#3719 to mt#3575", () => {
    const tokens = extractSignatureTokens(MT3719_TITLE, MT3719_SPEC, "mt#3722");
    const texts = tokens.map((t) => t.text);

    // This is the whole incident in one assertion: `GET /api/sweeps` is present
    // in BOTH specs, and it is what the embedding path could not see.
    expect(texts).toContain("GET /api/sweeps");
    expect(MT3575_SPEC).toContain("GET /api/sweeps");

    // And it is classified by the rule that earns it the highest precedence.
    expect(tokens.find((t) => t.text === "GET /api/sweeps")?.rule).toBe("route");
  });

  test("extracts source paths, stripping the line-number suffix", () => {
    const texts = extractSignatureTokens(MT3719_TITLE, MT3719_SPEC).map((t) => t.text);
    // The spec cites `sweeps.test.ts:104`; the token must match a citation of
    // the same file at any other line.
    expect(texts).toContain("src/cockpit/routes/sweeps.test.ts");
    expect(texts).toContain("src/cockpit/transcript-coverage.ts");
    expect(texts.some((t) => t.includes(":104"))).toBe(false);
  });

  test("extracts camelCase identifiers from backticked spans", () => {
    const texts = extractSignatureTokens(MT3719_TITLE, MT3719_SPEC).map((t) => t.text);
    expect(texts).toContain("transcriptCoverage");
    expect(texts).toContain("mountSweepRoutes");
  });

  test("rejects prose-in-backticks and short spans", () => {
    const texts = extractSignatureTokens("t", "`degraded` `spec` `db` `run` `null`").map(
      (t) => t.text
    );
    expect(texts).toEqual([]);
  });

  test("rejects a single lowercase word even when long enough", () => {
    // `persistence` clears MIN_TOKEN_LENGTH but has no case change or separator,
    // so it is prose in a backtick — it collides across unrelated specs.
    expect(MIN_TOKEN_LENGTH).toBeLessThan("persistence".length);
    const texts = extractSignatureTokens("t", "`persistence`").map((t) => t.text);
    expect(texts).toEqual([]);
  });

  test("accepts snake_case and SCREAMING_CASE identifiers", () => {
    const texts = extractSignatureTokens("t", "`task_specs` `MAX_TOKENS`").map((t) => t.text);
    expect(texts).toContain("task_specs");
    expect(texts).toContain("MAX_TOKENS");
  });

  test("drops known-ubiquitous paths", () => {
    const texts = extractSignatureTokens("t", "see `CLAUDE.md` and `package.json`").map(
      (t) => t.text
    );
    expect(texts).not.toContain("CLAUDE.md");
    expect(texts).not.toContain("package.json");
  });

  test("excludes the task's own id from task-refs", () => {
    const texts = extractSignatureTokens("t", "relates to mt#3722 and mt#3673", "mt#3722").map(
      (t) => t.text
    );
    expect(texts).not.toContain("mt#3722");
    expect(texts).toContain("mt#3673");
  });

  test("orders by rule precedence so truncation drops the weakest evidence", () => {
    const tokens = extractSignatureTokens(MT3719_TITLE, MT3719_SPEC);
    const ruleOrder = ["route", "path", "identifier", "task-ref"];
    const seen = tokens.map((t) => ruleOrder.indexOf(t.rule));
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
  });

  test("caps token count", () => {
    const many = Array.from({ length: 60 }, (_, i) => `\`someIdentifier${i}\``).join(" ");
    expect(extractSignatureTokens("t", many).length).toBe(MAX_TOKENS);
  });

  test("deduplicates repeated mentions", () => {
    const texts = extractSignatureTokens("t", "`getTranscriptCoverage` ".repeat(5)).map(
      (t) => t.text
    );
    expect(texts).toEqual(["getTranscriptCoverage"]);
  });
});

describe("parseDuplicateCheckRecord", () => {
  test("R4 replay: recovers the five candidates mt#3719 named, and NOT mt#3575", () => {
    const record = parseDuplicateCheckRecord(MT3719_SPEC);

    expect([...record.keys()].sort()).toEqual([
      "mt#1024",
      "mt#3237",
      "mt#3501",
      "mt#3538",
      "mt#3609",
    ]);

    // The load-bearing assertion. mt#3575 is the task mt#3719 duplicated, and
    // it appears nowhere in the record — which is exactly why a check scoped to
    // the record's named candidates could never have caught this, and why the
    // scan must reach tasks the record does not mention.
    expect(record.has("mt#3575")).toBe(false);

    for (const id of record.keys()) {
      expect(record.get(id)).toBe(CONFIRM_ORTHOGONAL);
    }
  });

  test("returns empty when no record is present", () => {
    expect(parseDuplicateCheckRecord("## Summary\n\nNo record here.").size).toBe(0);
  });

  test("ignores task refs appearing BEFORE the record", () => {
    const spec = "Context: mt#1111 is related.\n\nDuplicate check: mt#2222 (subsume).";
    const record = parseDuplicateCheckRecord(spec);
    expect(record.has("mt#1111")).toBe(false);
    expect(record.get("mt#2222")).toBe("subsume");
  });

  test("recognizes each reconciliation verb", () => {
    const spec =
      "Duplicate check: mt#1000 subsumes this; mt#2000 is superseded; " +
      "mt#3000 confirm-orthogonal; mt#4000 mentioned with no verb.";
    const record = parseDuplicateCheckRecord(spec);
    expect(record.get("mt#1000")).toBe("subsume");
    expect(record.get("mt#2000")).toBe("supersede");
    expect(record.get("mt#3000")).toBe(CONFIRM_ORTHOGONAL);
    expect(record.get("mt#4000")).toBe("unlabeled");
  });

  test("tolerates bullet and bold decoration, matching the presence guard", () => {
    const record = parseDuplicateCheckRecord("- **Duplicate check:** mt#9999 (subsume).");
    expect(record.get("mt#9999")).toBe("subsume");
  });

  test("accepts the no-candidates line without inventing candidates", () => {
    expect(parseDuplicateCheckRecord("Duplicate check: no candidates found.").size).toBe(0);
  });
});

describe("concedesOverlap", () => {
  test("subsume and supersede concede; confirm-orthogonal and unlabeled do not", () => {
    expect(concedesOverlap("subsume")).toBe(true);
    expect(concedesOverlap("supersede")).toBe(true);
    expect(concedesOverlap(CONFIRM_ORTHOGONAL)).toBe(false);
    expect(concedesOverlap("unlabeled")).toBe(false);
    // A task the record never mentioned — the R4 shape.
    expect(concedesOverlap(undefined)).toBe(false);
  });
});
