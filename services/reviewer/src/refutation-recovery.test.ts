import { describe, test, expect } from "bun:test";
import {
  parseFindingsWithText,
  matchesFindingIdentity,
  tokenize,
  tokenOverlapRatio,
  applyRefutationRecovery,
  MIN_REASSERTION_COUNT_FOR_DOWNGRADE,
} from "./refutation-recovery";
import type { ReviewToolCall } from "./output-tools";

/** Shared across tests to avoid magic-string duplication (custom/no-magic-string-duplication). */
const GREATEST_SUMMARY = "Postgres GREATEST returns NULL when any argument is NULL";

// ---------------------------------------------------------------------------
// parseFindingsWithText
// ---------------------------------------------------------------------------

describe("parseFindingsWithText", () => {
  test("parses a single BLOCKING finding with summary and details", () => {
    const body = [
      "## Findings",
      "",
      "- [BLOCKING] src/foo.ts:42 — Something is wrong here",
      "  Full explanation of why this is a problem and how to fix it.",
    ].join("\n");
    const findings = parseFindingsWithText(body);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      file: "src/foo.ts",
      severity: "BLOCKING",
      line: 42,
      summary: "Something is wrong here",
      details: "Full explanation of why this is a problem and how to fix it.",
    });
  });

  test("parses multiple findings of mixed severity, including a line range and LEFT side", () => {
    const body = [
      "## Findings",
      "",
      "- [BLOCKING] src/foo.ts:42-50 — Range finding",
      "  Details for range finding.",
      "- [NON-BLOCKING] src/bar.ts:10 (LEFT) — Left-side finding",
      "  Details for left finding.",
      "- [PRE-EXISTING] src/baz.ts:5 — Pre-existing issue",
      "  Details for pre-existing.",
    ].join("\n");
    const findings = parseFindingsWithText(body);
    expect(findings).toHaveLength(3);
    expect(findings[0]).toMatchObject({ file: "src/foo.ts", line: 42, lineEnd: 50 });
    expect(findings[1]).toMatchObject({ file: "src/bar.ts", line: 10, severity: "NON-BLOCKING" });
    expect(findings[2]).toMatchObject({ file: "src/baz.ts", line: 5, severity: "PRE-EXISTING" });
  });

  test("returns an empty array for an empty or non-matching body", () => {
    expect(parseFindingsWithText("")).toEqual([]);
    expect(parseFindingsWithText("Looks good, no issues found.")).toEqual([]);
  });

  test("tolerates a finding with no following details line", () => {
    const body = "- [BLOCKING] src/foo.ts:1 — Trailing finding with no details";
    const findings = parseFindingsWithText(body);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.details).toBe("");
  });
});

// ---------------------------------------------------------------------------
// tokenize / tokenOverlapRatio
// ---------------------------------------------------------------------------

describe("tokenize / tokenOverlapRatio", () => {
  test("filters stopwords and short tokens", () => {
    const tokens = tokenize("The GREATEST function returns NULL when a value is NULL");
    expect(tokens.has("the")).toBe(false);
    expect(tokens.has("is")).toBe(false);
    expect(tokens.has("greatest")).toBe(true);
    expect(tokens.has("null")).toBe(true);
  });

  test("identical text has overlap ratio 1", () => {
    const a = tokenize(GREATEST_SUMMARY);
    const b = tokenize(GREATEST_SUMMARY);
    expect(tokenOverlapRatio(a, b)).toBe(1);
  });

  test("unrelated text has overlap ratio 0", () => {
    const a = tokenize(GREATEST_SUMMARY);
    const b = tokenize("Bump the eslint dependency to the latest release");
    expect(tokenOverlapRatio(a, b)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// matchesFindingIdentity
// ---------------------------------------------------------------------------

describe("matchesFindingIdentity", () => {
  const base = { file: "src/foo.ts", line: 100, summary: "Postgres GREATEST returns NULL" };

  test("matches identical file, line, and summary", () => {
    expect(matchesFindingIdentity(base, { ...base })).toBe(true);
  });

  test("matches when line is within LINE_PROXIMITY", () => {
    expect(matchesFindingIdentity(base, { ...base, line: 103 })).toBe(true);
  });

  test("does not match when line is beyond LINE_PROXIMITY", () => {
    expect(matchesFindingIdentity(base, { ...base, line: 200 })).toBe(false);
  });

  test("does not match a different file", () => {
    expect(matchesFindingIdentity(base, { ...base, file: "src/bar.ts" })).toBe(false);
  });

  test("does not match a dissimilar summary", () => {
    expect(
      matchesFindingIdentity(base, { ...base, summary: "Missing null check on user input" })
    ).toBe(false);
  });

  test("matches a paraphrased but substantively similar summary", () => {
    expect(
      matchesFindingIdentity(base, {
        ...base,
        summary: "GREATEST returns NULL in Postgres when an argument is NULL",
      })
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// applyRefutationRecovery — calibration case (mt#2789 / PR #1942, GREATEST)
// ---------------------------------------------------------------------------

const GREATEST_FILE = "packages/domain/src/tasks/task-queries.ts";
const GREATEST_LINE = 118;

function greatestFindingBody(details: string): string {
  return [
    "## Findings",
    "",
    `- [BLOCKING] ${GREATEST_FILE}:${GREATEST_LINE} — ${GREATEST_SUMMARY}`,
    `  ${details}`,
  ].join("\n");
}

const R1_BODY = greatestFindingBody(
  "GREATEST(a, b) will return NULL if either argument is NULL per MySQL semantics, " +
    "silently breaking the fallback ordering for rows with a NULL priority."
);

const R2_BODY = greatestFindingBody(
  "Despite the added regression tests, the underlying claim about GREATEST returning " +
    "NULL on a NULL argument still means this ordering fallback is unsafe."
);

const REFUTING_COMMIT_MESSAGE =
  "fix(mt#2789): add PG17 psql transcript proving GREATEST ignores NULL arguments\n\n" +
  "Ran a query against a live Postgres 17 instance — the result was the non-null " +
  "argument, not NULL. Postgres GREATEST and LEAST skip NULL arguments entirely per " +
  "the Postgres manual; this is not MySQL semantics. Added the empirical transcript " +
  "as a code comment at the SQL call site.";

function greatestToolCall(details: string): ReviewToolCall {
  return {
    name: "submit_finding",
    args: {
      severity: "BLOCKING",
      file: GREATEST_FILE,
      line: GREATEST_LINE,
      summary: GREATEST_SUMMARY,
      details,
    },
  };
}

describe("applyRefutationRecovery — calibration case (mt#2789 / PR #1942)", () => {
  test("R3 verbatim re-assertion with an unaddressed refutation downgrades to NON-BLOCKING with a disputed marker", () => {
    const r3ToolCalls: ReviewToolCall[] = [
      greatestToolCall(
        "GREATEST(a, b) will return NULL if either argument is NULL, which breaks the " +
          "fallback ordering for rows with a NULL priority. This must be fixed before merge."
      ),
    ];

    const result = applyRefutationRecovery(
      r3ToolCalls,
      [R1_BODY, R2_BODY],
      [REFUTING_COMMIT_MESSAGE]
    );

    expect(result.downgrades).toHaveLength(1);
    const downgrade = result.downgrades[0];
    expect(downgrade?.reassertionCount).toBe(2);
    expect(downgrade?.totalRounds).toBe(3);
    expect(downgrade?.fromSeverity).toBe("BLOCKING");
    expect(downgrade?.toSeverity).toBe("NON-BLOCKING");

    const corrected = result.toolCalls[0];
    expect(corrected?.name).toBe("submit_finding");
    if (corrected?.name === "submit_finding") {
      expect(corrected.args.severity).toBe("NON-BLOCKING");
      expect(corrected.args.summary).toContain("disputed — refutation unaddressed after 3 rounds");
    }
  });

  test("regression: a genuinely-unaddressed BLOCKING finding still blocks (no commit ever responded)", () => {
    const r3ToolCalls: ReviewToolCall[] = [
      greatestToolCall(
        "GREATEST(a, b) will return NULL if either argument is NULL, which breaks the " +
          "fallback ordering for rows with a NULL priority."
      ),
    ];

    // No commits since the last review addressed this finding's topic at all.
    const unrelatedCommits = [
      "chore: bump eslint to the latest release",
      "docs: fix a typo in README",
    ];

    const result = applyRefutationRecovery(r3ToolCalls, [R1_BODY, R2_BODY], unrelatedCommits);

    expect(result.downgrades).toHaveLength(0);
    const corrected = result.toolCalls[0];
    expect(corrected?.name).toBe("submit_finding");
    if (corrected?.name === "submit_finding") {
      expect(corrected.args.severity).toBe("BLOCKING");
    }
  });

  test("no commits at all (empty array) never downgrades, even with 2+ prior re-assertions", () => {
    const r3ToolCalls: ReviewToolCall[] = [greatestToolCall("Still broken.")];
    const result = applyRefutationRecovery(r3ToolCalls, [R1_BODY, R2_BODY], []);
    expect(result.downgrades).toHaveLength(0);
  });

  test("only one prior re-assertion (R1 only) does not downgrade regardless of refutation", () => {
    const r2ToolCalls: ReviewToolCall[] = [
      greatestToolCall("Still broken, GREATEST returns NULL on a NULL argument."),
    ];
    const result = applyRefutationRecovery(r2ToolCalls, [R1_BODY], [REFUTING_COMMIT_MESSAGE]);
    expect(result.downgrades).toHaveLength(0);
    expect(MIN_REASSERTION_COUNT_FOR_DOWNGRADE).toBe(2);
  });

  test("engagement with the refutation's distinctive evidence keeps the finding BLOCKING", () => {
    const r3ToolCalls: ReviewToolCall[] = [
      greatestToolCall(
        "Even accounting for the PG17 psql transcript, this still fails for the composite " +
          "ordering case where a secondary column is also NULL — GREATEST's NULL-skipping " +
          "behavior doesn't cover that path."
      ),
    ];

    const result = applyRefutationRecovery(
      r3ToolCalls,
      [R1_BODY, R2_BODY],
      [REFUTING_COMMIT_MESSAGE]
    );

    expect(result.downgrades).toHaveLength(0);
    const corrected = result.toolCalls[0];
    if (corrected?.name === "submit_finding") {
      expect(corrected.args.severity).toBe("BLOCKING");
    }
  });

  test("non-finding and non-BLOCKING tool calls pass through unchanged", () => {
    const toolCalls: ReviewToolCall[] = [
      {
        name: "submit_finding",
        args: {
          severity: "NON-BLOCKING",
          file: GREATEST_FILE,
          line: GREATEST_LINE,
          summary: GREATEST_SUMMARY,
          details: "nit",
        },
      },
      { name: "conclude_review", args: { event: "COMMENT", summary: "ok" } },
    ];
    const result = applyRefutationRecovery(
      toolCalls,
      [R1_BODY, R2_BODY],
      [REFUTING_COMMIT_MESSAGE]
    );
    expect(result.downgrades).toHaveLength(0);
    expect(result.toolCalls).toEqual(toolCalls);
  });

  test("a finding at a genuinely different location is not treated as a re-assertion", () => {
    const toolCalls: ReviewToolCall[] = [
      {
        name: "submit_finding",
        args: {
          severity: "BLOCKING",
          file: "src/unrelated.ts",
          line: 5,
          summary: "Missing null check on user input",
          details: "Could throw at runtime.",
        },
      },
    ];
    const result = applyRefutationRecovery(
      toolCalls,
      [R1_BODY, R2_BODY],
      [REFUTING_COMMIT_MESSAGE]
    );
    expect(result.downgrades).toHaveLength(0);
    const corrected = result.toolCalls[0];
    if (corrected?.name === "submit_finding") {
      expect(corrected.args.severity).toBe("BLOCKING");
    }
  });
});
